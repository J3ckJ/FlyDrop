import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../src/agent.js';
import { explainReachability, windowsRefusal } from '../src/diag.js';

test('windows node launch says nothing is listening', () => {
  const text = windowsRefusal();
  assert.match(text, /НЕ ЗАПУЩЕН/);
  assert.match(text, /ничего не слушает/);
  assert.match(text, /pult\.exe/);
  assert.doesNotMatch(text, /powershell|netsh|cmd\.exe/i);
});

test('reachability text covers firewall, Kaspersky and the hotspot fallback', () => {
  const text = explainReachability({
    bindHTTPS: '0.0.0.0:4720',
    bindHTTP: '0.0.0.0:4721',
    address: '192.168.1.24',
    adapter: 'Wi-Fi',
    httpPort: 4721,
    probeOK: false,
    probeError: 'connect ECONNREFUSED',
    notes: ['Сеть сейчас общедоступная.'],
  }).join('\n');
  assert.match(text, /0\.0\.0\.0:4720/);
  assert.match(text, /ECONNREFUSED/);
  assert.match(text, /Kaspersky/);
  assert.match(text, /изолирует клиентов/);
  assert.match(text, /Режим модема/);
  assert.match(text, /общедоступная/);
});

test('plain HTTP serves ping and setup and refuses the app', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pult-plain-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const agent = await createAgent({ dataDir, platform: 'mock', name: 'Windows ПК', port: 0, advertise: false, mockOs: 'windows' });
  t.after(() => agent.close());
  assert.match(agent.bound, /^0\.0\.0\.0:\d+$/);
  assert.match(agent.plainBound, /^0\.0\.0\.0:\d+$/);
  assert.notEqual(agent.httpPort, agent.port);
  const ping = await get(`http://127.0.0.1:${agent.httpPort}/ping`);
  assert.equal(ping.status, 200);
  assert.match(ping.body, /^ok/);
  const setup = await get(`http://127.0.0.1:${agent.httpPort}/setup`);
  assert.equal(setup.status, 200);
  assert.match(setup.body, /4721\/setup/);
  const app = await get(`http://127.0.0.1:${agent.httpPort}/app.js`);
  assert.equal(app.status, 404);
});

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}
