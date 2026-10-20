import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { classifyText, maskText } from '../modes/sensitive.js';
import { createHistory } from '../modes/history.js';
import { planChunks, createTransfer, CHUNK } from '../modes/chunks.js';
import { clusterEvents, destination, safeSegment } from '../modes/layout.js';
import { partition, reportText } from '../modes/report.js';
import { heicPlan, h264Plan, proxyPlan, assertExecutable, spawnPlan } from '../modes/convert.js';
import { shortcutPlist } from '../modes/shortcut.js';
import { sha256Bytes } from '../public/sha256.js';
import { seal, open } from '../modes/box.js';
import { runSelfTest } from '../modes/selftest.js';

test('sensitive text is masked and ordinary notes are not', () => {
  assert.equal(classifyText('Код 482193').kind, 'otp');
  assert.equal(classifyText('482193').sensitive, true);
  assert.equal(classifyText('Пароль: hunter2').kind, 'password');
  assert.equal(classifyText('https://frame.io/review/sc-04-v3').kind, 'link');
  assert.equal(classifyText('https://frame.io/review/sc-04-v3').sensitive, false);
  assert.equal(classifyText('Встреча с монтажёром перенесена на четверг, 14:00, Лесная 9, студия 3').sensitive, false);
  assert.equal(maskText('482193', 'otp'), '•••  •••');
  assert.match(maskText('hunter2', 'password'), /^•+$/);
});

test('clipboard history expires, pins stay, secrets are sealed', () => {
  let now = 1_000_000;
  const key = randomBytes(32);
  const history = createHistory({ now: () => now });
  const note = history.add({ text: 'Лесная 9, студия 3', direction: 'to-phone', status: 'waiting' }, now);
  const code = history.add({ text: 'Код из SMS 482193', direction: 'from-phone' }, now);
  assert.equal(JSON.stringify(history.list()).includes('482193'), false);
  assert.equal(history.reveal(code.id).text.includes('482193'), true);
  history.pin(note.id, true, now);
  now += 61_000;
  assert.equal(history.sweep(now).includes(code.id), true);
  assert.equal(history.list().some(item => item.id === note.id), true);
  now += 2 * 3600 * 1000;
  assert.equal(history.list().some(item => item.id === note.id), true);
  const saved = history.exportPersisted(key);
  assert.equal(JSON.stringify(saved).includes('482193'), false);
  const again = createHistory({ now: () => now });
  again.importPersisted(saved, key);
  assert.equal(again.reveal(note.id).text, 'Лесная 9, студия 3');
  const pinnedSecret = history.add({ text: 'Пароль: hunter2', direction: 'from-phone' }, now);
  history.pin(pinnedSecret.id, true, now);
  const sealed = history.exportPersisted(key);
  assert.equal(JSON.stringify(sealed).includes('hunter2'), false);
  assert.equal(open(key, sealed.find(item => item.id === pinnedSecret.id).sealed).toString(), 'Пароль: hunter2');
});

test('chunks resume after a hole and files over 1 GB are allowed', () => {
  assert.equal(planChunks(0).count, 1);
  assert.ok(planChunks(2 * 1024 ** 3).count > 1);
  assert.equal(CHUNK, 16 * 1024 * 1024);
  const transfer = createTransfer({ size: 10, chunkSize: 4 });
  assert.deepEqual(transfer.accept(0, 4).missing, [1, 2]);
  assert.equal(transfer.accept(2, 2).done, false);
  assert.deepEqual(transfer.missing(), [1]);
  assert.equal(transfer.accept(1, 4).done, true);
  assert.throws(() => transfer.accept(1, 3), /Размер части/);
  assert.throws(() => planChunks(65 * 1024 ** 3), /64 ГБ/);
});

