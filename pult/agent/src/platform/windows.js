const REASON = 'Управление Windows выполняет pult.exe напрямую через Win32. Запустите pult.exe, а не node src\\index.js.';

function refuse() {
  const error = new Error(REASON);
  error.code = 'blocked';
  error.unavailable = true;
  return error;
}

function deniedStatus() {
  return {
    unavailable: true,
    reason: REASON,
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
  const unsupported = async (method) => {
    throw Object.assign(new Error(`Windows-помощник не выполняет ${method} на этой системе`), { code: 'platform' });
  };
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
    close() {},
  };
}

export function createWindowsPlatform({ force = false } = {}) {
  if (process.platform !== 'win32' && !force) return stubPlatform();
  return {
    kind: 'windows',
    available: false,
    async getStatus() { return deniedStatus(); },
    async captureFrame() { throw refuse(); },
    async move() { throw refuse(); },
    async click() { throw refuse(); },
    async scroll() { throw refuse(); },
    async key() { throw refuse(); },
    async typeText() { throw refuse(); },
    async setVolume() { throw refuse(); },
    async setMuted() { throw refuse(); },
    async media() { throw refuse(); },
    async listApps() { return []; },
    async launchApp() { throw refuse(); },
    async getClipboard() { throw refuse(); },
    async setClipboard() { throw refuse(); },
    async pollNotifications() { return []; },
    async power() { throw refuse(); },
    close() {},
  };
}
