import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isSpawnFailure, safeExecFile } from './spawn.js';

const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-helper.ps1');
const POWERSHELL_REASON = 'Антивирус или политика запретили запуск PowerShell. Экран, мышь, клавиатура, громкость и буфер недоступны. Питание и список программ работают без PowerShell.';

function unsupported(method) {
  return async () => { throw Object.assign(new Error(`Windows-помощник не выполняет ${method} на этой системе`), { code: 'platform' }); };
}

function blockedError() {
  return Object.assign(new Error(POWERSHELL_REASON), { code: 'blocked', unavailable: true });
}

function deniedStatus() {
  return {
    unavailable: true,
    reason: POWERSHELL_REASON,
    battery: null,
    volume: null,
    muted: false,
    asleep: false,
    locked: false,
    media: null,
    appsRunning: [],
  };
}

function stubPlatform() {
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

function writeInput(spawnImpl, file, args, input) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawnImpl(file, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (error) {
      finish({ code: error.code || 1, stdout: '', stderr: String(error.message || error), blocked: isSpawnFailure(error) });
      return;
    }
    const err = [];
    child.stderr?.on?.('data', chunk => err.push(Buffer.from(chunk)));
    child.stdin?.on?.('error', () => {});
    child.on?.('error', error => finish({ code: error.code || 1, stdout: '', stderr: String(error.message || error), blocked: isSpawnFailure(error) }));
    child.on?.('close', code => finish({ code: code ?? 1, stdout: '', stderr: Buffer.concat(err).toString('utf8'), blocked: false }));
    try { child.stdin.end(Buffer.from(String(input), 'utf8')); }
    catch (error) { finish({ code: error.code || 1, stdout: '', stderr: String(error.message || error), blocked: isSpawnFailure(error) }); }
  });
}

function defaultExec(file, args, input) {
  if (input === undefined) return safeExecFile(file, args, { timeout: 15000 });
  return writeInput(spawn, file, args, input);
}

async function walkLinks(root, depth, out) {
  if (!root || depth > 4 || out.length >= 80) return;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (out.length >= 80) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await walkLinks(full, depth + 1, out);
    else if (entry.isFile() && /\.lnk$/i.test(entry.name)) out.push({ id: full, name: entry.name.replace(/\.lnk$/i, ''), running: false });
  }
}

export function createWindowsPlatform({ spawnImpl = spawn, exec = defaultExec, force = false } = {}) {
  if (process.platform !== 'win32' && !force) return stubPlatform();
  let child;
  let lines;
  let seq = 0;
  let blocked = false;
  const pending = new Map();
  const failAll = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    lines?.close();
    lines = undefined;
    child = undefined;
  };
  const start = () => {
    if (blocked) throw blockedError();
    let spawned;
    try {
      spawned = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      if (isSpawnFailure(error)) {
        blocked = true;
        throw blockedError();
      }
      throw error;
    }
    if (!spawned || typeof spawned.on !== 'function') {
      blocked = true;
      throw blockedError();
    }
    child = spawned;
    child.stdin?.on?.('error', () => {});
    child.on('error', error => {
      if (isSpawnFailure(error)) blocked = true;
      failAll(blocked ? blockedError() : error);
    });
    child.on('exit', code => {
      if (blocked || code == null) blocked = true;
      failAll(Object.assign(new Error(blocked ? POWERSHELL_REASON : 'Помощник Windows остановился'), { code: blocked ? 'blocked' : 'windows', unavailable: blocked }));
    });
    if (!child.stdout || typeof child.stdout.on !== 'function') {
      blocked = true;
      throw blockedError();
    }
    lines = createInterface({ input: child.stdout });
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
  };
  const call = (op, extra = {}, timeout = 8000) => new Promise((resolve, reject) => {
    try {
      if (blocked) throw blockedError();
      if (!child || child.killed) start();
    } catch (error) {
      reject(error.unavailable ? error : Object.assign(error, { unavailable: isSpawnFailure(error) }));
      return;
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('Windows не ответил'), { code: 'timeout' }));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(`${JSON.stringify({ id, op, ...extra })}\n`);
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      if (isSpawnFailure(error)) blocked = true;
      reject(blocked ? blockedError() : error);
    }
  });
  const runCommand = async (file, args, input) => {
    try {
      const result = await exec(file, args, input);
      if (result?.blocked) throw Object.assign(new Error(result.stderr || 'Запуск команды запрещён'), { code: result.code || 'EPERM', unavailable: true });
      return result || { code: 1, stdout: '', stderr: '' };
    } catch (error) {
      if (error.unavailable || isSpawnFailure(error)) throw Object.assign(error, { unavailable: true });
      throw error;
    }
  };
  const helperStatus = async () => {
    const volume = await call('volume', {});
    const media = await call('media-state', {});
    const title = media.title && media.title !== 'Spotify' ? media.title : '';
    const split = title.split(' - ');
    return {
      unavailable: false,
      battery: null,
      volume: volume.level ?? 0,
      muted: Boolean(volume.muted),
      asleep: false,
      locked: false,
      media: title ? { title: split.length > 1 ? split.slice(1).join(' - ') : title, artist: split.length > 1 ? split[0] : '', app: media.app || 'Windows', playing: true, position: 0, duration: 0 } : null,
      appsRunning: [],
    };
  };
  return {
    kind: 'windows',
    available: true,
    async getStatus() {
      try { return await helperStatus(); }
      catch (error) {
        if (error.unavailable || blocked) return deniedStatus();
        throw error;
      }
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
      const out = [];
      const programData = process.env.PROGRAMDATA || '';
      const appData = process.env.APPDATA || '';
      if (programData) await walkLinks(path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), 0, out);
      if (appData) await walkLinks(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), 0, out);
      return out.slice(0, 80);
    },
    async launchApp(id) {
      const result = await runCommand('cmd.exe', ['/c', 'start', '', id]);
      if (result.code !== 0) throw Object.assign(new Error(result.stderr || 'Не удалось открыть программу'), { code: 'windows' });
      return { id, name: path.basename(String(id)).replace(/\.lnk$/i, ''), running: true };
    },
    async getClipboard() { return (await call('clipboard-get')).text || ''; },
    async setClipboard(text) {
      const clip = await runCommand('clip.exe', [], text);
      if (clip.code === 0) return;
      await call('clipboard-set', { text });
    },
    async pollNotifications() { return []; },
    async power(action) {
      const table = {
        sleep: ['rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']],
        lock: ['rundll32.exe', ['user32.dll,LockWorkStation']],
        restart: ['shutdown.exe', ['/r', '/t', '0']],
        shutdown: ['shutdown.exe', ['/s', '/t', '0']],
      };
      const spec = table[action];
      if (!spec) throw new Error('Неизвестное действие питания');
      const result = await runCommand(spec[0], spec[1]);
      if (result.code !== 0) throw Object.assign(new Error(result.stderr || 'Команда питания не выполнилась'), { code: 'windows' });
    },
    close() { if (child) child.kill(); lines?.close(); },
  };
}
