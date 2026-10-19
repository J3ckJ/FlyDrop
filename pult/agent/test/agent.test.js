import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../src/agent.js';
import { decodeFrame } from '../src/jpeg.js';
import { connectPult } from './ws-client.js';

async function temporaryAgent(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pult-agent-'));
  const agent = await createAgent({
    dataDir,
    platform: 'mock',
    name: 'Windows ПК',
    mockOs: 'windows',
    port: 0,
    advertise: false,
    flydrop: options.flydrop !== false,
    allowLoopback: true,
    ...options,
    dataDir,
  });
  t.after(async () => {
    await agent.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return agent;
}

function flydropRequest(agent, route, { method = 'GET', body, cookie = '', headers = {} } = {}) {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const secure = route.startsWith('/api/');
  const port = secure ? agent.fly.app.securePort : agent.fly.app.port;
  return new Promise((resolve, reject) => {
    const req = (secure ? https : https).request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      ca: agent.fly.app.material.ca,
      localAddress: '127.0.0.2',
      servername: '127.0.0.1',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `https://127.0.0.1:${port}`,
        Cookie: cookie,
        ...(bytes && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...(bytes ? { 'Content-Length': bytes.length } : {}),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        let value;
        try { value = JSON.parse(raw.toString('utf8')); } catch { value = null; }
        resolve({ status: response.statusCode, headers: response.headers, value, raw });
      });
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

test('an unpaired phone cannot control the computer, and the pairing code is one-time', async t => {
  const agent = await temporaryAgent(t);
  const phone = await connectPult(agent);
  t.after(() => phone.close());
  const hello = await phone.request('hello', { name: 'iPhone' });
  assert.equal(hello.ok, true);
  assert.equal(hello.payload.paired, false);
  assert.equal(hello.payload.flydrop.code, undefined);
  const blocked = await phone.request('input.move', { dx: 10, dy: 0 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /сопряж/);
  const wrong = await phone.request('pair', { code: '000000', name: 'iPhone' });
  assert.equal(wrong.ok, false);
  const paired = await phone.request('pair', { code: agent.pairingCode, name: 'iPhone' });
  assert.equal(paired.ok, true);
  assert.ok(paired.payload.token);
  const reused = await connectPult(agent);
  t.after(() => reused.close());
  const again = await reused.request('pair', { code: '000000' });
  assert.equal(again.ok, false);
  const trusted = await reused.request('hello', { name: 'iPhone', token: paired.payload.token });
  assert.equal(trusted.ok, true);
  assert.equal(trusted.payload.paired, true);
  assert.match(trusted.payload.flydrop.code, /^\d{6}$/);
});

test('trackpad, clipboard, apps and a held shutdown wait for FlyDrop', async t => {
  const agent = await temporaryAgent(t);
  const phone = await connectPult(agent);
  t.after(() => phone.close());
  await phone.request('pair', { code: agent.pairingCode, name: 'iPhone' });
  await phone.request('input.move', { dx: 12, dy: -4 });
  assert.equal(agent.platform.state.cursorX, 92);
  assert.equal(agent.platform.state.cursorY, 41);
  await phone.request('clipboard.set', { text: 'ssh://git@mac-mini.local:2222/eugene/el-workspace.git' });
  const clip = await phone.request('clipboard.get');
  assert.match(clip.payload.text, /mac-mini/);
  const apps = await phone.request('apps.list');
  assert.ok(apps.payload.apps.some(app => app.id === 'Spotify' && app.running));
  await phone.request('apps.launch', { id: 'Xcode' });
  assert.equal(agent.platform.state.apps.find(app => app.id === 'Xcode').running, true);
  await phone.request('media.command', { action: 'pause' });
  assert.equal(agent.platform.state.playing, false);
  await phone.request('flydrop.progress', { name: 'IMG_2041.jpg', loaded: 33 * 1024 * 1024, total: 51 * 1024 * 1024, state: 'uploading' });
  const blocked = await phone.request('power.action', { action: 'shutdown', hold: true });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.payload.performed, false);
  assert.match(blocked.payload.warning, /FlyDrop/);
  assert.equal(agent.platform.state.calls.some(call => call[0] === 'power'), false);
  const off = await phone.request('power.action', { action: 'shutdown', hold: true, force: true });
  assert.equal(off.payload.performed, true);
  assert.equal(agent.platform.state.asleep, true);
});

test('screen preview sends a jpeg frame at the requested pace', async t => {
  const agent = await temporaryAgent(t, { flydrop: false });
  const phone = await connectPult(agent);
  t.after(() => phone.close());
  await phone.request('pair', { code: agent.pairingCode, name: 'iPhone' });
  const subscribed = await phone.request('screen.subscribe', { fps: 8 });
  assert.equal(subscribed.payload.fps, 8);
  const frame = await phone.waitFor(message => message.kind === 'binary');
  const decoded = decodeFrame(frame.value);
  assert.equal(decoded.width, 160);
  assert.equal(decoded.jpeg[0], 0xff);
  await phone.request('screen.unsubscribe');
});

test('a schedule wakes the computer once at the chosen minute', async t => {
  const sent = [];
  let clock = new Date(2026, 9, 18, 2, 59, 30);
  const agent = await temporaryAgent(t, { flydrop: false, now: () => clock, wake: async mac => { sent.push(mac); } });
  const phone = await connectPult(agent);
  t.after(() => phone.close());
  await phone.request('pair', { code: agent.pairingCode, name: 'iPhone' });
  const saved = await phone.request('wol.schedule.put', { mac: 'b8:27:eb:00:00:01', label: 'Бэкап', hour: 3, minute: 0 });
  assert.equal(saved.payload.schedule.label, 'Бэкап');
  await agent.tickSchedules();
  assert.deepEqual(sent, []);
  clock = new Date(2026, 9, 18, 3, 0, 5);
  await agent.tickSchedules();
  await agent.tickSchedules();
  assert.deepEqual(sent, ['b8:27:eb:00:00:01']);
});

test('paired phone uploads a file through the embedded FlyDrop receiver', async t => {
  const agent = await temporaryAgent(t);
  const phone = await connectPult(agent);
  t.after(() => phone.close());
  const paired = await phone.request('pair', { code: agent.pairingCode, name: 'iPhone' });
  assert.equal(paired.ok, true);
  const info = paired.payload.flydrop;
  assert.equal(info.external, false);
  const pending = await flydropRequest(agent, '/api/connect', {
    method: 'POST',
    body: { code: info.code, name: 'iPhone', type: 'phone' },
  });
  assert.equal(pending.status, 202, JSON.stringify(pending.value));
  const cookie = pending.headers['set-cookie']?.map(value => value.split(';')[0]).join('; ') || '';
  let ready;
  for (let attempt = 0; attempt < 20; attempt++) {
    ready = await flydropRequest(agent, '/api/pair-status', { method: 'POST', body: pending.value, cookie });
    if (ready.status === 200) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(ready.status, 200, JSON.stringify(ready.value));
  const session = ready.headers['set-cookie']?.map(value => value.split(';')[0]).join('; ') || '';
  const hostId = agent.fly.info().hostId;
  const upload = await flydropRequest(agent, '/api/upload', {
    method: 'POST',
    body: Buffer.from('jpeg-bytes'),
    cookie: session,
    headers: { 'X-Recipient': hostId, 'X-Filename': encodeURIComponent('IMG_2041.jpg'), 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.value));
  assert.equal(upload.value.name, 'IMG_2041.jpg');
  assert.equal(upload.value.size, 10);
});
