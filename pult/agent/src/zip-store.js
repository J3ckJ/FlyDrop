import { LIMITS } from './protocol.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 240) throw Object.assign(new Error('Некорректное имя в папке'), { code: 'NAME' });
  const normalized = name.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw Object.assign(new Error('Некорректный путь в папке'), { code: 'PATH' });
  }
  return normalized;
}

// Store-method ZIP. FlyDrop delivers the archive as a file; the receiver does not need deflate.
export function zipStore(entries, { maxFiles = LIMITS.maxZipFiles, maxBytes = LIMITS.maxFileBytes } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw Object.assign(new Error('Папка пустая'), { code: 'EMPTY' });
  if (entries.length > maxFiles) throw Object.assign(new Error('В папке слишком много файлов. Можно до 500'), { code: 'LIMIT_FILES' });
  let total = 0;
  const prepared = entries.map(entry => {
    const name = safeEntryName(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    total += data.length;
    if (total > maxBytes) throw Object.assign(new Error('Папка больше 1 ГБ. Она не отправлена'), { code: 'LIMIT_BYTES' });
    return { name: Buffer.from(name, 'utf8'), data, crc: crc32(data) };
  });
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of prepared) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(file.crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(file.name.length, 26);
    locals.push(Buffer.concat([local, file.name, file.data]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(file.crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(file.name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, file.name]));
    offset += local.length + file.name.length + file.data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}
