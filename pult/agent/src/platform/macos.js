import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from './spawn.js';

const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'macos-helper.py');

function unsupported() {
  const fail = async () => { throw Object.assign(new Error('Команды macOS выполняются только на Mac'), { code: 'platform' }); };
  return {
    kind: 'macos', available: false,
    getStatus: fail, captureFrame: fail, move: fail, click: fail, scroll: fail, key: fail, typeText: fail,
    setVolume: fail, setMuted: fail, media: fail, listApps: fail, launchApp: fail, getClipboard: fail,
    setClipboard: fail, pollNotifications: async () => [], power: fail,
  };
}

export function createMacosPlatform() {
  if (process.platform !== 'darwin') return unsupported();
  let child;
  let seq = 0;
  const pending = new Map();
  const failAll = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    child = undefined;
  };
  const start = () => {
    try {
      child = spawn('/usr/bin/python3', [helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      child = undefined;
      throw Object.assign(error, { unavailable: error.code === 'EPERM' || error.code === 'EACCES' });
    }
    child.stdin.on('error', () => {});
    child.on('error', error => {
      failAll(Object.assign(new Error('Помощник macOS не запустился'), { code: error.code || 'spawn', unavailable: error.code === 'EPERM' || error.code === 'EACCES' }));
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message);
      else waiter.reject(new Error(message.error || 'Ошибка macOS'));
    });
    child.on('exit', () => {
      lines.close();
      failAll(Object.assign(new Error('Помощник macOS остановился'), { code: 'exit' }));
    });
  };
  const call = (op, extra = {}) => new Promise((resolve, reject) => {
    try { if (!child || child.killed) start(); }
    catch (error) { reject(error); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('macOS не ответил')); }, 5000);
    pending.set(id, { resolve, reject, timer });
    try { child.stdin.write(`${JSON.stringify({ id, op, ...extra })}\n`); }
    catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
  const sh = async (command, args) => (await run(command, args)).stdout.toString('utf8').trim();
  return {
    kind: 'macos',
    available: true,
    async getStatus() {
      try {
        const volume = Number(await sh('osascript', ['-e', 'output volume of (get volume settings)'])) || 0;
        const muted = (await sh('osascript', ['-e', 'output muted of (get volume settings)'])) === 'true';
        let media = null;
        try {
          const title = await sh('osascript', ['-e', 'tell application "Spotify" to name of current track']);
          const artist = await sh('osascript', ['-e', 'tell application "Spotify" to artist of current track']);
          const playing = (await sh('osascript', ['-e', 'tell application "Spotify" to player state as string'])) === 'playing';
          media = { title, artist, app: 'Spotify', playing, position: 0, duration: 0 };
        } catch (error) {
          if (error.unavailable || error.code === 'EPERM' || error.code === 'EACCES') throw error;
          media = null;
        }
        return { battery: null, volume, muted, asleep: false, locked: false, media, appsRunning: [] };
      } catch (error) {
        if (!error.unavailable && error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
        return {
          unavailable: true,
          reason: 'Команды macOS не запустились. Экран и управление недоступны, агент продолжает работу.',
          battery: null,
          volume: null,
          muted: false,
          asleep: false,
          locked: false,
          media: null,
          appsRunning: [],
        };
      }
    },
    async captureFrame() {
      const file = `/tmp/pult-frame-${process.pid}.jpg`;
      await run('/usr/sbin/screencapture', ['-x', '-t', 'jpg', file], { timeout: 8000 });
      const jpeg = await readFile(file);
      await rm(file, { force: true });
      return { jpeg, width: 0, height: 0, seq: 0 };
    },
    async move(dx, dy) { await call('move', { dx, dy }); },
    async click(button, count) { await call('click', { button, count }); },
    async scroll(dx, dy) { await call('scroll', { dx, dy }); },
    async key(key, down) {
      try { await call('key', { key, down }); }
      catch { if (down && key.length === 1) await sh('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(key)}`]); }
    },
    async typeText(text) {
      await sh('osascript', ['-e', `tell application "System Events" to keystroke ${JSON.stringify(text)}`]);
    },
    async setVolume(level) { await sh('osascript', ['-e', `set volume output volume ${level}`]); },
    async setMuted(muted) { await sh('osascript', ['-e', `set volume ${muted ? 'with' : 'without'} output muted`]); },
    async media(action) {
      const map = { toggle: 'playpause', play: 'play', pause: 'pause', next: 'next track', previous: 'previous track' };
      await sh('osascript', ['-e', `tell application "Spotify" to ${map[action] || 'playpause'}`]);
    },
    async listApps() {
      const listing = await sh('/bin/ls', ['/Applications']);
      const running = new Set((await sh('osascript', ['-e', 'tell application "System Events" to get name of every process whose background only is false'])).split(', '));
      return listing.split('\n').filter(name => name.endsWith('.app')).slice(0, 80).map(file => {
        const name = file.replace(/\.app$/, '');
        return { id: name, name, running: running.has(name) };
      });
    },
    async launchApp(id) { await run('/usr/bin/open', ['-a', id]); return { id, name: id, running: true }; },
    async getClipboard() { return sh('/usr/bin/pbpaste', []); },
    async setClipboard(text) { await run('/usr/bin/pbcopy', [], { input: text }); },
    async pollNotifications() { return []; },
    async power(action) {
      if (action === 'sleep') await run('/usr/bin/pmset', ['sleepnow']);
      else if (action === 'lock') await run('/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend']);
      else if (action === 'restart') await sh('osascript', ['-e', 'tell application "System Events" to restart']);
      else if (action === 'shutdown') await sh('osascript', ['-e', 'tell application "System Events" to shut down']);
      else throw new Error('Неизвестное действие питания');
    },
    close() { if (child) child.kill(); },
  };
}
