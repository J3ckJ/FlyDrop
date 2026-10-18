import { createHash } from 'node:crypto';
import { LIMITS, WS_PATH } from './protocol.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key) {
  return createHash('sha1').update(String(key) + GUID).digest('base64');
}

function reject(socket, status) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class Socket {
  constructor(raw) {
    this.raw = raw;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    this.fragments = [];
    this.fragmentOp = 0;
    this.listeners = { text: new Set(), binary: new Set(), close: new Set() };
    raw.on('data', chunk => this.push(chunk));
    raw.on('close', () => this.finish());
    raw.on('error', () => this.finish());
  }
  on(event, fn) { this.listeners[event].add(fn); return this; }
  send(text) { this.frame(0x1, Buffer.from(text)); }
  sendBinary(buffer) { this.frame(0x2, buffer); }
  close(code = 1000, reason = '') {
    if (!this.alive) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.frame(0x8, body);
    this.raw.end();
    this.finish();
  }
  frame(opcode, payload) {
    if (!this.alive) return;
    const length = payload.length;
    let header;
    if (length < 126) header = Buffer.from([0x80 | opcode, length]);
    else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }
    this.raw.write(Buffer.concat([header, payload]));
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.alive) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const fin = (first & 0x80) !== 0;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        length = this.buffer.readUInt32BE(6);
        offset = 10;
        if (high !== 0 || length > LIMITS.maxFrameBytes) { this.close(1009, 'Слишком большой кадр'); return; }
      }
      if (length > LIMITS.maxFrameBytes) { this.close(1009, 'Слишком большой кадр'); return; }
      const maskLength = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLength + length) return;
      let payload = this.buffer.subarray(offset + maskLength, offset + maskLength + length);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      } else if (opcode !== 0x8) {
        this.close(1002, 'Клиент должен маскировать кадры');
        return;
      }
      this.buffer = this.buffer.subarray(offset + maskLength + length);
      this.dispatch(opcode, fin, payload);
    }
  }
  dispatch(opcode, fin, payload) {
    if (opcode === 0x8) { this.finish(); this.raw.end(); return; }
    if (opcode === 0x9) { this.frame(0xA, payload); return; }
    if (opcode === 0xA) return;
    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (fin) this.emitFragment();
      return;
    }
    if (opcode !== 0x1 && opcode !== 0x2) { this.close(1002, 'Неизвестный кадр'); return; }
    if (!fin) {
      this.fragmentOp = opcode;
      this.fragments = [payload];
      return;
    }
    this.emit(opcode === 0x1 ? 'text' : 'binary', payload);
  }
  emitFragment() {
    const payload = Buffer.concat(this.fragments);
    const opcode = this.fragmentOp;
    this.fragments = [];
    this.fragmentOp = 0;
    if (payload.length > LIMITS.maxFrameBytes) { this.close(1009, 'Слишком большой кадр'); return; }
    this.emit(opcode === 0x1 ? 'text' : 'binary', payload);
  }
  emit(event, payload) {
    const text = event === 'text' ? payload.toString('utf8') : payload;
    for (const listener of this.listeners[event]) listener(text);
  }
  finish() {
    if (!this.alive) return;
    this.alive = false;
    for (const listener of this.listeners.close) listener();
  }
}

export function attachWebSocket(server, onSocket) {
  server.on('upgrade', (request, socket) => {
    let path = '/';
    try { path = new URL(request.url, 'https://localhost').pathname; } catch { reject(socket, 400); return; }
    if (path !== WS_PATH) { reject(socket, 404); return; }
    const key = request.headers['sec-websocket-key'];
    if (!key || request.headers['upgrade']?.toLowerCase() !== 'websocket' || request.headers['sec-websocket-version'] !== '13') {
      reject(socket, 400);
      return;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n'));
    onSocket(new Socket(socket), request.socket.remoteAddress || '');
  });
}
