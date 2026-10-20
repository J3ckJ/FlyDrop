import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createApp } from '../server.js';

const shots = [
  { id: 'i1', selector: '.scr', mask: 'phone' },
  { id: 'i2', selector: '.scr', mask: 'phone' },
  { id: 'i3', selector: '.scr', mask: 'phone' },
  { id: 'i4', selector: '.scr', mask: 'phone' },
  { id: 'i5', selector: '.scr', mask: 'phone' },
  { id: 'i6', selector: '.scr', mask: 'phone' },
  { id: 'w1', selector: '.win', mask: 'none' },
  { id: 'w2', selector: '.win', mask: 'none' },
  { id: 'w3', selector: '.win', mask: 'none' },
  { id: 'w1fly', selector: '.fly', mask: 'none', designId: 'w1_buffer_tray' },
  { id: 'w3toast', selector: '.toast', mask: 'none', designId: 'w3_upload_report' },
  { id: 'm1', selector: '.mac', mask: 'none' },
];
const designIds = { i1: 'i1_buffer', i2: 'i2_backtap_setup', i3: 'i3_buffer_offline', i4: 'i4_upload_pick', i5: 'i5_upload_progress', i6: 'i6_upload_report', w1: 'w1_buffer_tray', w2: 'w2_upload_live', w3: 'w3_upload_report', m1: 'm1_mac_soon' };

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch { /* chrome is still starting */ }
    await wait(100);
  }
  throw new Error('Chrome did not open a debugging port');
}
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) pending.get(message.id)(message);
  });
  return {
    ready,
    send(method, params = {}) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, message => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)));
    },
    close() { ws.close(); },
  };
}
async function shoot(port, url, selector) {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const page = await created.json();
  const client = connect(page.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
  await client.send('Page.navigate', { url });
  await wait(900);
  const rect = await client.send('Runtime.evaluate', { expression: `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const box = node.getBoundingClientRect(); return { x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height }; })()`, returnByValue: true });
  const box = rect.result?.value;
  if (!box) throw new Error(`No ${selector} at ${url}`);
  const clip = { x: box.x, y: box.y, width: Math.round(box.width), height: Math.round(box.height), scale: 1 };
  const shot = await client.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  await fetch(`http://127.0.0.1:${port}/json/close/${page.id}`);
  client.close();
  return PNG.sync.read(Buffer.from(shot.data, 'base64'));
}
function masked(kind, y, height) {
  if (kind !== 'phone') return false;
  return y < 54 || y >= height - 24;
}
function compare(design, ours, kind) {
  const width = Math.min(design.width, ours.width);
  const height = Math.min(design.height, ours.height);
  const side = new PNG({ width: width * 2 + 8, height });
  const diff = new PNG({ width, height });
  let bad = 0;
  let harsh = 0;
  let sum = 0;
  let seen = 0;
  for (let y = 0; y < height; y++) {
    const skip = masked(kind, y, height);
    for (let x = 0; x < width; x++) {
      const di = (y * design.width + x) << 2;
      const oi = (y * ours.width + x) << 2;
      const si = (y * side.width + x) << 2;
      const sj = (y * side.width + width + 8 + x) << 2;
      const delta = Math.abs(design.data[di] - ours.data[oi]) + Math.abs(design.data[di + 1] - ours.data[oi + 1]) + Math.abs(design.data[di + 2] - ours.data[oi + 2]);
      for (let channel = 0; channel < 4; channel++) {
        side.data[si + channel] = design.data[di + channel];
        side.data[sj + channel] = ours.data[oi + channel];
      }
      side.data[si + 3] = 255;
      side.data[sj + 3] = 255;
      const out = (y * width + x) << 2;
      if (skip) {
        diff.data[out] = design.data[di];
        diff.data[out + 1] = design.data[di + 1];
        diff.data[out + 2] = design.data[di + 2];
        diff.data[out + 3] = 255;
        continue;
      }
      seen++;
      sum += delta;
      if (Math.max(Math.abs(design.data[di] - ours.data[oi]), Math.abs(design.data[di + 1] - ours.data[oi + 1]), Math.abs(design.data[di + 2] - ours.data[oi + 2])) > 150) harsh++;
      if (delta > 36) {
        bad++;
        diff.data[out] = 255;
        diff.data[out + 1] = 0;
        diff.data[out + 2] = 80;
        diff.data[out + 3] = 255;
      } else {
        diff.data[out] = ours.data[oi];
        diff.data[out + 1] = ours.data[oi + 1];
        diff.data[out + 2] = ours.data[oi + 2];
        diff.data[out + 3] = 255;
      }
    }
  }
  return { bad, harsh, seen, ratio: seen ? bad / seen : 1, mean: seen ? sum / (seen * 255 * 3) : 1, harshRatio: seen ? harsh / seen : 1, side, diff, width, height };
}

const app = await createApp({ runPlan: null });
const chrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--remote-debugging-port=9333', '--user-data-dir=/tmp/flydrop-chrome', 'about:blank'], { stdio: 'ignore' });
const outDir = path.resolve('preview/compare');
await mkdir(outDir, { recursive: true });
const report = [];
try {
  await waitPort(9333);
  const designPage = `file://${path.resolve('design/v1/index.html')}`;
  for (const shot of shots) {
    const designSelector = shot.id.endsWith('fly') ? '.fly' : shot.id.endsWith('toast') ? '.toast' : shot.selector;
    const designRoot = designIds[shot.id] || shot.designId;
    const designUrl = `${designPage}#${designRoot || ''}`;
    const ours = await shoot(9333, `http://127.0.0.1:${app.port}/?shot=${shot.id}`, shot.selector);
    const design = await shoot(9333, designUrl, `#${designRoot || shot.designId} ${designSelector}`);
    const result = compare(design, ours, shot.mask);
    await writeFile(path.join(outDir, `${shot.id}-side.png`), PNG.sync.write(result.side));
    await writeFile(path.join(outDir, `${shot.id}-diff.png`), PNG.sync.write(result.diff));
    report.push({ id: shot.id, width: result.width, height: result.height, mismatch: Number((result.ratio * 100).toFixed(2)), mean: Number((result.mean * 100).toFixed(3)), harsh: Number((result.harshRatio * 100).toFixed(3)) });
    console.log(`${shot.id} ${result.width}x${result.height} mean ${report.at(-1).mean}% harsh ${report.at(-1).harsh}% mismatch ${report.at(-1).mismatch}%`);
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
} finally {
  await app.close();
  chrome.kill();
}
