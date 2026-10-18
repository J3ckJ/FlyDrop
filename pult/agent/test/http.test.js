import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../src/agent.js';
import { connectPult } from './ws-client.js';

async function agentFor(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pult-http-'));
  const agent = await createAgent({ dataDir, platform: 'mock', name: 'Windows ПК', port: 0, advertise: false, mockOs: 'windows' });
  t.after(async () => { await agent.close(); await rm(dataDir, { recursive: true, force: true }); });
  return agent;
}

function request(agent, route, { method = 'GET', body, headers = {}, cookie = '' } = {}) {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1', port: agent.port, path: route, method, ca: agent.ca, servername: 'localhost', localAddress: '127.0.0.2',
      headers: { Host: `127.0.0.1:${agent.port}`, Origin: `https://127.0.0.1:${agent.port}`, Cookie: cookie, ...(bytes ? { 'Content-Length': bytes.length } : {}), ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        let value = null;
        try { value = JSON.parse(raw.toString('utf8')); } catch { value = null; }
        resolve({ status: response.statusCode, headers: response.headers, raw, value });
      });
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

test('the agent serves the PWA shell and refuses an upload before pairing', async t => {
  const agent = await agentFor(t);
  const page = await request(agent, '/');
  assert.equal(page.status, 200);
  assert.match(page.raw.toString('utf8'), /Пульт/);
  assert.match(page.raw.toString('utf8'), /manifest.webmanifest/);
  const worker = await request(agent, '/sw.js');
  assert.equal(worker.status, 200);
  assert.match(worker.raw.toString('utf8'), /pult-shell/);
  const manifest = await request(agent, '/manifest.webmanifest');
  assert.equal(manifest.value.display, 'standalone');
  assert.equal(manifest.value.share_target.action, '/share');
  const denied = await request(agent, '/api/upload', { method: 'POST', body: Buffer.from('no'), headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'a.txt' } });
  assert.equal(denied.status, 401);
  const key = await request(agent, '/api/push/key');
  assert.equal(key.status, 200);
  assert.ok(key.value.publicKey);
});

test('a paired browser uploads through the agent into FlyDrop', async t => {
  const agent = await agentFor(t);
  const phone = await connectPult(agent);
  t.after(() => phone.close());
  const paired = await phone.request('pair', { code: agent.pairingCode, name: 'iPhone' });
  assert.equal(paired.ok, true);
  const session = await request(agent, '/api/session', { method: 'POST', body: { token: paired.payload.token }, headers: { 'Content-Type': 'application/json' } });
  assert.equal(session.status, 200);
  const cookie = session.headers['set-cookie'][0].split(';')[0];
  const upload = await request(agent, '/api/upload', {
    method: 'POST',
    body: Buffer.from('hello-pult'),
    cookie,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent('заметка.txt') },
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.value));
  assert.equal(upload.value.name, 'заметка.txt');
  const inbox = agent.fly.app.getState().inbox;
  assert.equal(inbox.some(item => item.name === 'заметка.txt' && item.size === 10), true);
  const form = Buffer.concat([
    Buffer.from('--bound\r\nContent-Disposition: form-data; name="file"; filename="shot.png"\r\n\r\n'),
    Buffer.from('png'),
    Buffer.from('\r\n--bound--\r\n'),
  ]);
  const shared = await request(agent, '/share', { method: 'POST', cookie, body: form, headers: { 'Content-Type': 'multipart/form-data; boundary=bound' } });
  assert.equal(shared.status, 303);
  assert.equal(agent.fly.app.getState().inbox.some(item => item.name === 'shot.png'), true);
});
