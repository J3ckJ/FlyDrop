import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { mobileProfile } from '../../../security.js';
import { LIMITS } from './protocol.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/setup', ['setup.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/net.js', ['net.js', 'text/javascript; charset=utf-8']],
  ['/experiments.js', ['experiments.js', 'text/javascript; charset=utf-8']],
  ['/zip.js', ['zip.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/icons/icon-192.png', ['icons/icon-192.png', 'image/png']],
  ['/icons/icon-512.png', ['icons/icon-512.png', 'image/png']],
  ['/icons/apple-touch-icon.png', ['icons/apple-touch-icon.png', 'image/png']],
]);

function fault(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function cookie(req, name) {
  return req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

async function readJSON(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw fault(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw fault(400, 'Некорректный запрос'); }
}

function sameOrigin(req) {
  const host = req.headers.host || '';
  const origin = `https://${host}`;
  if (req.headers.origin && req.headers.origin !== origin) throw fault(403, 'Запрос с другого сайта запрещён');
  if (req.method === 'POST' && req.headers.origin !== origin) throw fault(403, 'Требуется приложение Пульт');
}

function fileName(header) {
  let name = 'file';
  try { name = decodeURIComponent(header || 'file'); } catch { throw fault(400, 'Некорректное имя файла'); }
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(-180);
  return name || 'file';
}

function splitMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw fault(400, 'Нет границы формы');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const files = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor >= 0) {
    const next = buffer.indexOf(boundary, cursor + boundary.length);
    if (next < 0) break;
    const part = buffer.subarray(cursor + boundary.length, next);
    const split = part.indexOf('\r\n\r\n');
    if (split > 0) {
      const head = part.subarray(0, split).toString('utf8');
      const name = /filename="([^"]*)"/.exec(head)?.[1] || /name="([^"]*)"/.exec(head)?.[1];
      if (name && /filename=/.test(head)) {
        let data = part.subarray(split + 4);
        if (data.subarray(-2).equals(Buffer.from('\r\n'))) data = data.subarray(0, -2);
        files.push({ name, data });
      }
    }
    cursor = next;
  }
  return files;
}

export function createHttpHandler(ctx) {
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
      const staticFile = req.method === 'GET' ? STATIC.get(url.pathname) : undefined;
      if (staticFile) {
        const body = await readFile(path.join(WEB, staticFile[0]));
        res.writeHead(200, { 'Content-Type': staticFile[1], 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ca.cer') {
        res.writeHead(200, { 'Content-Type': 'application/pkix-cert', 'Content-Disposition': 'attachment; filename="Pult.cer"' });
        res.end(ctx.material.ca);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/certificate.mobileconfig') {
        const profile = mobileProfile(ctx.material, ctx.hostId);
        res.writeHead(200, { 'Content-Type': 'application/x-apple-aspen-config', 'Content-Disposition': 'attachment; filename="Pult.mobileconfig"' });
        res.end(profile);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/push/key') {
        json(res, 200, { publicKey: ctx.push.publicKey });
        return;
      }
      if (req.method === 'POST' && (url.pathname === '/api/session' || url.pathname === '/api/push/subscribe' || url.pathname === '/api/upload' || url.pathname === '/share')) {
        sameOrigin(req);
      }
      if (req.method === 'POST' && url.pathname === '/api/session') {
        const body = await readJSON(req);
        const device = ctx.authorize(body.token);
        if (!device) throw fault(401, 'Сначала введите код с компьютера');
        res.setHeader('Set-Cookie', `__Host-pult-session=${body.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`);
        json(res, 200, { ok: true, name: device.name });
        return;
      }
      const device = ctx.authorize(cookie(req, '__Host-pult-session'));
      if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
        if (!device) throw fault(401, 'Сначала сопряжение');
        json(res, 200, await ctx.push.subscribe(device.id, await readJSON(req)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        if (!device) throw fault(401, 'Сначала сопряжение');
        if (!ctx.fly?.upload) throw fault(409, 'FlyDrop уже запущен отдельно. Остановите его, чтобы Пульт принял файл, или подтвердите телефон в окне FlyDrop.');
        const size = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(size) || size < 0) throw fault(411, 'Неизвестен размер файла');
        if (size > LIMITS.maxFileBytes) throw fault(413, 'Файл превышает 1 ГБ');
        const saved = await ctx.fly.upload(fileName(req.headers['x-filename']), size, req);
        json(res, 201, saved);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/share') {
        if (!device) throw fault(401, 'Сначала откройте Пульт и введите код');
        if (!ctx.fly?.upload) throw fault(409, 'FlyDrop уже запущен отдельно. Пульт не может принять файл сам.');
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > LIMITS.maxFileBytes) throw fault(413, 'Файл превышает 1 ГБ');
          chunks.push(chunk);
        }
        const files = splitMultipart(Buffer.concat(chunks), req.headers['content-type']);
        if (!files.length) throw fault(400, 'В отправке нет файла');
        const saved = [];
        for (const file of files) {
          saved.push(await ctx.fly.upload(fileName(encodeURIComponent(file.name)), file.data.length, Readable.from(file.data)));
        }
        res.writeHead(303, { Location: '/?shared=1' });
        res.end();
        void saved;
        return;
      }
      json(res, 404, { error: 'Не найдено' });
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Ошибка сервера' });
      else res.destroy();
    }
  };
}
