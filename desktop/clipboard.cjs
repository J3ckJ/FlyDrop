const { fileURLToPath } = require('node:url');
const path = require('node:path');
const fs = require('node:fs/promises');

const MAX_FILE = 1024 ** 3, MAX_FILES = 500, MAX_TOTAL = 2 * MAX_FILE;

// Explorer stores copied files as CF_HDROP. Electron 44 exposes that as text/uri-list.
function pathsFromUriList(value) {
  if (typeof value !== 'string') return [];
  const paths = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !/^file:/i.test(trimmed)) continue;
    try {
      const filePath = fileURLToPath(trimmed);
      if (path.win32.isAbsolute(filePath)) paths.push(filePath);
    } catch { /* Foreign or broken URI, not a file the user copied. */ }
  }
  return [...new Set(paths)];
}

async function describeClipboardFiles(paths, { stat = fs.stat, maxFile = MAX_FILE, maxFiles = MAX_FILES, maxTotal = MAX_TOTAL } = {}) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('В буфере нет текста или файлов. Сначала скопируйте их');
  if (paths.length > maxFiles) throw new Error(`В буфере слишком много файлов. Можно отправить не больше ${maxFiles}`);
  const files = [], folderPaths = [];
  let folders = 0, oversized = 0, total = 0;
  for (const filePath of paths) {
    let info;
    try { info = await stat(filePath); }
    catch { throw new Error('Не удалось прочитать файл из буфера. Скопируйте его ещё раз'); }
    if (!info.isFile()) { folders++; if (info.isDirectory?.()) folderPaths.push(filePath); continue; }
    if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error('Не удалось прочитать файл из буфера. Скопируйте его ещё раз');
    if (info.size > maxFile) { oversized++; continue; }
    if (total + info.size > maxTotal) throw new Error('В буфере больше 2 ГБ. Отправьте меньше файлов');
    total += info.size;
    files.push({ path: filePath, name: path.win32.basename(filePath), size: info.size });
  }
  if (!files.length && !folderPaths.length) {
    if (oversized) throw new Error(oversized > 1 ? 'Файлы из буфера больше 1 ГБ' : 'Файл из буфера больше 1 ГБ');
    throw new Error('В буфере нет файла, который можно отправить');
  }
  return { files, folders, folderPaths, oversized };
}

function folderMessage(error) {
  if (error?.code === 'LIMIT_BYTES') return new Error('Папка больше 1 ГБ. Она не отправлена');
  if (error?.code === 'LIMIT_FILES') return new Error('В папке слишком много файлов. Можно до 500');
  if (error?.code === 'EMPTY') return new Error('Папка пустая');
  return error instanceof Error ? error : new Error('Не удалось упаковать папку из буфера');
}
async function readClipboard({ readItems, readText, stat, zipFolder, maxFile, maxFiles, maxTotal } = {}) {
  const items = await readItems();
  let sawFiles = false;
  const paths = [];
  for (const item of items || []) {
    if (!item?.types?.includes('text/uri-list')) continue;
    sawFiles = true;
    paths.push(...pathsFromUriList(await item.text()));
  }
  if (sawFiles) {
    const unique = [...new Set(paths)];
    if (!unique.length) throw new Error('Не удалось прочитать файлы из буфера. Скопируйте их ещё раз');
    const described = await describeClipboardFiles(unique, { stat, maxFile, maxFiles, maxTotal });
    const packed = [];
    let unpacked = described.folderPaths.length;
    if (described.folderPaths.length && typeof zipFolder === 'function') {
      for (const folder of described.folderPaths) {
        try { packed.push(await zipFolder(folder)); unpacked--; }
        catch (error) { if (!described.files.length && described.folderPaths.length === 1 && !packed.length) throw folderMessage(error); }
      }
    }
    const files = [...described.files, ...packed];
    if (!files.length) {
      if (described.folderPaths.length && !described.oversized) throw new Error(described.folderPaths.length > 1 ? 'В буфере только папки. Скопируйте файлы, а не папку' : 'В буфере папка. Скопируйте файлы, а не папку');
      if (described.oversized) throw new Error(described.oversized > 1 ? 'Файлы из буфера больше 1 ГБ' : 'Файл из буфера больше 1 ГБ');
      throw new Error('В буфере нет файла, который можно отправить');
    }
    return { kind: 'files', files, folders: unpacked, oversized: described.oversized, zipped: packed.length };
  }
  for (const item of items || []) {
    const type = item?.types?.includes('image/png') ? 'image/png' : item?.types?.includes('image/jpeg') ? 'image/jpeg' : '';
    if (!type || typeof item.bytes !== 'function') continue;
    const bytes = Buffer.from(await item.bytes(type));
    if (!bytes.length) continue;
    if (bytes.length > (maxFile || MAX_FILE)) throw new Error('Файл из буфера больше 1 ГБ');
    return { kind: 'image', bytes, type };
  }
  const text = await readText();
  if (typeof text !== 'string') throw new Error('Не удалось прочитать буфер обмена');
  if (!text.trim()) throw new Error('В буфере нет текста или файлов. Сначала скопируйте их');
  return { kind: 'text', text };
}

