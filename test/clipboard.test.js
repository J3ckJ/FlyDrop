import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const { createClipboardActions, readClipboard, pathsFromUriList, describeClipboardFiles } = createRequire(import.meta.url)('../desktop/clipboard.cjs');

function fixture(read, { sendText = async () => ({ to: 'iPhone' }), sendFiles = async () => [{ to: 'iPhone' }] } = {}) {
  const result = { shown: 0, filled: [], staged: [], sentText: [], sentFiles: [], messages: [], notifications: [] };
  const actions = createClipboardActions({
    read, show: () => result.shown++, fillText: text => result.filled.push(text), stageFiles: files => { result.staged.push(files); },
    sendText: async text => { result.sentText.push(text); return sendText(text); },
    sendFiles: async files => { result.sentFiles.push(files); return sendFiles(files); },
    message: text => result.messages.push(text), notify: (...args) => result.notifications.push(args),
  });
  return { ...actions, result };
}
const filesOf = (...names) => ({ kind: 'files', files: names.map(name => ({ path: `C:\\${name}`, name, size: 4 })), folders: 0, oversized: 0 });

test('clipboard compose waits for asynchronous text and fills the composer', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const operation = f.compose();
  assert.equal(f.result.shown, 1);
  assert.deepEqual(f.result.filled, []);
  resolve({ kind: 'text', text: 'Текст из буфера' }); await operation;
  assert.deepEqual(f.result.filled, ['Текст из буфера']);
  assert.deepEqual(f.result.sentText, []);
  assert.deepEqual(f.result.sentFiles, []);
  assert.deepEqual(f.result.messages, []);
});
test('clipboard quick send passes resolved text and reports success after send', async () => {
  const f = fixture(async () => ({ kind: 'text', text: 'Отправить на телефон' }));
  await f.quickSend();
  assert.deepEqual(f.result.sentText, ['Отправить на телефон']);
  assert.deepEqual(f.result.sentFiles, []);
  assert.deepEqual(f.result.filled, []);
  assert.deepEqual(f.result.messages, ['Буфер отправлен: iPhone']);
  assert.equal(f.result.notifications.length, 1);
  assert.equal(f.result.notifications[0][0], 'Текст отправлен');
});
test('both clipboard actions handle read failures and empty clipboard without throwing', async () => {
  for (const read of [async () => { throw new Error('Буфер недоступен'); }, async () => { throw new Error('В буфере нет текста или файлов. Сначала скопируйте их'); }, async () => ({ kind: 'other' })]) {
    for (const action of ['compose', 'quickSend']) {
      const f = fixture(read); await assert.doesNotReject(f[action]());
      assert.deepEqual(f.result.filled, []); assert.deepEqual(f.result.staged, []);
      assert.deepEqual(f.result.sentText, []); assert.deepEqual(f.result.sentFiles, []);
      assert.equal(f.result.messages.length, 1); assert.equal(f.result.shown, 1);
      assert.deepEqual(f.result.notifications, []);
    }
  }
});
test('clipboard send reports unavailable recipient and rejects oversized text', async () => {
  const f = fixture(async () => ({ kind: 'text', text: 'Текст' }), { sendText: async () => { throw new Error('Выберите получателя'); } });
  await assert.doesNotReject(f.quickSend());
  assert.deepEqual(f.result.messages, ['Выберите получателя']);
  assert.equal(f.result.notifications.length, 0);
  const large = fixture(async () => ({ kind: 'text', text: 'x'.repeat(50001) }));
  await large.quickSend(); assert.deepEqual(large.result.sentText, []);
  await large.compose(); assert.equal(large.result.filled[0].length, 50000);
  assert.equal(large.result.messages.length, 2);
});
test('clipboard compose stages files without sending them', async () => {
  const value = filesOf('a.txt', 'b.txt');
  const f = fixture(async () => value);
  await f.compose();
  assert.deepEqual(f.result.staged, [value.files]);
  assert.deepEqual(f.result.filled, []);
  assert.deepEqual(f.result.sentFiles, []);
  assert.deepEqual(f.result.messages, []);
});
test('clipboard quick send delivers files to the injected recipient and skips nothing silently', async () => {
  const value = { ...filesOf('a.txt', 'b.txt'), folders: 1 };
  const f = fixture(async () => value);
  await f.quickSend();
  assert.deepEqual(f.result.sentFiles, [value.files]);
  assert.deepEqual(f.result.sentText, []);
  assert.equal(f.result.staged.length, 0);
  assert.match(f.result.messages.at(-1), /^Буфер отправлен: iPhone \(2\)\. Папка не добавлена$/);
  assert.deepEqual(f.result.notifications[0], ['Файлы отправлены', 'Получатель: iPhone']);
});
test('clipboard file send failure opens the window and does not notify', async () => {
  const f = fixture(async () => filesOf('a.txt'), { sendFiles: async () => { throw new Error('Получатель отключился'); } });
  await assert.doesNotReject(f.quickSend());
  assert.equal(f.result.messages.at(-1), 'Получатель отключился');
  assert.equal(f.result.notifications.length, 0);
  assert.equal(f.result.shown, 2);
});
test('uri list is preferred over the path pasted as text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flydrop-clip-'));
  try {
    const file = path.join(directory, 'заметка.txt');
    const folder = path.join(directory, 'папка');
    await writeFile(file, 'abc'); await mkdir(folder);
    const list = ['# comment', pathToFileURL(file).href, pathToFileURL(folder).href, 'https://example.invalid/not-a-file'].join('\r\n');
    const value = await readClipboard({
      readItems: async () => [{ types: ['text/uri-list', 'text/plain'], text: async () => list }],
      readText: async () => file,
    });
    assert.equal(value.kind, 'files');
    assert.equal(value.files.length, 1);
    assert.equal(value.files[0].path, file);
    assert.equal(value.files[0].name, 'заметка.txt');
    assert.equal(value.files[0].size, 3);
    assert.equal(value.folders, 1);
    await assert.rejects(readClipboard({
      readItems: async () => [{ types: ['text/uri-list'], text: async () => 'not-a-file' }],
      readText: async () => 'секретный текст',
    }), /Не удалось прочитать файлы/);
    await assert.rejects(readClipboard({ readItems: async () => [], readText: async () => '   ' }), /нет текста или файлов/);
    assert.deepEqual(pathsFromUriList(`\r\n# keep\r\n${pathToFileURL(file).href}\r\n`), [file]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('clipboard prefers a copied image over plain text and packs a single folder', async () => {
  const image = await readClipboard({
    readItems: async () => [{ types: ['image/png', 'text/plain'], text: async () => '', bytes: async () => Buffer.from('png-bytes') }],
    readText: async () => 'подпись к снимку',
  });
  assert.equal(image.kind, 'image'); assert.equal(image.type, 'image/png'); assert.equal(image.bytes.toString(), 'png-bytes');
  const packed = await readClipboard({
    readItems: async () => [{ types: ['text/uri-list'], text: async () => 'file:///C:/Users/photos' }],
    readText: async () => 'C:\\Users\\photos',
    stat: async () => ({ isFile: () => false, isDirectory: () => true, size: 0 }),
    zipFolder: async folder => ({ path: `${folder}.zip`, name: 'photos.zip', size: 12 }),
  });
  assert.equal(packed.kind, 'files'); assert.equal(packed.files[0].name, 'photos.zip'); assert.equal(packed.zipped, 1); assert.equal(packed.folders, 0);
});
test('clipboard file description skips folders and oversized files and stops past the limits', async () => {
  const stat = async filePath => ({ isFile: () => !filePath.endsWith('\\dir'), isDirectory: () => filePath.endsWith('\\dir'), size: filePath.endsWith('big.bin') ? 1024 ** 3 + 1 : 6 });
  const mixed = await describeClipboardFiles(['C:\\ok.txt', 'C:\\dir', 'C:\\big.bin'], { stat, maxFile: 1024 ** 3 });
  assert.deepEqual(mixed.files.map(file => file.name), ['ok.txt']);
  assert.equal(mixed.folders, 1); assert.equal(mixed.oversized, 1);
  const onlyFolder = await describeClipboardFiles(['C:\\dir'], { stat });
  assert.equal(onlyFolder.files.length, 0); assert.deepEqual(onlyFolder.folderPaths, ['C:\\dir']);
  await assert.rejects(describeClipboardFiles(['C:\\big.bin'], { stat, maxFile: 1024 ** 3 }), /больше 1 ГБ/);
  await assert.rejects(describeClipboardFiles(['C:\\a.txt', 'C:\\b.txt'], { stat, maxFile: 100, maxTotal: 10 }), /больше 2 ГБ/);
  const many = Array.from({ length: 501 }, (_, index) => `C:\\f${index}.txt`);
  await assert.rejects(describeClipboardFiles(many, { stat: async () => { throw new Error('should not stat'); } }), /слишком много/);
});
