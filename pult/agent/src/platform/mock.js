import { encodeJPEG } from '../jpeg.js';

export function createMockPlatform(seed = {}) {
  const state = {
    width: 160,
    height: 90,
    cursorX: 80,
    cursorY: 45,
    volume: seed.volume ?? 40,
    muted: false,
    asleep: seed.asleep ?? false,
    locked: false,
    clipboard: seed.clipboard ?? '',
    playing: true,
    media: seed.media ?? { title: 'Teardrop', artist: 'Massive Attack', app: 'Spotify', position: 134, duration: 330 },
    apps: seed.apps ?? [
      { id: 'Spotify', name: 'Spotify', running: true },
      { id: 'Safari', name: 'Safari', running: false },
      { id: 'Terminal', name: 'Терминал', running: false },
      { id: 'Xcode', name: 'Xcode', running: false },
    ],
    notifications: [...(seed.notifications ?? [])],
    calls: [],
    battery: seed.battery ?? 82,
    seq: 0,
  };
  const note = item => { state.notifications.unshift({ id: `n${state.notifications.length + 1}`, at: Date.now(), ...item }); };
  return {
    kind: 'mock',
    state,
    async getStatus() {
      return {
        battery: state.battery,
        volume: state.volume,
        muted: state.muted,
        asleep: state.asleep,
        locked: state.locked,
        media: state.media ? { ...state.media, playing: state.playing } : null,
        appsRunning: state.apps.filter(app => app.running).map(app => app.name),
      };
    },
    async captureFrame() {
      state.seq += 1;
      const rgba = Buffer.alloc(state.width * state.height * 4);
      for (let y = 0; y < state.height; y++) {
        for (let x = 0; x < state.width; x++) {
          const i = (y * state.width + x) * 4;
          const window = x > 18 && x < 110 && y > 16 && y < 62;
          rgba[i] = window ? 36 : 12;
          rgba[i + 1] = window ? 48 : 14;
          rgba[i + 2] = window ? 64 : 18;
          rgba[i + 3] = 255;
        }
      }
      const cx = Math.max(0, Math.min(state.width - 1, state.cursorX | 0));
      const cy = Math.max(0, Math.min(state.height - 1, state.cursorY | 0));
      for (let dy = 0; dy < 6; dy++) {
        for (let dx = 0; dx <= dy; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= state.width || y >= state.height) continue;
          const i = (y * state.width + x) * 4;
          rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = 255;
        }
      }
      return { jpeg: encodeJPEG(rgba, state.width, state.height, 60), width: state.width, height: state.height, seq: state.seq };
    },
    async move(dx, dy) {
      state.calls.push(['move', dx, dy]);
      state.cursorX = Math.max(0, Math.min(state.width - 1, state.cursorX + dx));
      state.cursorY = Math.max(0, Math.min(state.height - 1, state.cursorY + dy));
    },
    async click(button, count) { state.calls.push(['click', button, count]); },
    async scroll(dx, dy) { state.calls.push(['scroll', dx, dy]); },
    async key(key, down, modifiers) { state.calls.push(['key', key, down, modifiers]); },
    async typeText(text) { state.calls.push(['text', text]); state.clipboard = text; },
    async setVolume(level) { state.volume = level; },
    async setMuted(muted) { state.muted = muted; },
    async media(action) {
      state.calls.push(['media', action]);
      if (action === 'toggle') state.playing = !state.playing;
      if (action === 'play') state.playing = true;
      if (action === 'pause') state.playing = false;
      if (action === 'next') state.media = { ...state.media, title: 'Angel', position: 0 };
      if (action === 'previous') state.media = { ...state.media, position: 0 };
    },
    async listApps() { return state.apps.map(app => ({ ...app })); },
    async launchApp(id) {
      const app = state.apps.find(item => item.id === id);
      if (!app) throw Object.assign(new Error('Приложение не найдено'), { code: 'app' });
      app.running = true;
      state.calls.push(['launch', id]);
      return app;
    },
    async getClipboard() { return state.clipboard; },
    async setClipboard(text) { state.clipboard = text; },
    async pollNotifications() {
      const fresh = state.notifications.splice(0);
      return fresh;
    },
    pushNotification(item) { note(item); },
    async power(action) {
      state.calls.push(['power', action]);
      if (action === 'sleep') state.asleep = true;
      if (action === 'lock') state.locked = true;
      if (action === 'restart' || action === 'shutdown') state.asleep = true;
    },
  };
}
