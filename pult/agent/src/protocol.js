export const PROTOCOL_VERSION = 1;
export const SERVICE_TYPE = '_pult._tcp.local';
export const WS_PATH = '/pult';
export const DEFAULT_PORT = 4720;

export const LIMITS = Object.freeze({
  maxFileBytes: 1024 ** 3,
  maxTextChars: 50_000,
  maxZipFiles: 500,
  maxMessageBytes: 256 * 1024,
  maxFrameBytes: 1024 * 1024,
  maxName: 40,
  pairingWindowMs: 60_000,
  pairingAttempts: 5,
  pairingTtlMs: 5 * 60_000,
  defaultFps: 12,
  maxFps: 12,
  maxSessions: 8,
  maxPairedDevices: 16,
  maxTypeLength: 2000,
});

export const CLIENT_TYPES = Object.freeze([
  'hello',
  'pair',
  'status.get',
  'screen.subscribe',
  'screen.unsubscribe',
  'input.move',
  'input.click',
  'input.scroll',
  'input.key',
  'input.text',
  'volume.set',
  'media.command',
  'apps.list',
  'apps.launch',
  'clipboard.get',
  'clipboard.set',
  'notifications.list',
  'power.action',
  'wol.wake',
  'wol.schedule.list',
  'wol.schedule.put',
  'wol.schedule.delete',
  'flydrop.progress',
  'flydrop.info',
]);

const CLIENT_TYPE_SET = new Set(CLIENT_TYPES);
const POWER = new Set(['sleep', 'lock', 'restart', 'shutdown']);
const MEDIA = new Set(['play', 'pause', 'toggle', 'next', 'previous']);
const BUTTONS = new Set(['left', 'right', 'middle']);
const TRANSFER = new Set(['uploading', 'done', 'cancelled', 'error']);
const KEYS = /^[a-z0-9]$|^(enter|escape|tab|backspace|space|up|down|left|right|ctrl|alt|shift|win|meta|f[1-9]|f1[0-2])$/;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function fail(message) {
  return message;
}

