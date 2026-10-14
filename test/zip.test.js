import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { zipDirectory, listZip } = createRequire(import.meta.url)('../desktop/zip.cjs');

test('zip keeps nested names and skips links that leave the folder', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flydrop-zip-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'flydrop-zip-out-'));
  try {
    const folder = path.join(directory, 'фото');
    await mkdir(path.join(folder, 'вложенная'), { recursive: true });
    await writeFile(path.join(folder, 'вложенная', 'заметка.txt'), 'привет');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(path.join(outside, 'secret.txt'), path.join(folder, 'link.txt')).catch(() => {});
    const destination = path.join(directory, 'фото.zip');
    const archive = await zipDirectory(folder, destination, { maxBytes: 1024, maxFiles: 10 });
    const entries = listZip(await readFile(archive.path));
    assert.deepEqual(entries.map(entry => entry.name), ['вложенная/заметка.txt']);
    assert.equal(entries[0].data.toString(), 'привет');
    await assert.rejects(zipDirectory(folder, path.join(directory, 'small.zip'), { maxBytes: 2, maxFiles: 10 }), /больше 1 ГБ/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