test('events, folders and duplicate hashes', () => {
  const hour = 3600 * 1000;
  const groups = clusterEvents([
    { name: 'IMG_2040.HEIC', takenAt: 0, lat: 55.7, lon: 37.6, eventName: '' },
    { name: 'IMG_2041.HEIC', takenAt: 20 * 60 * 1000, lat: 55.7, lon: 37.6 },
    { name: 'IMG_2207.MOV', takenAt: 5 * hour, lat: 59.9, lon: 30.3, eventName: 'Съёмка «Лесная»' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[1].name, 'Съёмка «Лесная»');
  const file = destination({ root: '/photos', calendar: '2026-10-18', eventName: 'Съёмка «Лесная»', bucket: 'proxy', filename: '../IMG_2207.MOV' });
  assert.equal(file.parts.at(-1).includes('/'), false);
  assert.equal(file.parts[2], 'Proxy');
  assert.equal(safeSegment('a/../../b'), 'a .. .. b');
  const hash = 'ab'.repeat(32);
  const { accept, skip } = partition([{ sha256: hash, name: 'a' }, { sha256: hash, name: 'b' }, { sha256: 'cd'.repeat(32), name: 'c' }, { sha256: 'nope', name: 'd' }], new Set([hash]));
  assert.equal(skip.length, 3);
  assert.equal(accept.length, 1);
  assert.match(reportText({ copied: 195, skipped: 37, errors: 0, verified: 195, resumes: ['IMG_2207.MOV с 3,4 ГБ'] }), /Скопировано 195/);
});

test('converters never go through a shell or PowerShell', () => {
  assert.throws(() => assertExecutable('powershell.exe'));
  assert.throws(() => assertExecutable('C:\\Windows\\System32\\cmd.exe'));
  const plan = heicPlan({ heif: '/opt/flydrop/heif-convert', input: 'a.heic', output: 'a.jpg' });
  assert.equal(plan.shell, false);
  assert.deepEqual(plan.args, ['a.heic', 'a.jpg']);
  const video = h264Plan({ ffmpeg: '/opt/flydrop/ffmpeg', input: 'a.mov', output: 'a.mp4', encoder: 'h264_mf' });
  assert.equal(video.args.includes('h264_mf'), true);
  assert.equal(video.args.includes('-map_metadata'), true);
  const proxy = proxyPlan({ ffmpeg: '/opt/flydrop/ffmpeg', input: 'a.mov', output: 'a_proxy.mov' });
  assert.equal(proxy.args.includes('prores_ks'), true);
  assert.equal(proxy.args.includes('scale=-2:1080'), true);
  const calls = [];
  spawnPlan((file, args, options) => calls.push({ file, args, options }), plan);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.throws(() => spawnPlan(() => {}, { file: 'ffmpeg', args: [], shell: true }));
});

test('shortcut is a clipboard POST and sha256 matches node', () => {
  const plist = shortcutPlist({ url: 'https://192.168.1.20:4318/api/buffer/ingest', token: 'abcXYZ_0123456789abcdef' });
  assert.match(plist, /is\.workflow\.actions\.getclipboard/);
  assert.match(plist, /is\.workflow\.actions\.downloadurl/);
  assert.match(plist, /POST/);
  assert.match(plist, /Bearer abcXYZ_0123456789abcdef/);
  assert.doesNotMatch(plist, /PRIVATE KEY|powershell/i);
  assert.throws(() => shortcutPlist({ url: 'http://10.0.0.1/api/buffer/ingest', token: 'abcXYZ_0123456789abcdef' }));
  const bytes = randomBytes(200);
  assert.equal(sha256Bytes(bytes), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(sha256Bytes(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const hasher = sha256Bytes(Buffer.concat([bytes.subarray(0, 80), bytes.subarray(80)]));
  assert.equal(hasher, createHash('sha256').update(bytes).digest('hex'));
});

test('startup self-test passes', async () => {
  const report = await runSelfTest();
  assert.equal(report.ok, true);
  assert.match(report.log, /ok shortcut posts clipboard/);
});
