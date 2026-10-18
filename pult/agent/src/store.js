import { randomBytes, randomInt, createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS } from './protocol.js';

export const hashSecret = value => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const newCode = () => String(randomInt(100000, 1000000));
export const sameSecret = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

export async function openStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'devices.json');
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = { hostId: randomUUID(), devices: [], schedules: [] };
  }
  if (!data.hostId || !Array.isArray(data.devices) || !Array.isArray(data.schedules)) throw new Error('Повреждено хранилище Пульта');
  if (!Array.isArray(data.subscriptions)) data.subscriptions = [];
  const save = () => writeJson(file, data);
  return {
    data,
    file,
    save,
    findToken(token) {
      if (typeof token !== 'string' || !token) return null;
      const digest = hashSecret(token);
      return data.devices.find(device => sameSecret(device.tokenHash, digest)) || null;
    },
    async remember({ name }) {
      if (data.devices.length >= LIMITS.maxPairedDevices) throw Object.assign(new Error('Достигнут предел телефонов'), { code: 'limit' });
      const token = newToken();
      const device = { id: randomUUID(), name: name || 'iPhone', tokenHash: hashSecret(token), createdAt: Date.now(), lastSeen: Date.now() };
      data.devices.push(device);
      await save();
      return { token, device };
    },
    async touch(id) {
      const device = data.devices.find(item => item.id === id);
      if (!device) return;
      device.lastSeen = Date.now();
      await save();
    },
    async revoke(id) {
      const before = data.devices.length;
      data.devices = data.devices.filter(device => device.id !== id);
      if (data.devices.length === before) return false;
      await save();
      return true;
    },
    async putSchedule(schedule) {
      const existing = schedule.id ? data.schedules.find(item => item.id === schedule.id) : null;
      const record = {
        id: existing?.id || randomUUID(),
        mac: schedule.mac.toLowerCase(),
        label: schedule.label,
        hour: schedule.hour,
        minute: schedule.minute,
        lastFiredDate: existing?.lastFiredDate || '',
      };
      if (existing) Object.assign(existing, record);
      else data.schedules.push(record);
      if (data.schedules.length > 32) throw Object.assign(new Error('Слишком много сценариев'), { code: 'limit' });
      await save();
      return record;
    },
    async deleteSchedule(id) {
      data.schedules = data.schedules.filter(item => item.id !== id);
      await save();
    },
    async markSchedule(id, date) {
      const item = data.schedules.find(entry => entry.id === id);
      if (!item) return;
      item.lastFiredDate = date;
      await save();
    },
  };
}
