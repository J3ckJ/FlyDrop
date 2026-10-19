const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(view, offset, value) { view.setUint16(offset, value, true); }
function u32(view, offset, value) { view.setUint32(offset, value, true); }

export async function zipFiles(files, { maxFiles = 500, maxBytes = 1024 ** 3 } = {}) {
  if (!files.length) throw new Error('Папка пустая');
  if (files.length > maxFiles) throw new Error('В папке слишком много файлов. Можно до 500');
  const entries = [];
  let total = 0;
  for (const file of files) {
    const name = (file.webkitRelativePath || file.name).replaceAll('\\', '/');
    if (!name || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Некорректный путь в папке');
    const data = new Uint8Array(await file.arrayBuffer());
    total += data.length;
    if (total > maxBytes) throw new Error('Папка больше 1 ГБ. Она не отправлена');
    entries.push({ name: new TextEncoder().encode(name), data, crc: crc32(data) });
  }
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of entries) {
    const local = new Uint8Array(30);
    const view = new DataView(local.buffer);
    u32(view, 0, 0x04034b50);
    u16(view, 4, 20);
    u16(view, 6, 0x800);
    u32(view, 14, file.crc);
    u32(view, 18, file.data.length);
    u32(view, 22, file.data.length);
    u16(view, 26, file.name.length);
    locals.push(local, file.name, file.data);
    const central = new Uint8Array(46);
    const centralView = new DataView(central.buffer);
    u32(centralView, 0, 0x02014b50);
    u16(centralView, 4, 20);
    u16(centralView, 6, 20);
    u16(centralView, 8, 0x800);
    u32(centralView, 16, file.crc);
    u32(centralView, 20, file.data.length);
    u32(centralView, 24, file.data.length);
    u16(centralView, 28, file.name.length);
    u32(centralView, 42, offset);
    centrals.push(central, file.name);
    offset += local.length + file.name.length + file.data.length;
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  u32(endView, 0, 0x06054b50);
  u16(endView, 8, entries.length);
  u16(endView, 10, entries.length);
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  u32(endView, 12, centralSize);
  u32(endView, 16, offset);
  const blob = new Blob([...locals, ...centrals, end], { type: 'application/zip' });
  const folder = (files[0].webkitRelativePath || 'folder').split('/')[0] || 'folder';
  return new File([blob], `${folder}.zip`, { type: 'application/zip' });
}
