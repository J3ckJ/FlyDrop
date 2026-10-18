import crypto from 'node:crypto';
import tls from 'node:tls';

function headerFor(opcode, length) {
  if (length < 126) return Buffer.from([0x80 | opcode, 0x80 | length]);
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(length, 6);
  return header;
}

export function connectPult(agent, { localAddress = '127.0.0.2' } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = tls.connect({
      host: '127.0.0.1',
      port: agent.port,
      ca: agent.ca,
      servername: 'localhost',
      localAddress,
    }, () => {
      socket.write([
        'GET /pult HTTP/1.1',
        `Host: localhost:${agent.port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
    let buffer = Buffer.alloc(0);
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const split = buffer.indexOf('\r\n\r\n');
      if (split < 0) return;
      const head = buffer.subarray(0, split).toString('utf8');
      if (!head.includes('101')) { reject(new Error(head)); socket.end(); return; }
      socket.off('data', onData);
      resolve(new Client(socket, buffer.subarray(split + 4)));
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

class Client {
  constructor(socket, buffer) {
    this.socket = socket;
    this.buffer = buffer;
    this.queue = [];
    this.waiters = [];
    socket.on('data', chunk => this.push(chunk));
    socket.on('error', () => {});
    if (buffer.length) this.push(Buffer.alloc(0));
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = this.buffer.readUInt32BE(6);
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x1) this.deliver({ kind: 'text', value: JSON.parse(payload.toString('utf8')) });
      else if (opcode === 0x2) this.deliver({ kind: 'binary', value: Buffer.from(payload) });
      else if (opcode === 0x8) this.socket.end();
    }
  }
  deliver(message) {
    const waiter = this.waiters.find(item => item.match(message));
    if (waiter) {
      this.waiters = this.waiters.filter(item => item !== waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.queue.push(message);
  }
  waitFor(match, timeout = 5000) {
    const queued = this.queue.find(match);
    if (queued) {
      this.queue = this.queue.filter(item => item !== queued);
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item.resolve !== resolve);
        reject(new Error('Нет ответа агента'));
      }, timeout);
      this.waiters.push({ match, resolve, timer });
    });
  }
  frame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([headerFor(opcode, payload.length), mask, masked]));
  }
  request(type, payload = {}) {
    const id = crypto.randomUUID();
    this.frame(0x1, Buffer.from(JSON.stringify({ v: 1, id, type, payload })));
    return this.waitFor(message => message.kind === 'text' && message.value.id === id).then(message => message.value);
  }
  close() { this.socket.end(); }
}
