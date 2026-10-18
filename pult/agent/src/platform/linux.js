import { readFile, rm } from 'node:fs/promises';
import { commandExists, run } from './spawn.js';

async function optional(command, args, fallback = '') {
  try { return (await run(command, args)).stdout.toString('utf8').trim(); }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.unavailable) throw Object.assign(error, { unavailable: true });
    return fallback;
  }
}

export function createLinuxPlatform() {
  return {
    kind: 'linux',
    available: process.platform === 'linux',
    async getStatus() {
      try {
        const volumeText = await optional('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
        const match = volumeText.match(/(\d+)%/);
        const mute = await optional('pactl', ['get-sink-mute', '@DEFAULT_SINK@']);
        return {
          battery: null,
          volume: match ? Number(match[1]) : 0,
          muted: mute.includes('yes'),
          asleep: false,
          locked: false,
          media: null,
          appsRunning: [],
        };
      } catch (error) {
        if (!error.unavailable && error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
        return {
          unavailable: true,
          reason: 'Запуск команды запрещён политикой. Громкость на этом компьютере недоступна, агент продолжает работу.',
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
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw Object.assign(new Error('Нет графического сеанса'), { code: 'display' });
      if (await commandExists('ffmpeg') && process.env.DISPLAY) {
        const file = `/tmp/pult-frame-${process.pid}.jpg`;
        await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1280x720', '-i', process.env.DISPLAY, '-frames:v', '1', file], { timeout: 8000 });
        const jpeg = await readFile(file);
        await rm(file, { force: true });
        return { jpeg, width: 1280, height: 720, seq: 0 };
      }
      throw Object.assign(new Error('Для снимка экрана нужен ffmpeg и DISPLAY'), { code: 'display' });
    },
    async move(dx, dy) { await run('xdotool', ['mousemove_relative', '--', String(Math.round(dx)), String(Math.round(dy))]); },
    async click(button) {
      const map = { left: '1', right: '3', middle: '2' };
      await run('xdotool', ['click', map[button] || '1']);
    },
    async scroll(_dx, dy) { await run('xdotool', ['click', dy > 0 ? '4' : '5']); },
    async key(key, down) { if (down) await run('xdotool', ['key', key]); },
    async typeText(text) { await run('xdotool', ['type', '--', text]); },
    async setVolume(level) { await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${level}%`]); },
    async setMuted(muted) { await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0']); },
    async media(action) {
      const map = { toggle: 'play-pause', play: 'play', pause: 'pause', next: 'next', previous: 'previous' };
      await run('playerctl', [map[action] || 'play-pause']);
    },
    async listApps() {
      const listing = await optional('bash', ['-lc', 'ls /usr/share/applications/*.desktop 2>/dev/null']);
      return listing.split('\n').filter(Boolean).slice(0, 80).map(file => {
        const name = file.split('/').pop().replace(/\.desktop$/, '');
        return { id: file, name, running: false };
      });
    },
    async launchApp(id) { await run('gtk-launch', [id.split('/').pop().replace(/\.desktop$/, '')]); return { id, name: id, running: true }; },
    async getClipboard() {
      if (await commandExists('wl-paste')) return optional('wl-paste', ['--no-newline']);
      return optional('xclip', ['-selection', 'clipboard', '-o']);
    },
    async setClipboard(text) {
      if (await commandExists('wl-copy')) { await run('wl-copy', [], { input: text }); return; }
      await run('xclip', ['-selection', 'clipboard'], { input: text });
    },
    async pollNotifications() { return []; },
    async power(action) {
      if (action === 'sleep') await run('systemctl', ['suspend']);
      else if (action === 'lock') await run('loginctl', ['lock-session']);
      else if (action === 'restart') await run('systemctl', ['reboot']);
      else if (action === 'shutdown') await run('systemctl', ['poweroff']);
      else throw new Error('Неизвестное действие питания');
    },
  };
}
