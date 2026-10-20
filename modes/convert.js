import path from 'node:path';

const BLOCKED = /^(powershell|pwsh|cmd|cscript|wscript)(\.exe)?$/i;

export function assertExecutable(file) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('Конвертер не найден');
  if (/[;&|<>`\n\r]/.test(file) || BLOCKED.test(path.win32.basename(file))) {
    throw new Error('Конвертер запускается только своим файлом, без PowerShell и cmd');
  }
}

function direct(file, args) {
  assertExecutable(file);
  return { file, args, shell: false };
}

export function heicPlan({ ffmpeg, heif, input, output }) {
  if (heif) return direct(heif, [input, output]);
  return direct(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map_metadata', '0', '-q:v', '2', output]);
}

export function h264Plan({ ffmpeg, input, output, encoder = 'libopenh264' }) {
  const video = encoder === 'h264_mf' ? ['-c:v', 'h264_mf', '-b:v', '8M'] : ['-c:v', 'libopenh264', '-b:v', '8M'];
  return direct(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map_metadata', '0', ...video, '-c:a', 'aac', '-b:a', '160k', output]);
}

export function proxyPlan({ ffmpeg, input, output, encoder = 'prores_ks' }) {
  if (encoder === 'h264') return h264Plan({ ffmpeg, input, output, encoder: 'libopenh264' });
  return direct(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map_metadata', '0', '-vf', 'scale=-2:1080', '-c:v', 'prores_ks', '-profile:v', '0', '-c:a', 'pcm_s16le', output]);
}

export function spawnPlan(spawn, plan) {
  if (!plan || plan.shell !== false) throw new Error('shell запрещён');
  assertExecutable(plan.file);
  return spawn(plan.file, plan.args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

export const LICENSES = {
  ffmpeg: 'LGPL-2.1-or-later',
  libheif: 'LGPL-3.0-or-later',
  openh264: 'BSD-2-Clause',
};
