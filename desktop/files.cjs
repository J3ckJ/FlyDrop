const path = require('node:path');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
function safeName(value) {
  let name = Array.from(path.basename(value).replace(/[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '_')).slice(0, 180).join('').replace(/[. ]+$/, '');
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name || 'file'}`;
  return name;
}
async function saveIncoming(source, name, folder) {
  const base = path.resolve(folder); await fs.mkdir(base, { recursive: true });
  const safe = safeName(name), extension = path.extname(safe), stem = safe.slice(0, safe.length - extension.length);
  for (let index = 0; index < 1000; index++) {
    const filename = index ? `${stem} (${index})${extension}` : safe, destination = path.resolve(base, filename);
    if (path.dirname(destination) !== base) throw new Error('Недопустимый путь сохранения');
    try { await fs.copyFile(source, destination, constants.COPYFILE_EXCL); return { name: filename, path: destination }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Слишком много файлов с одинаковым именем');
}
module.exports = { safeName, saveIncoming };
