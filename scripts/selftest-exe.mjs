import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const release = path.resolve('release');
const names = await readdir(release);
const exe = names.find(name => /^FlyDrop-.+-Windows\.exe$/i.test(name));
if (!exe) { console.error('Windows exe was not built'); process.exit(1); }
const child = spawn(path.join(release, exe), ['--selftest'], { shell: false, windowsHide: true });
let output = '';
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
child.on('exit', code => {
  if (code !== 0 || !output.includes('FLYDROP_SELFTEST_OK')) {
    console.error(`selftest failed: code ${code}`);
    process.exit(1);
  }
});
