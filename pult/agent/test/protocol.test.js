import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { encodeJPEG, decodeFrame, encodeFrame } from '../src/jpeg.js';
import { buildAnnouncement } from '../src/mdns.js';
import { isAllowedPeer } from '../src/net.js';
import { parseMessage } from '../src/protocol.js';
import { magicPacket } from '../src/wol.js';
import { zipStore } from '../src/zip-store.js';

test('protocol accepts a pairing message and rejects shutdown without a hold', () => {
  const ok = parseMessage(JSON.stringify({ v: 1, id: '1', type: 'pair', payload: { code: '123456', name: 'iPhone' } }));
  assert.equal(ok.message.type, 'pair');
  const held = parseMessage(JSON.stringify({ v: 1, id: '2', type: 'power.action', payload: { action: 'shutdown' } }));
  assert.match(held.error, /удержанием/);
  const forced = parseMessage(JSON.stringify({ v: 1, id: '3', type: 'power.action', payload: { action: 'shutdown', hold: true, force: true } }));
  assert.equal(forced.message.payload.force, true);
  assert.match(parseMessage(JSON.stringify({ v: 2, type: 'hello', payload: {} })).error, /верси/);
  assert.match(parseMessage(JSON.stringify({ v: 1, type: 'shell', payload: { cmd: 'whoami' } })).error, /Неизвестная/);
  assert.match(parseMessage('not-json').error, /Некорректное/);
});

test('wake packet is six 0xff bytes and sixteen copies of the MAC', () => {
  const packet = magicPacket('00:11:22:33:44:55');
  assert.equal(packet.length, 102);
  assert.ok(packet.subarray(0, 6).every(byte => byte === 0xff));
  for (let repeat = 0; repeat < 16; repeat++) assert.deepEqual([...packet.subarray(6 + repeat * 6, 12 + repeat * 6)], [0, 17, 34, 51, 68, 85]);
  assert.throws(() => magicPacket('not-a-mac'), /MAC/);
});

test('remote control is refused outside the local network', () => {
  assert.equal(isAllowedPeer('192.168.1.20'), true);
  assert.equal(isAllowedPeer('10.1.2.3'), true);
  assert.equal(isAllowedPeer('172.16.0.4'), true);
  assert.equal(isAllowedPeer('172.32.0.4'), false);
  assert.equal(isAllowedPeer('8.8.8.8'), false);
  assert.equal(isAllowedPeer('100.64.0.1'), false);
  assert.equal(isAllowedPeer('127.0.0.2'), true);
  assert.equal(isAllowedPeer('::1'), true);
  assert.equal(isAllowedPeer('8.8.8.8', { allowLoopback: true }), false);
});

test('mDNS announcement names the Pult service and omits the pairing code', () => {
  const packet = buildAnnouncement({
    instance: 'Windows PC',
    host: 'pult.local',
    port: 4720,
    addresses: ['192.168.1.5'],
    txt: { os: 'windows', ver: '1', fp: 'abcd', fly: '4318' },
  });
  const text = packet.toString('utf8');
  assert.ok(packet.includes(Buffer.from('_pult')));
  assert.ok(packet.includes(Buffer.from('_tcp')));
  assert.match(text, /Windows PC/);
  assert.equal(text.includes('code='), false);
  assert.ok(packet.includes(Buffer.from([192, 168, 1, 5])));
});

test('a folder becomes a zip and refuses paths that escape it', () => {
  const zip = zipStore([{ name: 'notes/a.txt', data: Buffer.from('hello') }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.includes(Buffer.from('notes/a.txt')));
  assert.throws(() => zipStore([{ name: '../secret', data: Buffer.from('x') }]), /путь/);
  assert.throws(() => zipStore([]), /пустая/);
  assert.throws(() => zipStore([{ name: 'a', data: Buffer.alloc(8) }], { maxBytes: 4 }), /1 ГБ/);
});

test('jpeg frames round-trip and ffmpeg can decode the picture', async () => {
  const width = 16;
  const height = 16;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = i % 2 ? 220 : 10;
    rgba[i * 4 + 1] = 40;
    rgba[i * 4 + 2] = 30;
    rgba[i * 4 + 3] = 255;
  }
  const jpeg = encodeJPEG(rgba, width, height, 80);
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  assert.equal(jpeg.at(-2), 0xff);
  assert.equal(jpeg.at(-1), 0xd9);
  const frame = encodeFrame(jpeg, { seq: 3, width, height });
  const decoded = decodeFrame(frame);
  assert.equal(decoded.seq, 3);
  assert.equal(decoded.jpeg.length, jpeg.length);
  const raw = await ffmpegRaw(jpeg);
  assert.equal(raw.length, width * height * 3);
  assert.ok(raw[0] < 40, `тёмный пиксель ${raw[0]}`);
  assert.ok(raw[3] > 150, `светлый пиксель ${raw[3]}`);
});

function ffmpegRaw(jpeg) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(Buffer.concat(err).toString('utf8') || `ffmpeg ${code}`));
      else resolve(Buffer.concat(out));
    });
    child.stdin.end(jpeg);
  });
}

test('temporary directories for later tests can be removed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pult-smoke-'));
  await rm(directory, { recursive: true, force: true });
});
