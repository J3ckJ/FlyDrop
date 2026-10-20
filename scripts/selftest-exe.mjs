import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const release = path.resolve('release');
const names = await readdir(release);
const exe = names.find(name => /^FlyDrop-.+-Windows\.exe$/i.test(name));
if (!exe) { console.error('Windows exe was not built'); process.exit(1); }
const markerDir = await mkdtemp(path.join(os.tmpdir(), 'flydrop-selftest-'));
const marker = path.join(markerDir, 'result.txt');
const child = spawn(path.join(release, exe), ['--selftest'], { shell: false, windowsHide: true, env: { ...process.env, FLYDROP_SELFTEST_OUT: marker } });
let output = '';
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
const timer = setTimeout(() => { console.error('selftest timed out'); child.kill(); process.exit(1); }, 180000);
child.on('exit', async code => {
  clearTimeout(timer);
  let file = '';
  try { file = await readFile(marker, 'utf8'); process.stdout.write(file); } catch { /* The portable wrapper does not relay the GUI process console. */ }
  if (code !== 0 || !`${output}\n${file}`.includes('FLYDROP_SELFTEST_OK')) {
    console.error(`selftest failed: code ${code}`);
    process.exit(1);
  }
});
