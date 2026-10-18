import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ensureWindowsFirewall, firewallDisabled, resetFirewallGuard } from '../src/firewall.js';
import { readDefaultRoutes } from '../src/lan.js';
import { safeExecFile } from '../src/platform/spawn.js';
import { createWindowsPlatform } from '../src/platform/windows.js';

function eperm() {
  return Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
}

test('safeExecFile turns a synchronous EPERM into a blocked result', async () => {
  const result = await safeExecFile('netsh', ['advfirewall', 'show', 'currentprofile'], {
    execFileImpl() { throw eperm(); },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'EPERM');
});

test('safeExecFile reports a numeric exit without treating it as a block', async () => {
  const result = await safeExecFile('netsh', ['advfirewall'], {
    execFileImpl(_file, _args, _options, callback) {
      callback(Object.assign(new Error('requires elevation'), { code: 1 }), '', 'The requested operation requires elevation.');
      return { on() { return this; } };
    },
  });
  assert.equal(result.blocked, false);
  assert.equal(result.code, 1);
});

test('safeExecFile settles once when the callback and the error event both fire', async () => {
  const result = await safeExecFile('netsh', [], {
    execFileImpl(_file, _args, _options, callback) {
      const child = {
        on(event, fn) {
          if (event === 'error') queueMicrotask(() => fn(eperm()));
          return child;
        },
      };
      queueMicrotask(() => callback(eperm(), '', ''));
      return child;
    },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'EPERM');
});

test('EPERM, ENOENT and a timeout skip the firewall check without throwing', async () => {
  resetFirewallGuard();
  let calls = 0;
  const blocked = async () => {
    calls += 1;
    throw eperm();
  };
  const first = await ensureWindowsFirewall({ ports: [4720, 4318], adapterName: 'Wi-Fi', platform: 'win32', exec: blocked });
  assert.equal(first.applied, false);
  assert.equal(first.blocked, true);
  const text = first.notes.join('\n');
  assert.match(text, /EPERM/);
  assert.match(text, /продолжает работу/);
  assert.match(text, /netsh advfirewall firewall add rule name="Pult"/);
  assert.match(text, /localport=4720,4318/);
  assert.match(text, /--no-firewall/);
  const second = await ensureWindowsFirewall({ ports: [4720, 4318], adapterName: 'Wi-Fi', platform: 'win32', exec: blocked });
  assert.equal(calls, 1);
  assert.equal(second.skipped, true);

  resetFirewallGuard();
  const missing = await ensureWindowsFirewall({
    ports: [4720],
    adapterName: 'Wi-Fi',
    platform: 'win32',
    exec: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); },
  });
  assert.match(missing.notes.join('\n'), /ENOENT/);
  assert.equal(missing.skipped, true);

  resetFirewallGuard();
  let timeouts = 0;
  const timed = await ensureWindowsFirewall({
    ports: [4720],
    adapterName: 'Wi-Fi',
    platform: 'win32',
    exec: async () => {
      timeouts += 1;
      return { code: 'ETIMEDOUT', stdout: '', stderr: 'timed out', blocked: true, killed: true };
    },
  });
  assert.match(timed.notes.join('\n'), /таймаут/);
  await ensureWindowsFirewall({ ports: [4720], adapterName: 'Wi-Fi', platform: 'win32', exec: async () => { timeouts += 1; return { code: 0, stdout: '', stderr: '' }; } });
  assert.equal(timeouts, 1);
  resetFirewallGuard();
});

test('an elevation failure still retries the firewall check', async () => {
  resetFirewallGuard();
  let calls = 0;
  const exec = async (_file, args) => {
    calls += 1;
    if (args.includes('currentprofile')) return { code: 0, stdout: 'Private Profile Settings:\r\n', stderr: '' };
    if (args.includes('add')) return { code: 1, stdout: '', stderr: 'The requested operation requires elevation.' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const first = await ensureWindowsFirewall({ ports: [4720], adapterName: 'Wi-Fi', platform: 'win32', exec });
  assert.equal(first.applied, false);
  assert.equal(first.skipped, false);
  assert.match(first.notes.join('\n'), /администратора/);
  const before = calls;
  await ensureWindowsFirewall({ ports: [4720], adapterName: 'Wi-Fi', platform: 'win32', exec });
  assert.ok(calls > before);
  resetFirewallGuard();
});

test('--no-firewall and PULT_NO_FIREWALL skip netsh', async () => {
  resetFirewallGuard();
  let calls = 0;
  const exec = async () => { calls += 1; return { code: 0, stdout: '', stderr: '' }; };
  const fromEnv = await ensureWindowsFirewall({
    ports: [4720],
    platform: 'win32',
    disabled: firewallDisabled(['node', 'index.js'], { PULT_NO_FIREWALL: '1' }),
    exec,
  });
  assert.equal(fromEnv.skipped, true);
  assert.match(fromEnv.notes.join('\n'), /4720/);
  const fromFlag = await ensureWindowsFirewall({
    ports: [4720],
    platform: 'win32',
    disabled: firewallDisabled(['node', 'index.js', '--no-firewall'], {}),
    exec,
  });
  assert.equal(fromFlag.skipped, true);
  assert.equal(calls, 0);
  assert.equal(firewallDisabled(['node', 'index.js'], {}), false);
});

test('a blocked route lookup becomes an empty list', async () => {
  const routes = await readDefaultRoutes({
    platform: 'win32',
    exec() { throw eperm(); },
  });
  assert.deepEqual(routes, []);
});

test('blocked PowerShell fails one feature and leaves power and the app list up', async () => {
  const execCalls = [];
  const platform = createWindowsPlatform({
    force: true,
    spawnImpl() { throw eperm(); },
    exec(file, args) {
      execCalls.push([file, [...args]]);
      return { code: 0, stdout: '', stderr: '', blocked: false };
    },
  });
  const status = await platform.getStatus();
  assert.equal(status.unavailable, true);
  assert.equal(status.volume, null);
  assert.match(status.reason, /PowerShell/);
  await assert.rejects(platform.captureFrame(), error => error.unavailable === true && /PowerShell/.test(error.message));
  const apps = await platform.listApps();
  assert.ok(Array.isArray(apps));
  await platform.power('lock');
  assert.deepEqual(execCalls, [['rundll32.exe', ['user32.dll,LockWorkStation']]]);
  assert.equal(execCalls.some(([file]) => /powershell/i.test(file)), false);
});

test('an async PowerShell error event stays inside the status call', async () => {
  const platform = createWindowsPlatform({
    force: true,
    spawnImpl() {
      const stdout = new PassThrough();
      const stdin = new PassThrough();
      const handlers = {};
      const child = {
        stdout,
        stdin,
        stderr: new PassThrough(),
        killed: false,
        kill() {},
        on(event, fn) {
          (handlers[event] ||= []).push(fn);
          return child;
        },
      };
      queueMicrotask(() => {
        for (const fn of handlers.error || []) fn(eperm());
      });
      return child;
    },
    exec() { return { code: 0, stdout: '', stderr: '', blocked: false }; },
  });
  const status = await platform.getStatus();
  assert.equal(status.unavailable, true);
  assert.match(status.reason, /PowerShell/);
});
