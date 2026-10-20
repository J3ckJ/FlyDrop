import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function seal(key, plain) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Нужен ключ шифрования истории');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8');
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64url');
}

export function open(key, packed) {
  const blob = Buffer.from(packed, 'base64url');
  if (blob.length < 29) throw new Error('Повреждена зашифрованная история');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}
