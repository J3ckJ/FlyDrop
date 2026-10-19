export class Session {
  constructor(socket) {
    this.socket = socket;
    this.waiters = [];
    this.events = new Set();
    this.frames = new Set();
  }
  onEvent(fn) { this.events.add(fn); }
  onFrame(fn) { this.frames.add(fn); }
  incoming(data) {
    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      if (bytes[0] !== 1 || bytes.length < 5) return;
      const length = (bytes[1] << 8) | bytes[2];
      const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(3, 3 + length)));
      const jpeg = bytes.subarray(3 + length);
      for (const fn of this.frames) fn(meta, jpeg);
      return;
    }
    const message = JSON.parse(data);
    if (!message.id) {
      for (const fn of this.events) fn(message);
      return;
    }
    const waiter = this.waiters.find(item => item.id === message.id);
    if (!waiter) return;
    this.waiters = this.waiters.filter(item => item !== waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }
  request(type, payload = {}, timeout = 8000) {
    const id = crypto.randomUUID();
    this.socket.send(JSON.stringify({ v: 1, id, type, payload }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item.id !== id);
        reject(new Error('Нет ответа компьютера'));
      }, timeout);
      this.waiters.push({ id, resolve, timer });
    });
  }
  close() { this.socket.close(); }
}

export function connect() {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pult`);
  socket.binaryType = 'arraybuffer';
  const session = new Session(socket);
  socket.addEventListener('message', event => session.incoming(event.data));
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(session), { once: true });
    socket.addEventListener('error', () => reject(new Error('Нет связи с компьютером')), { once: true });
  });
}

export async function remember(token) {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось запомнить телефон');
}

export function upload(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded, event.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || 'Файл не отправлен'));
    };
    xhr.onerror = () => reject(new Error('Нет связи во время передачи'));
    xhr.send(file);
  });
}
