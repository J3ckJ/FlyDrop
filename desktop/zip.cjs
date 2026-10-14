const zlib = require('node:zlib');
const fs = require('node:fs/promises');
const path = require('node:path');

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function inside(root, real) {
  const relative = path.relative(root, real);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function collect(root, { maxFiles, maxBytes }) {
  const realRoot = await fs.realpath(root);
  const files = [];
  let total = 0;
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const full = path.join(dir, entry.name);
      const link = await fs.lstat(full);
      if (link.isSymbolicLink()) continue;
      let real;
      try { real = await fs.realpath(full); } catch { continue; }
      if (!inside(realRoot, real)) continue;
      if (link.isDirectory()) { await walk(full); continue; }
      if (!link.isFile()) continue;
      if (files.length >= maxFiles) { const error = new Error('В папке слишком много файлов. Можно до 500'); error.code = 'LIMIT_FILES'; throw error; }
      if (total + link.size > maxBytes) { const error = new Error('Папка больше 1 ГБ. Она не отправлена'); error.code = 'LIMIT_BYTES'; throw error; }
      total += link.size;
      const name = path.relative(realRoot, real).split(path.sep).join('/');
      files.push({ full: real, name, size: link.size });
    }
  }
  await walk(realRoot);
  return files;
}

async function zipDirectory(root, destination, { maxFiles = 500, maxBytes = 1024 ** 3 } = {}) {
  const files = await collect(root, { maxFiles, maxBytes });
  if (!files.length) { const error = new Error('Папка пустая'); error.code = 'EMPTY'; throw error; }
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const data = await fs.readFile(file.full);
    const compressed = zlib.deflateRawSync(data);
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(Buffer.concat([local, name, compressed]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += locals.at(-1).length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const body = Buffer.concat([...locals, centralDir, eocd]);
  await fs.writeFile(destination, body, { mode: 0o600, flag: 'wx' });
  return { path: destination, name: path.basename(destination), size: body.length, count: files.length };
}

function listZip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= 0; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Некорректный архив');
  const count = buffer.readUInt16LE(end + 8);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Некорректный архив');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const payload = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? payload : zlib.inflateRawSync(payload);
    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

module.exports = { zipDirectory, listZip };
