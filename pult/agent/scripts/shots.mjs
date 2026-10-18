import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../src/agent.js';

const outDir = path.resolve('pult/preview/shots');
const shots = ['home', 'control', 'trackpad', 'drop', 'now', 'media', 'inbox', 'power', 'lock'];

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'pult-shots-'));
const agent = await createAgent({ dataDir, platform: 'mock', name: 'Windows ПК', mockOs: 'windows', port: 0, advertise: false });
const userData = await mkdtemp(path.join(os.tmpdir(), 'pult-chrome-'));
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--ignore-certificate-errors',
  '--remote-debugging-port=9333', `--user-data-dir=${userData}`, '--window-size=900,980',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });

async function cdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch('http://127.0.0.1:9333/json/version');
      if (list.ok) return list.json();
    } catch { /* chrome is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Chrome не открыл отладку');
}

const version = await cdp();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let seq = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') console.error('PAGE', message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args || []).map(item => item.value || item.description || '').join(' ');
    if (text) console.error('CONSOLE', text);
  }
  const waiter = pending.get(message.id);
  if (waiter) { pending.delete(message.id); waiter(message.result); }
});
function call(method, params = {}, sessionId) {
  const id = ++seq;
  socket.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise(resolve => pending.set(id, resolve));
}
const target = await call('Target.createTarget', { url: 'about:blank' });
const attached = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const sessionId = attached.sessionId;
await call('Page.enable', {}, sessionId);
await call('Runtime.enable', {}, sessionId);
await call('Runtime.setLifecycleEventsEnabled', { enabled: true }, sessionId).catch(() => {});

async function waitFor(expression) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    if (result.result?.value) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const html = await call('Runtime.evaluate', { expression: 'JSON.stringify({href: location.href, html: document.body ? document.body.innerHTML.slice(0, 500) : ""})', returnByValue: true }, sessionId);
  console.error('PAGE STATE', html.result?.value);
  throw new Error(`Не дождались: ${expression}`);
}

async function openShot(name) {
  await call('Page.navigate', { url: `https://127.0.0.1:${agent.port}/?shot=${name}` }, sessionId);
  await waitFor('document.querySelector("[data-digit], .card, .orb, .lock, .cover, .clip, .pad, .sheet, .list")');
  if (await call('Runtime.evaluate', { expression: 'Boolean(document.querySelector("[data-digit]"))', returnByValue: true }, sessionId).then(result => result.result.value)) {
    const code = agent.pairingCode;
    await call('Runtime.evaluate', {
      expression: `(() => { const code = ${JSON.stringify(code)}; document.querySelectorAll('[data-digit]').forEach((input, index) => { input.value = code[index]; input.dispatchEvent(new Event('input', { bubbles: true })); }); return true; })()`,
      returnByValue: true,
    }, sessionId);
    await waitFor('document.querySelector(".card, .orb, .lock, .cover, .clip, .pad, .sheet, .list")');
  }
  await new Promise(resolve => setTimeout(resolve, 350));
  const shot = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
}

for (const name of shots) await openShot(name);

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Ошибка страницы');
  return result.result?.value;
}

const checks = [];
function expect(name, value) {
  checks.push({ name, ok: Boolean(value) });
  if (!value) throw new Error(`Проверка не прошла: ${name}`);
}

await call('Page.navigate', { url: `https://127.0.0.1:${agent.port}/` }, sessionId);
await waitFor('document.querySelector(".card")');
const homeText = await evaluate('document.body.innerText');
expect('главная: поиск', await evaluate('document.querySelector("#search")?.placeholder === "Поиск или команда"'));
expect('главная: MacBook', homeText.includes('MacBook Pro'));
expect('главная: Windows', homeText.includes('Windows'));
expect('главная: mini', homeText.includes('mac-mini'));
expect('главная: управлять', homeText.includes('Управлять'));
expect('главная: задачи', homeText.includes('IMG_2041.jpg') && homeText.includes('Teardrop'));
expect('лоток файла', await evaluate('Boolean(document.querySelector("[data-file]"))'));
await evaluate(`(() => { const input = document.querySelector('#search'); input.value = 'разбудить'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await waitFor('!document.body.innerText.includes("спит 3")');
expect('команда разбудить', await evaluate('!document.body.innerText.includes("спит 3")'));
await evaluate(`(() => { const input = document.querySelector('#search'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await waitFor('document.body.innerText.includes("MacBook Pro") && document.body.innerText.includes("mac-mini")');

await evaluate(`(() => {
  const chip = document.querySelector('[data-file]');
  const card = document.querySelector('.card[data-id="self"]');
  card.scrollIntoView({ inline: 'center' });
  const from = chip.getBoundingClientRect();
  const to = card.getBoundingClientRect();
  const down = { bubbles: true, pointerId: 1, clientX: from.x + 8, clientY: from.y + 8 };
  chip.dispatchEvent(new PointerEvent('pointerdown', down));
  chip.dispatchEvent(new PointerEvent('pointermove', { ...down, clientX: to.x + 30, clientY: to.y + 40 }));
  return document.querySelector('.card.hot')?.dataset.id || '';
})()`);
expect('перетаскивание подсвечивает Windows', await evaluate('document.querySelector(".card.hot")?.dataset.id === "self"'));
await evaluate(`(() => {
  const chip = document.querySelector('[data-file]');
  const card = document.querySelector('.card[data-id="self"]');
  const to = card.getBoundingClientRect();
  chip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: to.x + 30, clientY: to.y + 40 }));
  return true;
})()`);
await evaluate('document.querySelector("[data-tab=inbox]").click()');
await waitFor('document.body.innerText.includes("файл получен") || document.body.innerText.includes("Передача не удалась")');
expect('передача дошла или показала ошибку', await evaluate('document.body.innerText.includes("файл получен") || document.body.innerText.includes("Передача не удалась")'));
await evaluate('document.querySelector("[data-tab=computers]").click()');
await waitFor('document.querySelector(".card[data-id=\\"self\\"] [data-action=control]")');

await evaluate('document.querySelector(".card[data-id=\\"self\\"] [data-action=control]").click()');
await waitFor('document.body.innerText.includes("Клавиатура")');
const controlText = await evaluate('document.body.innerText');
expect('управление: спутники', ['Клавиатура', 'Громкость', 'Приложения', 'Питание', 'экран · 12 кадр/с'].every(part => controlText.includes(part)));
await evaluate('document.querySelector("[data-action=trackpad]").click()');
await waitFor('document.body.innerText.includes("Ctrl")');
expect('тачпад: модификаторы', await evaluate('["Ctrl","Alt","Win","Tab","Esc"].every(key => document.body.innerText.includes(key))'));
await evaluate('document.querySelector("[data-mod=Ctrl]").click()');
expect('тачпад: Ctrl включён', await evaluate('document.querySelector("[data-mod=Ctrl]").classList.contains("on")'));
await evaluate('document.querySelector("[data-action=control]").click()');
await evaluate('document.querySelector("[data-action=media]").click()');
await waitFor('document.body.innerText.includes("Открыть на")');
expect('медиа: Teardrop', await evaluate('document.body.innerText.includes("Teardrop")'));
await evaluate('document.querySelector("[data-action=launch]").click()');
await evaluate('document.querySelector("[data-action=control]").click()');
await waitFor('document.body.innerText.includes("Питание")');
await evaluate('document.querySelector("[data-action=power]").click()');
await waitFor('document.body.innerText.includes("Удерживайте")');
const powerText = await evaluate('document.body.innerText');
expect('питание: сон и удержание', powerText.includes('Сон') && powerText.includes('Блокировка') && powerText.includes('Перезагрузка') && powerText.includes('Удерживайте'));
await evaluate('document.querySelector("[data-action=home]").click()');
await waitFor('document.querySelector("[data-tab=inbox]")');
await evaluate('document.querySelector("[data-tab=inbox]").click()');
await waitFor('document.body.innerText.includes("Вставить на iPhone")');
expect('входящие: буфер', await evaluate('document.body.innerText.includes("ssh://git@mac-mini.local")'));
await evaluate('document.querySelector("[data-tab=scenarios]").click()');
await waitFor('document.body.innerText.includes("Бэкап")');
await evaluate('document.querySelector("[data-action=schedule]").click()');
await evaluate('document.querySelector("[data-action=lock]").click()');
await waitFor('document.body.innerText.includes("Держать на блокировке")');
expect('блокировка: музыка и объяснение', await evaluate('document.body.innerText.includes("Teardrop") && document.body.innerText.includes("Dynamic Island")'));
await evaluate('document.querySelector("[data-action=hold-lock]").click()');
await new Promise(resolve => setTimeout(resolve, 400));
expect('media session', await evaluate('Boolean(navigator.mediaSession && navigator.mediaSession.metadata && navigator.mediaSession.metadata.title)'));
await mkdir(outDir, { recursive: true });
const walked = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
await writeFile(path.join(outDir, 'walk-lock.png'), Buffer.from(walked.data, 'base64'));
await evaluate('document.querySelector("[data-action=scenarios]").click()');
await waitFor('document.querySelector(".caps")');
const caps = await evaluate('JSON.stringify(Object.fromEntries([...document.querySelectorAll(".caps li")].map(item => [item.querySelector("b")?.textContent, item.textContent])))');
await writeFile(path.join(outDir, 'walk.json'), JSON.stringify({ checks, caps: caps ? JSON.parse(caps) : null }, null, 2));
console.log(outDir);
console.log(checks.map(item => item.name).join('\n'));
console.log(caps);
chrome.kill();
await agent.close();
await rm(dataDir, { recursive: true, force: true });
await rm(userData, { recursive: true, force: true });
