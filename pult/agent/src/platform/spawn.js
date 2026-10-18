import { spawn } from 'node:child_process';

export function run(command, args, { timeout = 8000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error(`${command} не ответил`), { code: 'timeout' }));
    }, timeout);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) reject(Object.assign(new Error(stderr.trim() || `${command} завершился с кодом ${code}`), { code: 'exit', status: code, stdout }));
      else resolve({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function commandExists(name) {
  return run(process.platform === 'win32' ? 'where.exe' : 'which', [name], { timeout: 2000 }).then(() => true, () => false);
}
