import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { emptyVault } from '../security.js';

function request(app, route, { method = 'GET', cookie = '', body, headers = {}, remote = false, secure = remote } = {}) {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const port = secure ? app.securePort : app.port;
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({ hostname: '127.0.0.1', port, path: route, method, ca: secure ? app.material.ca : undefined, localAddress: remote ? '127.0.0.2' : '127.0.0.1', headers: { Origin: `${secure ? 'https' : 'http'}://127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}), ...(bytes ? { 'Content-Length': bytes.length } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const payload = Buffer.concat(chunks); let value; try { value = JSON.parse(payload); } catch { value = undefined; } resolve({ status: res.statusCode, headers: res.headers, bytes: payload, value, text: payload.toString('utf8') }); });
    });
    req.on('error', reject); req.end(bytes);
  });
}
const cookies = response => response.headers['set-cookie']?.map(value => value.split(';')[0]).join('; ') || '';
async function boot(t, options = {}) {
  const unloadRoot = await mkdtemp(path.join(os.tmpdir(), 'flydrop-unload-'));
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'flydrop-data-'));
  const app = await createApp({ runPlan: options.runPlan === undefined ? null : options.runPlan, unloadRoot, dataDirectory, unloadChunk: options.unloadChunk, now: options.now, vaultStore: options.vaultStore });
  t.after(() => app.close());
  const host = await request(app, '/api/connect', { method: 'POST', body: {}, headers: { 'X-FlyDrop-Desktop': app.desktopKey } });
  assert.equal(host.status, 200);
  return { app, pc: { cookie: cookies(host), state: host.value }, unloadRoot, dataDirectory };
}
async function pair(app, pc) {
  const pending = await request(app, '/api/connect', { method: 'POST', remote: true, body: { code: app.getState().security.pairingCode, name: 'iPhone', type: 'phone' } });
  assert.equal(pending.status, 202);
  assert.equal((await request(app, `/api/pairings/${pending.value.requestId}/approve`, { method: 'POST', cookie: pc.cookie, body: { remember: true } })).status, 200);
  const phone = await request(app, '/api/pair-status', { method: 'POST', remote: true, body: pending.value });
  assert.equal(phone.status, 200);
  return { cookie: cookies(phone), state: phone.value, remote: true };
}

test('buffer moves both ways, hides secrets, and a shortcut token cannot open a session', async t => {
  let now = Date.now();
  const { app, pc } = await boot(t, { now: () => now });
  const phone = await pair(app, pc);
  const sent = await request(app, '/api/buffer', { method: 'POST', cookie: pc.cookie, body: { text: 'Встреча с монтажёром перенесена на четверг, 14:00, Лесная 9, студия 3', source: 'hotkey' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.value.status, 'waiting');
  const phoneList = await request(app, '/api/buffer', { ...phone });
  assert.equal(phoneList.value.items[0].title.includes('Лесная 9'), true);
  assert.equal((await request(app, `/api/buffer/${sent.value.id}/ack`, { method: 'POST', ...phone, body: {} })).value.status, 'delivered');
  const code = await request(app, '/api/buffer', { method: 'POST', ...phone, body: { text: 'Код из SMS 482193', source: 'share' } });
  assert.equal(code.status, 201);
  assert.equal(JSON.stringify(code.value).includes('482193'), false);
  const revealed = await request(app, `/api/buffer/${code.value.id}/reveal`, { method: 'POST', cookie: pc.cookie, body: {} });
  assert.match(revealed.value.text, /482193/);
  const listed = await request(app, '/api/state', { cookie: pc.cookie });
  assert.equal(JSON.stringify(listed.value.buffer).includes('482193'), false);
  now += 61_000;
  await app.sweep();
  assert.equal((await request(app, '/api/buffer', { cookie: pc.cookie })).value.items.some(item => item.id === code.value.id), false);
  const shortcut = await request(app, '/api/buffer/shortcut', phone);
  assert.equal(shortcut.status, 200);
  assert.match(shortcut.text, /getclipboard/);
  const token = shortcut.text.match(/Bearer ([A-Za-z0-9_-]+)/)[1];
  assert.equal((await request(app, '/api/state', { remote: true, headers: { Authorization: `Bearer ${token}` } })).status, 401);
  const ingested = await request(app, '/api/buffer/ingest', { method: 'POST', remote: true, body: 'https://disk.studio/sc-05-rushes', headers: { Authorization: `Bearer ${token}`, 'X-FlyDrop-Source': 'backtap', 'Content-Type': 'text/plain' } });
  assert.equal(ingested.status, 200);
  assert.match(ingested.text, /Доставлено/);
  assert.equal((await request(app, '/api/buffer', { cookie: pc.cookie })).value.items.some(item => item.title.includes('disk.studio')), true);
  assert.equal((await request(app, '/api/buffer/ingest', { method: 'POST', remote: true, body: 'no', headers: { 'Content-Type': 'text/plain' } })).status, 401);
});

test('chunked unload resumes, skips a known hash, and writes the report', async t => {
  const plans = [];
  const { app, pc, unloadRoot } = await boot(t, { unloadChunk: 4, runPlan: async plan => { plans.push(plan); } });
  const phone = await pair(app, pc);
  const bytes = Buffer.from('abcdefghij');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const probe = await request(app, '/api/unload/probe', { method: 'POST', ...phone, body: { eventName: 'Съёмка «Лесная»', files: [{ clientId: 'a', name: 'IMG_2207.HEIC', size: bytes.length, sha256, calendar: '2026-10-18', takenAt: Date.parse('2026-10-18T12:00:00Z'), mime: 'image/heic' }] } });
  assert.equal(probe.status, 200);
  assert.equal(probe.value.accept.length, 1);
  assert.deepEqual(probe.value.accept[0].missing, [0, 1, 2]);
  const id = probe.value.accept[0].uploadId;
  assert.equal((await request(app, `/api/unload/${id}/chunks/0`, { method: 'PUT', ...phone, body: bytes.subarray(0, 4) })).status, 200);
  assert.equal((await request(app, `/api/unload/${id}/chunks/2`, { method: 'PUT', ...phone, body: bytes.subarray(8) })).value.missing.join(), '1');
  const resumed = await request(app, `/api/unload/${id}/chunks/1`, { method: 'PUT', ...phone, body: bytes.subarray(4, 8), headers: { 'X-FlyDrop-Resume': '1' } });
  assert.equal(resumed.value.done, true);
  const done = await request(app, `/api/unload/${id}/finish`, { method: 'POST', ...phone, body: {} });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.value.sha256, sha256);
  assert.deepEqual(await readFile(done.value.path), bytes);
  const info = await stat(done.value.path);
  assert.equal(info.mtime.toISOString().slice(0, 10), '2026-10-18');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].shell, false);
  assert.equal(plans[0].args.includes('powershell'), false);
  const again = await request(app, '/api/unload/probe', { method: 'POST', ...phone, body: { files: [{ clientId: 'a', name: 'IMG_2207.HEIC', size: bytes.length, sha256, calendar: '2026-10-18' }] } });
  assert.equal(again.value.accept.length, 0);
  assert.equal(again.value.skip.length, 1);
  const report = await request(app, '/api/unload/report', { method: 'POST', cookie: pc.cookie, body: { copied: 1, skipped: 1, errors: 0, verified: 1, folders: ['2026-10-18 Съёмка «Лесная»'], resumes: ['IMG_2207.HEIC с 4 Б'] } });
  assert.equal(report.value.line, 'Скопировано 1, пропущено 1');
  const text = await readFile(path.join(unloadRoot, '_flydrop-report.txt'), 'utf8');
  assert.match(text, /1 из 1 совпали по SHA-256/);
});

test('выгрузка accepts a file larger than the 1 GB transfer limit', async t => {
  const { app, pc } = await boot(t);
  const phone = await pair(app, pc);
  const huge = await request(app, '/api/unload/probe', { method: 'POST', ...phone, body: { files: [{ clientId: 'big', name: 'IMG_9.MOV', size: 2 * 1024 ** 3, sha256: createHash('sha256').update('big').digest('hex'), calendar: '2026-10-18', mime: 'video/quicktime' }] } });
  assert.equal(huge.status, 200, huge.text);
  assert.equal(huge.value.accept.length, 1);
  assert.equal(huge.value.accept[0].missing.length, 128);
});

test('pinned buffer text survives a restart when disk history is on', async t => {
  const store = { value: emptyVault(), save: async () => {}, flush: async () => {} };
  store.value.settings.clipboardPersist = true;
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'flydrop-persist-'));
  const first = await createApp({ vaultStore: store, runPlan: null, dataDirectory });
  t.after(() => first.close());
  const host = await request(first, '/api/connect', { method: 'POST', body: {}, headers: { 'X-FlyDrop-Desktop': first.desktopKey } });
  const added = await request(first, '/api/buffer', { method: 'POST', cookie: cookies(host), body: { text: 'ssh eugene@nas' } });
  assert.equal((await request(first, `/api/buffer/${added.value.id}/pin`, { method: 'POST', cookie: cookies(host), body: { pinned: true } })).status, 200);
  assert.equal(JSON.stringify(store.value.bufferHistory).includes('ssh eugene@nas'), true);
  await first.close();
  const second = await createApp({ vaultStore: store, runPlan: null, dataDirectory });
  t.after(() => second.close());
  const again = await request(second, '/api/connect', { method: 'POST', body: {}, headers: { 'X-FlyDrop-Desktop': second.desktopKey } });
  const items = (await request(second, '/api/buffer', { cookie: cookies(again) })).value.items;
  assert.equal(items.some(item => item.pinned && item.title === 'ssh eugene@nas'), true);
});
