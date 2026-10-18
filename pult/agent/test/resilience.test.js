import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWindowsFirewall, firewallDisabled, resetFirewallGuard } from '../src/firewall.js';
import { readDefaultRoutes } from '../src/lan.js';
import { safeExecFile } from '../src/platform/spawn.js';
import { createWindowsPlatform } from '../src/platform/windows.js';

function eperm() {
  return Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
}

test('safeExecFile turns a synchronous EPERM into a blocked result', async () => {
  const result = await safeExecFile('route', ['print', '-4'], {
    execFileImpl() { throw eperm(); },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'EPERM');
});

test('safeExecFile reports a numeric exit without treating it as a block', async () => {
  const result = await safeExecFile('route', ['print'], {
    execFileImpl(_file, _args, _options, callback) {
      callback(Object.assign(new Error('requires elevation'), { code: 1 }), '', 'The requested operation requires elevation.');
      return { on() { return this; } };
    },
  });
  assert.equal(result.blocked, false);
  assert.equal(result.code, 1);
});

test('safeExecFile settles once when the callback and the error event both fire', async () => {
  const result = await safeExecFile('route', [], {
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

test('the node firewall helper does not start a program', async () => {
  resetFirewallGuard();
  const first = await ensureWindowsFirewall({ ports: [4720, 4318], adapterName: 'Wi-Fi', platform: 'win32' });
  assert.equal(first.applied, false);
  assert.equal(first.skipped, true);
  assert.match(first.notes.join('\n'), /pult\.exe/);
  const second = await ensureWindowsFirewall({ ports: [4720], adapterName: 'Wi-Fi', platform: 'win32', disabled: true });
  assert.equal(second.skipped, true);
  assert.match(second.notes.join('\n'), /PULT_NO_FIREWALL|--no-firewall/);
});

test('--no-firewall and PULT_NO_FIREWALL are recognised', async () => {
  assert.equal(firewallDisabled(['node', 'index.js'], { PULT_NO_FIREWALL: '1' }), true);
  assert.equal(firewallDisabled(['node', 'index.js', '--no-firewall'], {}), true);
  assert.equal(firewallDisabled(['node', 'index.js'], {}), false);
});

test('a blocked route lookup becomes an empty list', async () => {
  const routes = await readDefaultRoutes({
    platform: 'win32',
    exec() { throw eperm(); },
  });
  assert.deepEqual(routes, []);
});

test('node on Windows refuses desktop control and does not start a helper', async () => {
  const platform = createWindowsPlatform({ force: true });
  const status = await platform.getStatus();
  assert.equal(status.unavailable, true);
  assert.equal(status.volume, null);
  assert.match(status.reason, /pult\.exe/);
  await assert.rejects(platform.captureFrame(), error => error.unavailable === true && /pult\.exe/.test(error.message));
  assert.deepEqual(await platform.listApps(), []);
  await assert.rejects(platform.power('lock'), error => /pult\.exe/.test(error.message));
  assert.deepEqual(await platform.pollNotifications(), []);
});

test('the Windows launch path does not name a script host', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = ['src/platform/windows.js', 'src/firewall.js', 'src/index.js', 'Start-Pult.cmd'];
  const banned = [/powershell/i, /cmd\.exe/i, /rundll32/i, /wscript/i, /cscript/i, /mshta/i, /child_process/, /netsh/i];
  for (const name of files) {
    const text = await readFile(path.join(root, name), 'utf8');
    for (const pattern of banned) {
      assert.doesNotMatch(text, pattern, `${name} matches ${pattern}`);
    }
  }
  const launcher = await readFile(path.join(root, 'Start-Pult.cmd'), 'utf8');
  assert.doesNotMatch(launcher, /\bnode(\.exe)?\b/i);
  await assert.rejects(readFile(path.join(root, 'src/platform/windows-helper.ps1')));
});
