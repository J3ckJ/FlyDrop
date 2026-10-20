import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'vendor', 'converters');
const FFMPEG_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip';

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}
async function walk(dir, found = []) {
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) await walk(full, found);
    else found.push(full);
  }
  return found;
}
async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`${url} → ${response.status}`);
  await pipeline(response.body, createWriteStream(file));
}

export async function fetchConverters() {
  if (process.platform !== 'win32') { console.log('Converters are fetched on Windows only'); return; }
  await mkdir(dest, { recursive: true });
  if (!(await exists(path.join(dest, 'ffmpeg.exe')))) {
    const zip = path.join(dest, 'ffmpeg-lgpl.zip');
    const extracted = path.join(dest, 'ffmpeg-src');
    console.log('Downloading LGPL ffmpeg');
    await download(FFMPEG_URL, zip);
    await mkdir(extracted, { recursive: true });
    await exec('tar', ['-xf', zip, '-C', extracted], { shell: false, windowsHide: true });
    const files = await walk(extracted);
    const exe = files.find(file => path.basename(file).toLowerCase() === 'ffmpeg.exe');
    if (!exe) throw new Error('В архиве ffmpeg нет ffmpeg.exe');
    const bin = path.dirname(exe);
    for (const file of await readdir(bin)) {
      if (/\.(exe|dll)$/i.test(file)) await copyFile(path.join(bin, file), path.join(dest, file));
    }
    await writeFile(path.join(dest, 'FFMPEG-SOURCE.txt'), `LGPL-2.1-or-later\n${FFMPEG_URL}\nDownloaded ${new Date().toISOString()}\nReplace this binary with your own build if you want.\n`, 'utf8');
    await rm(zip, { force: true });
    await rm(extracted, { recursive: true, force: true });
    console.log('ffmpeg.exe is in vendor/converters');
  }
  if (!(await exists(path.join(dest, 'heif-convert.exe')))) {
    console.log('heif-convert.exe is optional. HEIC falls back to ffmpeg -map_metadata, and the original stays.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchConverters().catch(error => { console.error(error.message); process.exitCode = 1; });
}
