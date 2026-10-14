import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { access, readdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createApp } from '../server.js';
import { emptyVault, openVault } from '../security.js';
const require = createRequire(import.meta.url);
const { safeName, saveIncoming } = require('../desktop/files.cjs');

function request(app, route, { method = 'GET', cookie = '', body, headers = {}, remote = false, secure = remote } = {}) {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const port = secure ? app.securePort : app.port;
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({ hostname: '127.0.0.1', port, path: route, method, ca: secure ? app.material.ca : undefined, localAddress: remote ? '127.0.0.2' : '127.0.0.1', headers: { Origin: `${secure ? 'https' : 'http'}://127.0.0.1:${port}`, Cookie: cookie, ...(bytes !== undefined ? { 'Content-Length': bytes.length } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const bytes = Buffer.concat(chunks); let value; try { value = JSON.parse(bytes); } catch {} resolve({ status: res.statusCode, headers: res.headers, bytes, value }); });
    }); req.on('error', reject); req.end(bytes);
  });
}
const cookies = response => response.headers['set-cookie']?.map(v => v.split(';')[0]).join('; ') || '';
async function host(app) { const response = await request(app, '/api/connect', { method: 'POST', body: {}, headers: { 'X-FlyDrop-Desktop': app.desktopKey } }); assert.equal(response.status, 200); return { cookie: cookies(response), state: response.value, remote: false }; }
async function pair(app, pc, { name = 'iPhone', remember = true } = {}) {
  const pending = await request(app, '/api/connect', { method: 'POST', remote: true, body: { code: app.getState().security.pairingCode, name, type: 'phone' } });
  assert.equal(pending.status, 202); assert.equal(cookies(pending), '');
  const approved = await request(app, `/api/pairings/${pending.value.requestId}/approve`, { method: 'POST', cookie: pc.cookie, body: { remember } }); assert.equal(approved.status, 200);
  const response = await request(app, '/api/pair-status', { method: 'POST', remote: true, body: pending.value }); assert.equal(response.status, 200);
  return { cookie: cookies(response), state: response.value, remote: true };
}
async function listen(app, client, t) {
  return new Promise((resolve, reject) => {
    const req = (client.remote ? https : http).get({ hostname: '127.0.0.1', port: client.remote ? app.securePort : app.port, path: '/api/events', ca: app.material.ca, localAddress: client.remote ? '127.0.0.2' : '127.0.0.1', headers: { Cookie: client.cookie } }, res => {
      res.setEncoding('utf8'); let data = ''; res.on('data', chunk => { data += chunk; if (data.includes('event: state')) resolve({ req, res, read: () => data }); });
    }); req.on('error', reject); t.after(() => req.destroy());
  });
}
async function setup(t, options) { const app = await createApp(options); t.after(() => app.close()); const pc = await host(app); return { app, pc }; }

