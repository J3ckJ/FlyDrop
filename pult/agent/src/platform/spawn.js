import { execFile as execFileCb, spawn } from 'node:child_process';

const SPAWN_CODES = new Set(['EPERM', 'EACCES', 'ENOENT', 'ETIMEDOUT', 'ENOTDIR']);

export function isSpawnFailure(error) {
  if (!error) return false;
  if (SPAWN_CODES.has(error.code)) return true;
  if (error.killed) return true;
  return /spawn |timed out|ETIMEDOUT/i.test(String(error.message || ''));
}

function markPolicy(error) {
  if (error && (error.code === 'EPERM' || error.code === 'EACCES')) error.unavailable = true;
  return error;
}

export function safeExecFile(file, args, { timeout = 20000, execFileImpl = execFileCb } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (error, stdout = '', stderr = '') => {
      if (settled) return;
      settled = true;
      const blocked = isSpawnFailure(error);
      const code = !error ? 0 : (typeof error.code === 'number' ? error.code : (error.code || 1));
      resolve({
        code,
        stdout: String(stdout || ''),
        stderr: String(stderr || error?.message || ''),
        blocked,
      });
    };
    let child;
    try {
      child = execFileImpl(file, args, { windowsHide: true, timeout }, (error, stdout, stderr) => {
        finish(error, stdout, stderr);
      });
    } catch (error) {
      finish(error);
      return;
    }
    if (child && typeof child.on === 'function') child.on('error', error => finish(error));
  });
}

export function run(command, args, { timeout = 8000, input } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(markPolicy(error));
      return;
    }
    const out = [];
    const err = [];
    timer = setTimeout(() => {
      child.kill();
      finish(reject, Object.assign(new Error(`${command} не ответил`), { code: 'timeout' }));
    }, timeout);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', error => finish(reject, markPolicy(error)));
    child.on('close', code => {
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) finish(reject, Object.assign(new Error(stderr.trim() || `${command} завершился с кодом ${code}`), { code: 'exit', status: code, stdout }));
      else finish(resolve, { stdout, stderr });
    });
    try {
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    } catch (error) {
      finish(reject, markPolicy(error));
    }
  });
}

export function commandExists(name) {
  return run(process.platform === 'win32' ? 'where.exe' : 'which', [name], { timeout: 2000 }).then(() => true, () => false);
}