function checkPayload(type, payload) {
  switch (type) {
    case 'hello':
      if (payload.name !== undefined && typeof payload.name !== 'string') return fail('Некорректное имя');
      if (payload.name && [...payload.name].length > LIMITS.maxName) return fail('Имя длиннее 40 символов');
      if (payload.token !== undefined && payload.token !== null && typeof payload.token !== 'string') return fail('Некорректный ключ');
      if (typeof payload.token === 'string' && payload.token.length > 128) return fail('Некорректный ключ');
      return null;
    case 'pair':
      if (typeof payload.code !== 'string' || !/^\d{6}$/.test(payload.code)) return fail('Код — шесть цифр');
      if (payload.name !== undefined && (typeof payload.name !== 'string' || [...payload.name].length > LIMITS.maxName)) return fail('Некорректное имя');
      return null;
    case 'screen.subscribe':
      if (payload.fps !== undefined && (!Number.isInteger(payload.fps) || payload.fps < 1 || payload.fps > LIMITS.maxFps)) return fail('Частота кадров от 1 до 12');
      return null;
    case 'screen.unsubscribe':
    case 'status.get':
    case 'apps.list':
    case 'clipboard.get':
    case 'notifications.list':
    case 'wol.schedule.list':
    case 'flydrop.info':
      return null;
    case 'input.move':
    case 'input.scroll':
      if (!Number.isFinite(payload.dx) || !Number.isFinite(payload.dy)) return fail('Некорректное смещение');
      if (Math.abs(payload.dx) > 8000 || Math.abs(payload.dy) > 8000) return fail('Слишком большое смещение');
      return null;
    case 'input.click':
      if (!BUTTONS.has(payload.button || 'left')) return fail('Некорректная кнопка');
      if (payload.count !== undefined && (!Number.isInteger(payload.count) || payload.count < 1 || payload.count > 3)) return fail('Некорректный щелчок');
      return null;
    case 'input.key':
      if (typeof payload.key !== 'string' || !KEYS.test(payload.key)) return fail('Некорректная клавиша');
      if (typeof payload.down !== 'boolean') return fail('Некорректное состояние клавиши');
      if (payload.modifiers !== undefined && !Array.isArray(payload.modifiers)) return fail('Некорректные модификаторы');
      return null;
    case 'input.text':
      if (typeof payload.text !== 'string' || payload.text.length > LIMITS.maxTypeLength) return fail('Слишком длинный текст');
      return null;
    case 'volume.set':
      if (payload.level !== undefined && (!Number.isInteger(payload.level) || payload.level < 0 || payload.level > 100)) return fail('Громкость от 0 до 100');
      if (payload.muted !== undefined && typeof payload.muted !== 'boolean') return fail('Некорректное состояние звука');
      if (payload.level === undefined && payload.muted === undefined) return fail('Не указана громкость');
      return null;
    case 'media.command':
      if (!MEDIA.has(payload.action)) return fail('Неизвестная команда плеера');
      return null;
    case 'apps.launch':
      if (typeof payload.id !== 'string' || !payload.id.trim() || payload.id.length > 300) return fail('Некорректное приложение');
      return null;
    case 'clipboard.set':
      if (typeof payload.text !== 'string' || [...payload.text].length > LIMITS.maxTextChars) return fail('Текст буфера длиннее 50 000 символов');
      return null;
    case 'power.action':
      if (!POWER.has(payload.action)) return fail('Неизвестное действие питания');
      if (payload.action === 'shutdown' && payload.hold !== true) return fail('Выключение только удержанием');
      if (payload.force !== undefined && typeof payload.force !== 'boolean') return fail('Некорректное подтверждение');
      return null;
    case 'wol.wake':
      if (!isMac(payload.mac)) return fail('Некорректный MAC-адрес');
      return null;
    case 'wol.schedule.put':
      if (!isMac(payload.mac)) return fail('Некорректный MAC-адрес');
      if (typeof payload.label !== 'string' || ![...payload.label].length || [...payload.label].length > 80) return fail('Введите название сценария');
      if (!Number.isInteger(payload.hour) || payload.hour < 0 || payload.hour > 23) return fail('Час от 0 до 23');
      if (!Number.isInteger(payload.minute) || payload.minute < 0 || payload.minute > 59) return fail('Минута от 0 до 59');
      if (payload.id !== undefined && (typeof payload.id !== 'string' || payload.id.length > 64)) return fail('Некорректный сценарий');
      return null;
    case 'wol.schedule.delete':
      if (typeof payload.id !== 'string' || !payload.id) return fail('Некорректный сценарий');
      return null;
    case 'flydrop.progress':
      if (typeof payload.name !== 'string' || payload.name.length > 180) return fail('Некорректное имя файла');
      if (!TRANSFER.has(payload.state)) return fail('Некорректное состояние передачи');
      if (!Number.isFinite(payload.loaded) || !Number.isFinite(payload.total) || payload.loaded < 0 || payload.total < 0 || payload.total > LIMITS.maxFileBytes) return fail('Некорректный прогресс');
      return null;
    default: {
      const unknown = type;
      throw new ProtocolError(`Нет проверки для ${unknown}`);
    }
  }
}

const covered = new Set(CLIENT_TYPES);
for (const type of CLIENT_TYPE_SET) {
  if (!covered.has(type)) throw new ProtocolError(`Команда без проверки: ${type}`);
}

export function isMac(value) {
  return typeof value === 'string' && /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(value);
}

export function parseMessage(raw) {
  if (typeof raw !== 'string') return { error: 'Ожидался текст' };
  if (Buffer.byteLength(raw) > LIMITS.maxMessageBytes) return { error: 'Слишком большое сообщение' };
  let message;
  try { message = JSON.parse(raw); } catch { return { error: 'Некорректное сообщение' }; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { error: 'Некорректное сообщение' };
  if (message.v !== PROTOCOL_VERSION) return { error: 'Неподдерживаемая версия протокола' };
  if (typeof message.type !== 'string' || !CLIENT_TYPE_SET.has(message.type)) return { error: 'Неизвестная команда' };
  if (message.id !== undefined && message.id !== null && (typeof message.id !== 'string' || message.id.length > 64)) return { error: 'Некорректный идентификатор' };
  const payload = message.payload === undefined ? {} : message.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'Некорректная команда' };
  let problem;
  try { problem = checkPayload(message.type, payload); }
  catch (error) { return { error: error.message }; }
  if (problem) return { error: problem };
  return { message: { v: PROTOCOL_VERSION, id: message.id || null, type: message.type, payload } };
}

export function resultMessage(request, payload) {
  return JSON.stringify({ v: PROTOCOL_VERSION, id: request.id, type: request.type, ok: true, payload: payload || {} });
}

export function errorMessage(request, error) {
  return JSON.stringify({ v: PROTOCOL_VERSION, id: request?.id || null, type: request?.type || 'error', ok: false, error: String(error || 'Ошибка') });
}

export function eventMessage(type, payload) {
  return JSON.stringify({ v: PROTOCOL_VERSION, type, payload });
}