function phrases(lang) {
  const en = lang === 'en';
  return {
    wait: en ? 'Wait until the transfer finishes' : 'Дождитесь окончания передачи',
    trimmed: en ? 'Pasted the first 50 000 characters from the clipboard' : 'Вставлены первые 50 000 символов из буфера',
    readFail: en ? 'Could not read the clipboard' : 'Не удалось прочитать буфер обмена',
    sendFail: en ? 'Could not send the clipboard' : 'Не удалось отправить буфер обмена',
    fileFail: en ? 'Could not send the clipboard files' : 'Не удалось отправить файлы из буфера',
    tooLong: en ? 'Text must be shorter than 50 000 characters' : 'Текст должен быть короче 50 000 символов',
    rest: en ? 'The other files are ready to send' : 'Остальные файлы готовы к отправке',
    notifyText: en ? 'Text sent' : 'Текст отправлен',
    to: name => en ? `To: ${name}` : `Получатель: ${name}`,
    sending: count => en ? (count > 1 ? `Sending ${count} clipboard files…` : 'Sending a clipboard file…') : (count > 1 ? `Отправляем файлы из буфера (${count})…` : 'Отправляем файл из буфера…'),
    sentFiles: (to, count, note) => {
      const suffix = count > 1 ? ` (${count})` : '';
      const base = en ? `Clipboard sent: ${to}${suffix}` : `Буфер отправлен: ${to}${suffix}`;
      return note ? `${base}. ${note}` : base;
    },
    sentText: to => en ? `Clipboard sent: ${to}` : `Буфер отправлен: ${to}`,
    notifyFiles: count => en ? (count > 1 ? 'Files sent' : 'File sent') : (count > 1 ? 'Файлы отправлены' : 'Файл отправлен'),
    folder: count => en ? (count > 1 ? `Folders were not added: ${count}` : 'Folder was not added') : (count > 1 ? `Папки не добавлены: ${count}` : 'Папка не добавлена'),
    oversized: count => en ? (count > 1 ? `Files over 1 GB were not added: ${count}` : 'A file over 1 GB was not added') : (count > 1 ? `Файлы больше 1 ГБ не добавлены: ${count}` : 'Файл больше 1 ГБ не добавлен'),
  };
}
function skippedNote(value, text) {
  const notes = [];
  if (value.folders) notes.push(text.folder(value.folders));
  if (value.oversized) notes.push(text.oversized(value.oversized));
  return notes.join('. ');
}

function createClipboardActions({ read, show, fillText, stageFiles, sendText, sendFiles, message, notify, language = () => 'ru' }) {
  const text = () => phrases(language());
  async function payload() {
    const value = await read();
    if (!value || (value.kind !== 'text' && value.kind !== 'files')) throw new Error(text().readFail);
    return value;
  }
  async function compose() {
    try {
      show();
      const value = await payload();
      if (value.kind === 'files') {
        if (stageFiles(value.files) === false) { message(text().wait); return; }
        const note = skippedNote(value, text());
        if (note) message(`${note}. ${text().rest}`);
        return;
      }
      if (fillText(value.text.slice(0, 50000)) === false) { message(text().wait); return; }
      if (value.text.length > 50000) message(text().trimmed);
    } catch (error) {
      message(error.message || text().readFail);
    }
  }
  async function quickSend() {
    try {
      const value = await payload();
      if (value.kind === 'files') {
        show();
        message(text().sending(value.files.length));
        const items = await sendFiles(value.files);
        const to = items?.[0]?.to;
        if (!to) throw new Error(text().fileFail);
        message(text().sentFiles(to, value.files.length, skippedNote(value, text())));
        notify(text().notifyFiles(value.files.length), text().to(to));
        return;
      }
      if (value.text.length > 50000) throw new Error(text().tooLong);
      const item = await sendText(value.text);
      message(text().sentText(item.to));
      notify(text().notifyText, text().to(item.to));
    } catch (error) {
      show();
      message(error.message || text().sendFail);
    }
  }
  return { compose, quickSend };
}

module.exports = { createClipboardActions, readClipboard, pathsFromUriList, describeClipboardFiles };
