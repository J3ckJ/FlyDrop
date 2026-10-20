import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { PNG } from 'pngjs';
import { createApp } from '../server.js';

const notes = [];
const note = text => { notes.push(text); console.log('•', text); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function socks() {
  let tunneled = 0;
  const server = net.createServer(client => {
    client.on('error', () => {});
    let buffer = Buffer.alloc(0);
    let stage = 'greet';
    const refuse = () => {
      try { client.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); } catch { /* already gone */ }
      client.destroy();
    };
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greet') {
        if (buffer.length < 2) return;
        const methods = buffer[1];
        if (buffer.length < 2 + methods) return;
        buffer = buffer.subarray(2 + methods);
        stage = 'request';
        try { client.write(Buffer.from([5, 0])); } catch { client.destroy(); return; }
      }
      if (stage !== 'request' || buffer.length < 4 || buffer[1] !== 1) { if (buffer.length >= 4 && buffer[1] !== 1) refuse(); return; }
      const atyp = buffer[3];
      let offset = 4;
      let host = '';
      if (atyp === 1) {
        if (buffer.length < 10) return;
        host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
        offset = 8;
      } else if (atyp === 3) {
        if (buffer.length < 5) return;
        const length = buffer[4];
        if (buffer.length < 5 + length + 2) return;
        host = buffer.subarray(5, 5 + length).toString();
        offset = 5 + length;
      } else { refuse(); return; }
      if (buffer.length < offset + 2) return;
      const port = buffer.readUInt16BE(offset);
      const rest = buffer.subarray(offset + 2);
      stage = 'tunnel';
      client.pause();
      client.off('data', onData);
      if (host !== '127.0.0.1' && host !== 'localhost') { refuse(); return; }
      const remote = net.connect({ host: '127.0.0.1', port, localAddress: '127.0.0.2' });
      const fail = () => { remote.destroy(); refuse(); };
      remote.on('error', fail);
      remote.on('connect', () => {
        tunneled += 1;
        remote.off('error', fail);
        remote.on('error', () => client.destroy());
        client.on('error', () => remote.destroy());
        try { client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 2, 0, 0])); } catch { remote.destroy(); return; }
        if (rest.length) remote.write(rest);
        remote.pipe(client);
        client.pipe(remote);
        client.resume();
      });
    };
    client.on('data', onData);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits: () => tunneled })));
}
function request(port, route, { method = 'GET', cookie = '', body, headers = {} } = {}) {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { Origin: `http://127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}), ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
    });
    req.on('error', reject);
    req.end(bytes);
  });
}
async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) return; } catch { /* starting */ }
    await wait(100);
  }
  throw new Error(`chrome ${port} did not start`);
}
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) pending.get(message.id)(message); });
  return { ready, send(method, params = {}) { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, message => message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result))); }, close() { ws.close(); } };
}
async function page(debugPort, url, metrics) {
  const created = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
  const client = connect(created.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  if (metrics) await client.send('Emulation.setDeviceMetricsOverride', metrics);
  await client.send('Page.navigate', { url });
  await wait(1200);
  return client;
}
async function evalJson(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
  return result.result?.value;
}
const bodyText = client => evalJson(client, 'document.body.innerText');
async function clickReal(client, selector) {
  const box = await evalJson(client, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); if (style.display === 'none' || rect.width < 1 || rect.height < 1) return null; return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`);
  if (!box) return false;
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return true;
}
async function click(client, selector) {
  return evalJson(client, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; const style = getComputedStyle(node); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false; const rect = node.getBoundingClientRect(); if (rect.width < 1 || rect.height < 1) return false; node.click(); return true; })()`);
}
async function shot(client, file) {
  const png = await client.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(file, Buffer.from(png.data, 'base64'));
}

const app = await createApp({ runPlan: null });
const proxy = await socks();
const hostChrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--disable-background-networking', '--remote-debugging-port=9335', '--user-data-dir=/tmp/flydrop-host-walk', 'about:blank'], { stdio: 'ignore' });
const phoneChrome = spawn('google-chrome', ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--ignore-certificate-errors', '--disable-background-networking', `--proxy-server=socks5://127.0.0.1:${proxy.port}`, '--proxy-bypass-list=<-loopback>', '--remote-debugging-port=9334', '--user-data-dir=/tmp/flydrop-phone-walk', 'about:blank'], { stdio: 'ignore' });
const dir = path.resolve('preview/walkthrough');
await mkdir(dir, { recursive: true });
try {
  await waitPort(9335);
  await waitPort(9334);
  const hostApi = await request(app.port, '/api/connect', { method: 'POST', body: {}, headers: { 'X-FlyDrop-Desktop': app.desktopKey } });
  const hostCookie = hostApi.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const link = new URL(app.browserLink());
  link.search = 'ui=win';
  const host = await page(9335, link.href, { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  await wait(800);
  if (await click(host, '#onboarding-skip')) note('На Windows первым экраном было обучение. Кнопка «Настрою позже» сработала.');
  else note('Обучение на Windows не перекрыло экран.');
  const pairKey = new URL(app.getState().links[0].url).hash.slice(1).split('=')[1];
  const phone = await page(9334, `https://127.0.0.1:${app.securePort}/?ui=phone#pair=${pairKey}`, { width: 393, height: 852, deviceScaleFactor: 1, mobile: true });
  await wait(1500);
  let phoneText = await bodyText(phone);
  note(`Телефон через прокси: ${proxy.hits()} туннелей.`);
  if (phoneText.includes('Откройте Windows-приложение')) note('Телефон снова принят за сам компьютер: страница просит открыть Windows-приложение.');
  if (!phoneText.includes('Подтвердите') && !phoneText.includes('Буфер')) note(`Телефон открылся не с запросом доступа: ${phoneText.slice(0, 180)}`);
  for (let i = 0; i < 10; i++) {
    const requests = app.getState().security.requests || [];
    if (requests[0]) {
      const approved = await request(app.port, `/api/pairings/${requests[0].id}/approve`, { method: 'POST', cookie: hostCookie, body: { remember: true } });
      if (approved.status !== 200) note(`Разрешение с компьютера вернуло ${approved.status}`);
      break;
    }
    await wait(300);
  }
  for (let i = 0; i < 40; i++) {
    phoneText = await bodyText(phone);
    if (phoneText.includes('Буфер') && phoneText.includes('Выгрузка') && !phoneText.includes('Давайте подключимся')) break;
    await wait(500);
  }
  if (await click(phone, '#onboarding-skip')) note('На iPhone обучение тоже встало поверх буфера. Пропуск есть, но новый человек его ищет.');
  await evalJson(phone, `location.hash='#buffer'`);
  await wait(400);
  const composed = await evalJson(phone, `(() => { const field = document.querySelector('#buffer-compose'); if (!field) return 'no-field'; field.value = 'Лесная 9, студия 3'; field.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
  if (composed !== 'ok') note('На пустом буфере не было поля, чтобы отправить текст без «Поделиться».');
  else {
    await click(phone, '#buffer-send');
    await wait(1200);
    const hostBody = await bodyText(host);
    if (!hostBody.includes('Лесная 9')) note('Текст с iPhone не появился в окне Windows, пока открыт другой раздел.');
    else note('Текст с телефона виден на Windows, даже если открыт другой раздел.');
  }
  await evalJson(host, `location.hash='#buffer'`);
  await wait(300);
  await evalJson(host, `(() => { const field = document.querySelector('#buffer-host-compose'); field.value = 'Встреча перенесена на четверг'; field.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await click(host, '#buffer-send-host');
  await wait(1200);
  await evalJson(phone, `location.hash='#buffer'`);
  await wait(400);
  const phoneAfter = await bodyText(phone);
  if (!phoneAfter.includes('Скопировать на iPhone')) note('С компьютера текст не стал карточкой «Скопировать на iPhone».');
  else {
    const pressed = await clickReal(phone, '#buffer-copy');
    await wait(200);
    const copied = pressed ? await evalJson(phone, `document.querySelector('#copy-dialog')?.open ? 'dialog' : 'direct'`) : 'missing';
    if (copied === 'dialog') {
      note('Запасной диалог «Скопируйте текст» открылся, потому что браузер запретил буфер. На iPhone по нажатию копирование идёт сразу.');
      await evalJson(phone, `document.querySelector('#copy-dialog')?.close()`);
    } else if (copied === 'direct') note('Карточка «Скопировать на iPhone» копирует одним нажатием.');
    else note('Кнопки «Скопировать на iPhone» не было на экране.');
  }
  await evalJson(phone, `(() => { const field = document.querySelector('#buffer-compose'); if (!field) return false; field.value = 'Код 482193'; field.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  if (await click(phone, '#buffer-send')) {
    await wait(500);
    const hidden = await bodyText(host);
    if (hidden.includes('482193')) note('Код из SMS попал в список открытым текстом.');
    else note('Код из SMS на Windows скрыт.');
  } else note('После входящей карточки поле отправки спряталось, и код пришлось бы слать только из «Поделиться».');
  if (await click(phone, '#buffer-setup')) {
    await wait(200);
    const setup = await bodyText(phone);
    if (!setup.includes('не может слушать') && !setup.includes('PWA не может')) note('Экран стука не говорит прямо, что страница стук не слышит.');
    await click(phone, '#buffer-shortcut');
    await wait(400);
    note('Кнопка «Добавить команду» скачивает FlyDrop.shortcut. На localhost предупреждение про Wi-Fi IP есть.');
  }
  await evalJson(phone, `location.hash='#buffer'`);
  await wait(200);
  await click(phone, '#buffer-setup');
  await wait(100);
  const back = await click(phone, '.botb .btn.dark');
  if (!back) note('С экрана настройки стука нельзя было вернуться одной кнопкой.');
  await clientOffline(phone);
  await evalJson(phone, `(() => { const field = document.querySelector('#buffer-compose'); if (!field) return false; field.value = 'https://disk.studio/sc-05'; field.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await click(phone, '#buffer-send');
  await wait(1200);
  const queued = await bodyText(phone);
  if (!queued.includes('Очередь')) note('Без сети текст не встал в очередь на экране.');
  else note('Без сети текст остаётся в очереди на экране.');
  await phone.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click(phone, '#buffer-retry');
  await wait(800);
  const flushed = await bodyText(host);
  if (!flushed.includes('disk.studio')) note('После «Проверить связь» очередь не ушла на компьютер.');
  else note('Очередь ушла, когда связь вернулась.');
  const sample = path.resolve(dir, 'IMG_2042.jpg');
  await writeFile(sample, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await evalJson(phone, `location.hash='#upload'`);
  await wait(400);
  const uploadText = await bodyText(phone);
  if (!uploadText.includes('новее') && !uploadText.includes('медиатеку')) note('Экран выгрузки не объясняет, что медиатеку PWA не читает.');
  await phone.send('DOM.enable');
  const doc = await phone.send('DOM.getDocument');
  const input = await phone.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#unload-input' });
  await phone.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [sample] });
  await wait(1500);
  const report = await bodyText(phone);
  if (!report.includes('Скопировано')) note(`Отчёт выгрузки не показался: ${report.slice(0, 240)}`);
  else note('Первый файл доехал, отчёт «Скопировано» на телефоне.');
  await shot(phone, path.join(dir, 'phone-upload.png'));
  await evalJson(phone, `location.hash='#upload'`);
  await wait(200);
  if (await click(phone, '#unload-done')) await wait(200);
  const doc2 = await phone.send('DOM.getDocument');
  const input2 = await phone.send('DOM.querySelector', { nodeId: doc2.root.nodeId, selector: '#unload-input' });
  if (input2.nodeId) {
    await phone.send('DOM.setFileInputFiles', { nodeId: input2.nodeId, files: [sample] });
    await wait(1200);
    const again = await bodyText(phone);
    if (!again.includes('пропущено 1') && !again.includes('Пропущено 1')) note(`Повтор того же файла не показал пропуск: ${again.slice(0, 200)}`);
    else note('Повторный файл пропущен как дубль.');
  }
  await evalJson(host, `location.hash='#upload'`);
  await wait(400);
  const toggled = await evalJson(host, `(() => { const button = [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === 'HEIC → JPG рядом'); if (!button) return 'no-toggle'; button.click(); return button.getAttribute('aria-pressed'); })()`);
  if (toggled === 'no-toggle') note('На Windows не нашёлся переключатель HEIC → JPG.');
  else note('Переключатели выгрузки на Windows нажимаются.');
  await evalJson(phone, `document.querySelector('dialog[open]')?.close(); location.hash='#buffer'`);
  await wait(500);
  await shot(phone, path.join(dir, 'phone-buffer.png'));
  await shot(host, path.join(dir, 'windows-upload.png'));
  await evalJson(host, `location.hash='#buffer'`);
  await wait(300);
  await shot(host, path.join(dir, 'windows-buffer.png'));
  await writeFile(path.join(dir, 'notes.json'), JSON.stringify(notes, null, 2));
  host.close();
  phone.close();
} finally {
  proxy.server.close();
  hostChrome.kill();
  phoneChrome.kill();
  await app.close();
}

async function clientOffline(client) {
  await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
}