test('all local tabs and browser sessions are one Windows device; self-send is rejected', async t => {
  const { app, pc } = await setup(t), second = await host(app);
  assert.equal(pc.state.self.id, second.state.self.id);
  await listen(app, pc, t); await listen(app, second, t);
  const state = await request(app, '/api/state', { cookie: pc.cookie }); assert.equal(state.value.devices.length, 0);
  const phone = await pair(app, pc); await listen(app, phone, t);
  const phoneState = await request(app, '/api/state', phone);
  assert.equal(phoneState.value.devices.length, 1); assert.equal(phoneState.value.devices[0].id, pc.state.self.id);
  assert.equal((await request(app, '/api/text', { method: 'POST', cookie: second.cookie, body: { text: 'self' }, headers: { 'X-Recipient': pc.state.self.id } })).status, 400);
  assert.equal((await request(app, '/api/upload', { method: 'POST', cookie: pc.cookie, body: Buffer.from('self'), headers: { 'X-Recipient': pc.state.self.id } })).status, 400);
});
test('loopback address alone grants no host privileges; browser capability is one-use and local-only', async t => {
  const { app } = await setup(t);
  assert.equal((await request(app, '/api/connect', { method: 'POST', body: { isHost: true } })).status, 401);
  assert.equal((await request(app, '/api/connect', { method: 'POST', body: {}, headers: { 'X-FlyDrop-Desktop': 'wrong' } })).status, 401);
  const link = new URL(app.browserLink()), desktopTicket = new URLSearchParams(link.hash.slice(1)).get('desktop');
  assert.equal((await request(app, '/api/connect', { method: 'POST', remote: true, body: { desktopTicket } })).status, 403);
  const response = await request(app, '/api/connect', { method: 'POST', body: { desktopTicket } }); assert.equal(response.status, 200);
  assert.equal((await request(app, '/api/connect', { method: 'POST', body: { desktopTicket } })).status, 401);
  assert.equal(response.value.self.isHost, true); assert.equal(JSON.stringify(response.value).includes(app.desktopKey), false);
});
test('HTTPS verification succeeds; LAN HTTP cannot transmit, expose the UI or authenticate', async t => {
  const { app } = await setup(t);
  assert.equal((await request(app, '/api/state', { remote: true })).status, 401);
  for (const route of ['/', '/api/state', '/app.js', '/manifest.webmanifest']) assert.equal((await request(app, route, { remote: true, secure: false })).status, 426);
  assert.equal((await request(app, '/api/connect', { method: 'POST', remote: true, secure: false, body: { code: app.getState().security.pairingCode } })).status, 426);
  const profile = await request(app, '/certificate.mobileconfig', { remote: true, secure: false });
  assert.equal(profile.status, 200); assert.ok(!profile.bytes.toString().includes('PRIVATE KEY')); assert.match(profile.bytes.toString(), /com.apple.security.root/);
  assert.equal((await request(app, '/setup', { remote: true, secure: false })).status, 200);
  assert.equal((await request(app, '/i18n.js', { remote: true, secure: false })).status, 200);
  assert.equal((await request(app, '/setup.js', { remote: true, secure: false })).status, 200);
  await assert.rejects(new Promise((resolve, reject) => https.get(`https://127.0.0.1:${app.securePort}/`, resolve).on('error', reject)), /certificate|issuer|self-signed/i);
});
test('unapproved clients have no access; owner approval, matching codes, rejection and rotation work', async t => {
  const { app, pc } = await setup(t);
  const pending = await request(app, '/api/connect', { method: 'POST', remote: true, body: { code: app.getState().security.pairingCode, name: 'iPhone', type: 'phone' } }); assert.equal(pending.status, 202);
  assert.equal(app.getState().security.requests[0].verificationCode, pending.value.verificationCode);
  assert.equal((await request(app, '/api/text', { method: 'POST', remote: true, body: { text: 'no' } })).status, 401);
  assert.equal((await request(app, `/api/pairings/${pending.value.requestId}/approve`, { method: 'POST', remote: true, body: {} })).status, 401);
  assert.equal((await request(app, '/api/pair-status', { method: 'POST', remote: true, body: { ...pending.value, token: 'wrong' } })).status, 403);
  assert.equal((await request(app, '/api/pair-status', { method: 'POST', remote: true, body: pending.value })).status, 202);
  await request(app, `/api/pairings/${pending.value.requestId}/reject`, { method: 'POST', cookie: pc.cookie, body: {} });
  assert.equal((await request(app, '/api/pair-status', { method: 'POST', remote: true, body: pending.value })).status, 403);
  const oldCode = app.getState().security.pairingCode;
  await request(app, '/api/pairing/rotate', { method: 'POST', cookie: pc.cookie, body: {} });
  assert.equal((await request(app, '/api/connect', { method: 'POST', remote: true, body: { code: oldCode } })).status, 403);
});
test('text and binary files transfer both directions with recipient-only access and safe previews', async t => {
  const { app, pc } = await setup(t), phone = await pair(app, pc);
  const pcEvents = await listen(app, pc, t), phoneEvents = await listen(app, phone, t);
  assert.ok(phone.cookie.includes('__Host-flydrop-trust='));
  const text = '  Привет!\n<script>alert(1)</script> 🛫\nhttps://example.com  ';
  for (const [sender, recipient] of [[pc,phone],[phone,pc]]) {
    const message = await request(app, '/api/text', { ...sender, method: 'POST', body: { text }, headers: { 'X-Recipient': recipient.state.self.id } }); assert.equal(message.status, 201);
    const inbox = await request(app, '/api/state', recipient); assert.equal(inbox.value.inbox.at(-1).text, text);
    const bytes = Buffer.from([0,1,2,128,255,0,3]);
    const uploaded = await request(app, '/api/upload', { ...sender, method: 'POST', body: bytes, headers: { 'X-Recipient': recipient.state.self.id, 'X-Filename': encodeURIComponent('файл 🛫.bin') } }); assert.equal(uploaded.status, 201);
    const download = await request(app, `/api/download/${uploaded.value.id}`, recipient); assert.equal(download.status, 200); assert.deepEqual(download.bytes, bytes);
    assert.equal((await request(app, `/api/download/${uploaded.value.id}`, sender)).status, 403);
    assert.equal((await request(app, `/api/preview/${uploaded.value.id}`, recipient)).status, 415);
  }
  assert.ok(phoneEvents.read().includes('event: received')); assert.ok(pcEvents.read().includes('event: received'));
  const png = await readFile(new URL('../public/icons/icon-192.png', import.meta.url));
  const photo = await request(app, '/api/upload', { ...phone, method: 'POST', body: png, headers: { 'X-Recipient': pc.state.self.id, 'X-Filename': 'photo.png' } }); assert.equal(photo.value.preview, true);
  const preview = await request(app, `/api/preview/${photo.value.id}`, pc); assert.equal(preview.headers['content-type'], 'image/png'); assert.deepEqual(preview.bytes, png);
  const svg = await request(app, '/api/upload', { ...phone, method: 'POST', body: Buffer.from('<svg onload="alert(1)"></svg>'), headers: { 'X-Recipient': pc.state.self.id, 'X-Filename': 'attack.svg' } }); assert.equal(svg.value.preview, false);
  assert.equal((await request(app, `/api/preview/${photo.value.id}`, phone)).status, 403);
});
test('trusted device reconnects after restart; revocation invalidates cookies, streams and files', async t => {
  const store = { value: emptyVault(), save: async () => {}, flush: async () => {} };
  const { app, pc } = await setup(t, { vaultStore: store }), phone = await pair(app, pc);
  await app.close();
  const restarted = await createApp({ vaultStore: store }); t.after(() => restarted.close()); const newPc = await host(restarted);
  const reconnect = await request(restarted, '/api/connect', { ...phone, method: 'POST', body: {} }); assert.equal(reconnect.status, 200); assert.equal(reconnect.value.self.id, phone.state.self.id);
  const resumed = { ...phone, cookie: `${phone.cookie}; ${cookies(reconnect)}` };
  // Keep only the new session cookie plus the persistent trusted cookie.
  resumed.cookie = `${phone.cookie.split('; ').find(v=>v.startsWith('__Host-flydrop-trust='))}; ${cookies(reconnect)}`;
  await listen(restarted, resumed, t); await listen(restarted, newPc, t);
  const file = await request(restarted, '/api/upload', { ...newPc, method: 'POST', body: Buffer.from('secret'), headers: { 'X-Recipient': phone.state.self.id } }); assert.equal(file.status, 201);
  assert.equal((await request(restarted, '/api/pairing/rotate', { ...resumed, method: 'POST', body: {} })).status, 403);
  assert.equal((await request(restarted, `/api/devices/${phone.state.self.id}/revoke`, { ...newPc, method: 'POST', body: {} })).status, 200);
  assert.equal((await request(restarted, '/api/state', resumed)).status, 401);
  assert.equal((await request(restarted, '/api/connect', { ...resumed, method: 'POST', body: {} })).status, 403);
  assert.equal((await readdir(restarted.directory)).length, 0);
  assert.equal(JSON.stringify(restarted.getState()).includes('tokenHash'), false);
});
test('host/origin guards, connection rate limits, size limits and expiration are enforced', async t => {
  const { app, pc } = await setup(t, { maxFile: 8, ttl: 80 }), phone = await pair(app, pc); await listen(app, pc, t); await listen(app, phone, t);
  assert.equal((await request(app, '/api/state', { cookie: pc.cookie, headers: { Host: `evil.example:${app.port}` } })).status, 403);
  assert.equal((await request(app, '/api/name', { ...pc, method: 'POST', body: { name: 'x' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(app, '/api/name', { ...pc, method: 'POST', body: { name: 'x' }, headers: { Origin: '' } })).status, 403);
  const base = { ...pc, method: 'POST', headers: { 'X-Recipient': phone.state.self.id } };
  assert.equal((await request(app, '/api/text', { ...base, body: { text: ' ' } })).status, 400);
  assert.equal((await request(app, '/api/text', { ...base, body: { text: 'a'.repeat(50001) } })).status, 413);
  assert.equal((await request(app, '/api/upload', { ...base, body: Buffer.alloc(9) })).status, 413);
  const file = await request(app, '/api/upload', { ...base, body: Buffer.from('hello'), headers: { ...base.headers, 'X-Filename': encodeURIComponent('../../bad\nname.txt') } }); assert.equal(file.status, 201); assert.equal(file.value.name, '.._.._bad_name.txt');
  await new Promise(resolve => setTimeout(resolve, 100)); await app.sweep();
  assert.equal((await request(app, `/api/download/${file.value.id}`, phone)).status, 404); assert.equal((await readdir(app.directory)).length, 0);
  for (let i=0;i<5;i++) await request(app, '/api/connect', { method:'POST', remote:true, body:{ code:'wrong' } });
  assert.equal((await request(app, '/api/connect', { method:'POST', remote:true, body:{ code:app.getState().security.pairingCode } })).status, 429);
});
test('interrupted uploads leave no file; shutdown removes its temporary directory', async t => {
  const { app, pc } = await setup(t), phone = await pair(app, pc); await listen(app, phone, t);
  await new Promise(resolve => {
    const req = http.request({ hostname:'127.0.0.1',port:app.port,path:'/api/upload',method:'POST',headers:{ Origin:`http://127.0.0.1:${app.port}`,Cookie:pc.cookie,'Content-Length':100000,'X-Recipient':phone.state.self.id } });
    req.on('error', resolve); req.write(Buffer.alloc(100)); setTimeout(()=>req.destroy(),40);
  });
  await new Promise(resolve=>setTimeout(resolve,60)); assert.equal((await readdir(app.directory)).length,0);
  await app.close(); await assert.rejects(access(app.directory));
});
test('PWA manifest, PNG icons and shell worker are served without embedding credentials', async t => {
  const { app } = await setup(t);
  const manifest = await request(app, '/manifest.webmanifest'); assert.equal(manifest.value.display,'standalone'); assert.equal(manifest.value.start_url,'/');
  for (const icon of manifest.value.icons) { const response=await request(app,icon.src); assert.equal(response.status,200); assert.deepEqual([...response.bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]); }
  assert.equal((await request(app,'/sw.js')).status,200);
});
test('persistent vault refuses missing native protection and corrupted protected data', async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'flydrop-vault-test-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  await assert.rejects(openVault(directory), /нативное/);
  await writeFile(path.join(directory,'vault.safe'),Buffer.from('broken'));
  await assert.rejects(openVault(directory,{encrypt:()=>{throw new Error('not used')},decrypt:()=>{throw new Error('corrupt')}}),/corrupt/);
});
test('clipboard files stream only to the chosen recipient and keep their bytes', async t => {
  const { app, pc } = await setup(t), phone = await pair(app, pc); await listen(app, phone, t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flydrop-local-file-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const note = path.join(directory, 'заметка.txt'); await writeFile(note, 'hello file');
  await assert.rejects(app.sendLocalFiles('', [note]), /Получатель/); assert.equal(app.getState().outbox.length, 0);
  await assert.rejects(app.sendLocalFiles(phone.state.self.id, [directory]), /Папк/);
  await assert.rejects(app.sendLocalFiles(phone.state.self.id, ['note.txt']), /Некорректный файл/);
  await assert.rejects(app.sendLocalFiles(pc.state.self.id, [note]), /это же устройство/);
  await assert.rejects(app.sendLocalFiles(phone.state.self.id, [path.join(directory, 'gone.txt')]), /недоступен/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(app.sendLocalFiles(phone.state.self.id, [note], undefined, controller.signal), /отменена/);
  assert.equal((await readdir(app.directory)).length, 0);
  const items = await app.sendLocalFiles(phone.state.self.id, [note]);
  assert.equal(items[0].name, 'заметка.txt'); assert.equal(items[0].kind, 'file'); assert.equal(items[0].preview, false);
  const download = await request(app, `/api/download/${items[0].id}`, phone); assert.equal(download.status, 200); assert.equal(download.bytes.toString(), 'hello file');
  const png = await readFile(new URL('../public/icons/icon-192.png', import.meta.url));
  const photo = path.join(directory, 'photo.png'); await writeFile(photo, png);
  assert.equal((await app.sendLocalFiles(phone.state.self.id, [photo]))[0].preview, true);
});
test('Windows saving removes path/control/reserved names and never overwrites existing files', async t => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'flydrop-save-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  assert.equal(safeName('../../CON.txt'),'_CON.txt'); assert.ok(!safeName('a\u202etxt.exe').includes('\u202e'));
  const source=path.join(directory,'source'); await writeFile(source,'new'); const folder=path.join(directory,'target');
  const first=await saveIncoming(source,'test.txt',folder); const second=await saveIncoming(source,'test.txt',folder);
  assert.equal(first.name,'test.txt'); assert.equal(second.name,'test (1).txt'); assert.equal(await readFile(first.path,'utf8'),'new');
});
test('incoming auto-save stays off until the host turns the setting on', async t => {
  const { app, pc } = await setup(t);
  assert.equal(pc.state.settings.autoSave, false);
  assert.equal((await request(app, '/api/settings', { method: 'POST', cookie: pc.cookie, body: { autoSave: 'yes' } })).value.settings.autoSave, false);
  const saved = await request(app, '/api/settings', { method: 'POST', cookie: pc.cookie, body: { autoSave: true } });
  assert.equal(saved.status, 200); assert.equal(saved.value.settings.autoSave, true); assert.equal(app.vault.settings.autoSave, true);
});
