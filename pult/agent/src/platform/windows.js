import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-helper.ps1');

function unsupported(method) {
  return async () => { throw Object.assign(new Error(`Windows-помощник не выполняет ${method} на этой системе`), { code: 'platform' }); };
}

export function createWindowsPlatform() {
  if (process.platform !== 'win32') {
    return {
      kind: 'windows',
      available: false,
      getStatus: unsupported('статус'),
      captureFrame: unsupported('экран'),
      move: unsupported('мышь'),
      click: unsupported('щелчок'),
      scroll: unsupported('прокрутку'),
      key: unsupported('клавишу'),
      typeText: unsupported('текст'),
      setVolume: unsupported('громкость'),
      setMuted: unsupported('звук'),
      media: unsupported('плеер'),
      listApps: unsupported('приложения'),
      launchApp: unsupported('запуск'),
      getClipboard: unsupported('буфер'),
      setClipboard: unsupported('буфер'),
      pollNotifications: async () => [],
      power: unsupported('питание'),
    };
  }
  let child;
  let seq = 0;
  const pending = new Map();
  const start = () => {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message);
      else waiter.reject(Object.assign(new Error(message.error || 'Ошибка Windows'), { code: 'windows' }));
    });
    child.on('exit', () => {
      for (const waiter of pending.values()) waiter.reject(Object.assign(new Error('Помощник Windows остановился'), { code: 'windows' }));
      pending.clear();
      child = undefined;
    });
  };
  const call = (op, extra = {}, timeout = 8000) => new Promise((resolve, reject) => {
    if (!child || child.killed) start();
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('Windows не ответил'), { code: 'timeout' }));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, op, ...extra })}\n`);
  });
  return {
    kind: 'windows',
    available: true,
    async getStatus() {
      const volume = await call('volume', {});
      const media = await call('media-state', {});
      const title = media.title && media.title !== 'Spotify' ? media.title : '';
      const split = title.split(' - ');
      return {
        battery: null,
        volume: volume.level ?? 0,
        muted: Boolean(volume.muted),
        asleep: false,
        locked: false,
        media: title ? { title: split.length > 1 ? split.slice(1).join(' - ') : title, artist: split.length > 1 ? split[0] : '', app: media.app || 'Windows', playing: true, position: 0, duration: 0 } : null,
        appsRunning: [],
      };
    },
    async captureFrame() {
      const frame = await call('capture', {}, 12000);
      return { jpeg: Buffer.from(frame.jpeg, 'base64'), width: frame.width, height: frame.height, seq: 0 };
    },
    async move(dx, dy) { await call('move', { dx: Math.round(dx), dy: Math.round(dy) }); },
    async click(button, count) { await call('click', { button, count }); },
    async scroll(dx, dy) { await call('scroll', { dx: Math.round(dx), dy: Math.sign(dy) || 0 }); },
    async key(key, down) { await call('key', { key, down }); },
    async typeText(text) { await call('text', { text }); },
    async setVolume(level) { await call('volume', { level }); },
    async setMuted(muted) { await call('volume', { muted }); },
    async media(action) { await call('media', { action }); },
    async listApps() {
      const result = await call('apps', {}, 15000);
      return result.apps || [];
    },
    async launchApp(id) { await call('launch', { id }); return { id, name: id, running: true }; },
    async getClipboard() { return (await call('clipboard-get')).text || ''; },
    async setClipboard(text) { await call('clipboard-set', { text }); },
    async pollNotifications() { return (await call('notifications')).items || []; },
    async power(action) { await call('power', { action }); },
    close() { if (child) child.kill(); },
  };
}
