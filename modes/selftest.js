import { classifyText, maskText } from './sensitive.js';
import { createHistory } from './history.js';
import { planChunks, createTransfer, CHUNK, MAX_UNLOAD } from './chunks.js';
import { clusterEvents, destination } from './layout.js';
import { partition, reportText, notificationLine } from './report.js';
import { heicPlan, h264Plan, proxyPlan, assertExecutable, LICENSES } from './convert.js';
import { shortcutPlist } from './shortcut.js';
import { sha256Bytes } from '../public/sha256.js';
import { createHash, randomBytes } from 'node:crypto';
import { seal, open } from './box.js';

export async function runSelfTest() {
  const lines = [];
  const check = (name, ok) => { lines.push(`${ok ? 'ok' : 'FAIL'} ${name}`); if (!ok) throw new Error(name); };
  check('otp hidden', classifyText('Код 482193').sensitive && maskText('482193', 'otp') === '•••  •••');
  check('meeting is not a code', !classifyText('Встреча в 14:00, Лесная 9').sensitive);
  const history = createHistory({ now: () => 0 });
  const secret = history.add({ text: 'Пароль: correct-horse', direction: 'from-phone' }, 0);
  check('secret masked', !JSON.stringify(history.list(0)).includes('correct-horse') && secret.sensitive);
  check('secret expires', history.sweep(60_000).includes(secret.id));
  const big = planChunks(2 * 1024 ** 3);
  check('upload lifts 1 GB', big.size > 1024 ** 3 && big.chunkSize === CHUNK && big.size < MAX_UNLOAD);
  const transfer = createTransfer({ size: 10, chunkSize: 4 });
  transfer.accept(0, 4); transfer.accept(2, 2);
  check('resume hole', transfer.missing().join() === '1' && transfer.accept(1, 4).done);
  const groups = clusterEvents([
    { name: 'a', takenAt: 0, lat: 55.75, lon: 37.61 },
    { name: 'b', takenAt: 4 * 3600 * 1000, lat: 55.75, lon: 37.61 },
  ]);
  check('3h splits events', groups.length === 2);
  const placed = destination({ root: 'D:\\Фото', calendar: '2026-10-18', eventName: 'Съёмка «Лесная»', filename: 'IMG_2207.MOV' });
  check('folder layout', placed.parts[2] === 'Оригиналы' && placed.parts[1].includes('2026-10-18'));
  const known = new Set(['a'.repeat(64)]);
  check('dedupe', partition([{ sha256: 'a'.repeat(64), name: 'old' }, { sha256: 'b'.repeat(64), name: 'new' }], known).skip.length === 1);
  check('report', notificationLine({ copied: 195, skipped: 37 }) === 'Скопировано 195, пропущено 37' && reportText({ copied: 195, skipped: 37, verified: 195 }).includes('195 из 195'));
  let threw = false;
  try { assertExecutable('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'); } catch { threw = true; }
  check('no powershell', threw);
  const plan = proxyPlan({ ffmpeg: 'C:\\FlyDrop\\ffmpeg.exe', input: 'a.mov', output: 'a.mov' });
  check('converter is direct', plan.shell === false && h264Plan({ ffmpeg: plan.file, input: 'a.mov', output: 'a.mp4' }).shell === false && heicPlan({ ffmpeg: plan.file, input: 'a.heic', output: 'a.jpg' }).args.includes('-map_metadata'));
  check('licenses named', LICENSES.ffmpeg.startsWith('LGPL') && LICENSES.libheif.startsWith('LGPL'));
  const plist = shortcutPlist({ url: 'https://10.0.0.8:4318/api/buffer/ingest', token: 'a'.repeat(32) });
  check('shortcut posts clipboard', plist.includes('is.workflow.actions.getclipboard') && plist.includes('https://10.0.0.8:4318/api/buffer/ingest') && plist.includes('Bearer '));
  const sample = Buffer.from('flydrop-chunk');
  check('sha256', sha256Bytes(sample) === createHash('sha256').update(sample).digest('hex'));
  const key = randomBytes(32);
  check('history seal', open(key, seal(key, 'pin')).toString() === 'pin');
  return { ok: true, log: lines.join('\n') };
}
