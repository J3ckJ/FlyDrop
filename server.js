import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomInt, timingSafeEqual, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import QRCode from 'qrcode';
import { emptyVault, generateTLS, mobileProfile, openVault, digest, newSecret } from './security.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url)), HOUR = 3600000, MAX_FILE = 1024 ** 3;
const loopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const plainIP = ip => ip?.replace(/^::ffff:/, '') || '';
const privateIP = ip => /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(ip);
const fault = (status, message) => Object.assign(new Error(message), { status });
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cleanName = v => typeof v === 'string' ? Array.from(v.trim().replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '')).slice(0, 40).join('') : '';
const cookie = (req, name) => req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
const setCookie = (res, name, value, secure, age) => res.setHeader('Set-Cookie', [...(res.getHeader('Set-Cookie') || []), `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`]);
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
async function readJSON(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw fault(413, 'Слишком большой запрос'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw fault(400, 'Некорректный запрос'); }
}
export function networkInterfaces() {
  const virtual = /virtual|vethernet|wsl|loopback|tap|tunnel|vpn|tailscale|wireguard|docker|hamachi/i;
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => (entries || []).filter(v => v.family === 'IPv4' && !v.internal && privateIP(v.address)).map(v => ({ name, address: v.address, virtual: virtual.test(name) }))).sort((a, b) => Number(a.virtual) - Number(b.virtual));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const STATIC = new Set(['/', '/app.js', '/i18n.js', '/setup.js', '/style.css', '/icon.svg', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png']);
function imageType(header, size) {
  if (size > 20 * 1024 ** 2) return null;
  if (header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return 'image/jpeg';
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export async function createApp({ port = 0, securePort = 0, host = '0.0.0.0', maxFile = MAX_FILE, ttl = HOUR, vaultStore, tls, onReceived = () => {}, onPairing = () => {}, onPresence = () => {} } = {}) {
  const store = vaultStore || { value: emptyVault(), save: async () => {}, flush: async () => {} }, vault = store.value;
  const networks = networkInterfaces(), addresses = [...new Set(networks.map(n => n.address))];
  const material = tls || await generateTLS(vault, addresses); await store.save();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flydrop-'));
  const sessions = new Map(), devices = new Map(), files = new Map(), pending = new Map(), attempts = new Map(), browserTickets = new Map();
  const desktopKey = newSecret();
  let reserved = 0, uploads = 0, actualPort, actualSecurePort, closing = false;
  const freshInvitation = () => ({ key: newSecret(), code: String(randomInt(100000, 1000000)), expiresAt: Date.now() + 5 * 60000 });
  let invitation = freshInvitation();
  const local = req => loopback(req.socket.remoteAddress) || addresses.includes(plainIP(req.socket.remoteAddress));
  const hostDevice = { id: vault.hostId, name: vault.hostName || 'Windows', type: 'computer', isHost: true, inbox: [], outbox: [], streams: new Set(), uploading: false, lastSeen: Date.now() };
  devices.set(hostDevice.id, hostDevice);
  const allowedHosts = new Set(['localhost', '127.0.0.1', ...addresses]);
  const emit = (device, event, data) => {
    for (const stream of device.streams) { if (stream.destroyed || stream.writableEnded || stream.sessionExpiry <= Date.now()) { device.streams.delete(stream); if (!stream.writableEnded) stream.end(); continue; } if (stream.writableLength > 1024 ** 2) { stream.destroy(); continue; } stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  };
  const online = () => [...devices.values()].filter(v => v.streams.size).map(v => ({ id: v.id, name: v.name, type: v.type, isHost: v.isHost }));
  const publishPresence = () => { if (closing) return; try { onPresence({ names: online().filter(v => !v.isHost).map(v => v.name), uploading: [...devices.values()].some(v => v.uploading) }); } catch { /* Tray status cannot fail a transfer. */ } };
  const broadcast = () => { if (closing) return; for (const device of devices.values()) emit(device, 'devices', online().filter(v => v.id !== device.id)); publishPresence(); };
  const liveRequests = () => [...pending.values()].filter(p => p.status === 'waiting' && p.expiresAt > Date.now()).map(({ id, name, type, address, verificationCode, expiresAt }) => ({ id, name, type, address, verificationCode, expiresAt }));
  const publishRequests = () => emit(hostDevice, 'pairings', liveRequests());
  const trustedList = () => {
    const saved = vault.trusted.filter(t => t.expiresAt > Date.now()).map(({ id, name, type, createdAt, lastSeen, expiresAt }) => ({ id, name, type, createdAt, lastSeen, expiresAt, remembered: true, online: Boolean(devices.get(id)?.streams.size) }));
    const ids = new Set(saved.map(v => v.id));
    return [...saved, ...[...devices.values()].filter(v => !v.isHost && !ids.has(v.id)).map(v => ({ id: v.id, name: v.name, type: v.type, remembered: false, expiresAt: v.expiresAt, online: Boolean(v.streams.size) }))];
  };
  const links = () => networks.map(n => ({ ...n, url: `https://${n.address}:${actualSecurePort}/#pair=${invitation.key}`, setupUrl: `http://${n.address}:${actualPort}/setup` }));
  const state = device => ({
    self: { id: device.id, name: device.name, type: device.type, isHost: device.isHost }, devices: online().filter(v => v.id !== device.id),
    inbox: device.inbox.filter(v => v.expiresAt > Date.now()), outbox: device.outbox.filter(v => v.expiresAt > Date.now()), maxFile, links: device.isHost ? links() : [],
    security: { encryptedRemote: true, approvalRequired: true, ...(device.isHost ? { fingerprint: material.fingerprint, certificateName: `FlyDrop Local ${vault.hostId.slice(0, 8)}`, pairingCode: invitation.code, pairingExpiresAt: invitation.expiresAt, requests: liveRequests(), trusted: trustedList() } : {}) }, settings: device.isHost ? vault.settings : undefined,
  });
  const issueSession = (req, res, device) => {
    const existingToken = cookie(req, req.socket.encrypted ? '__Host-flydrop-session' : 'flydrop-local');
    const existing = existingToken && sessions.get(digest(existingToken));
    if (existing?.deviceId === device.id && existing.expiresAt > Date.now()) return device;
    if (sessions.size >= 512) throw fault(429, 'Достигнут предел сеансов. Закройте лишние подключения');
    const token = newSecret(); sessions.set(digest(token), { deviceId: device.id, expiresAt: Math.min(Date.now() + 24 * HOUR, device.expiresAt || Infinity), local: device.isHost });
    setCookie(res, req.socket.encrypted ? '__Host-flydrop-session' : 'flydrop-local', token, Boolean(req.socket.encrypted), 86400); return device;
  };
  const authenticate = req => {
    const token = cookie(req, req.socket.encrypted ? '__Host-flydrop-session' : 'flydrop-local'), session = token && sessions.get(digest(token)), device = session && devices.get(session.deviceId);
    if (!session || !device || session.expiresAt <= Date.now() || (!device.isHost && device.expiresAt <= Date.now()) || (session.local && !local(req))) throw fault(401, 'Подключитесь к компьютеру');
    device.lastSeen = Date.now(); return device;
  };
  const requireHost = device => { if (!device.isHost) throw fault(403, 'Это действие доступно только на компьютере'); };
  const limited = address => {
    const now = Date.now();
    for (const key of [address, '*']) { const prior = attempts.get(key), item = prior?.until > now ? prior : { count: 0, until: now + 60000 }; if (item.count >= (key === '*' ? 30 : 5)) throw fault(429, 'Слишком много попыток подключения. Подождите минуту'); item.count++; attempts.set(key, item); }
  };
  function rememberDevice(record) {
    let device = devices.get(record.id);
    if (!device) { device = { id: record.id, name: record.name, type: record.type, expiresAt: record.tokenHash ? record.expiresAt : Date.now() + 24 * HOUR, isHost: false, inbox: [], outbox: [], streams: new Set(), uploading: false, lastSeen: Date.now() }; devices.set(device.id, device); }
    return device;
  }
  async function removeFile(file) {
    if (!files.has(file.id)) return;
    await rm(file.path, { force: true }); files.delete(file.id); reserved -= file.size;
    for (const device of devices.values()) { device.inbox = device.inbox.filter(v => v.id !== file.id); device.outbox = device.outbox.filter(v => v.id !== file.id); emit(device, 'expired', { id: file.id }); }
  }
  async function revoke(id) {
    if (id === hostDevice.id) throw fault(400, 'Нельзя отозвать доступ у этого компьютера');
    vault.trusted = vault.trusted.filter(v => v.id !== id); await store.save();
    for (const [token, session] of sessions) if (session.deviceId === id) sessions.delete(token);
    for (const request of pending.values()) if (request.deviceId === id) request.status = 'rejected';
    const device = devices.get(id);
    if (device) { emit(device, 'revoked', {}); for (const stream of device.streams) stream.end(); devices.delete(id); }
    for (const file of files.values()) if (file.recipient === id || file.sender === id) await removeFile(file);
    broadcast(); emit(hostDevice, 'trust', trustedList());
  }
  function recipientFor(device, id) {
    if (id === device.id) throw fault(400, 'Отправка на это же устройство запрещена');
    const recipient = devices.get(id); if (!recipient?.streams.size || (!recipient.isHost && recipient.expiresAt <= Date.now())) throw fault(409, 'Получатель отключился. Откройте FlyDrop на другом устройстве'); return recipient;
  }
  function deliver(sender, recipient, item) {
    if (!devices.has(sender.id) || !devices.has(recipient.id)) throw fault(403, 'Доступ устройства отозван');
    recipient.inbox.push(item); sender.outbox.push(item);
    for (const device of [sender, recipient]) for (const key of ['inbox', 'outbox']) { const text = device[key].filter(v => v.kind === 'text'); if (text.length > 100) { const discarded = new Set(text.slice(0, text.length - 100).map(v => v.id)); device[key] = device[key].filter(v => !discarded.has(v.id)); } }
    emit(recipient, 'received', item); emit(sender, 'sent', item);
    if (recipient.isHost) { try { onReceived(item); } catch { /* Notification cannot fail transfer */ } }
  }
  function textTo(sender, id, text) {
    if (typeof text !== 'string' || !text.trim()) throw fault(400, 'Добавьте текст'); if (text.length > 50000) throw fault(413, 'Текст должен быть короче 50 000 символов');
    const recipient = recipientFor(sender, id), item = { id: randomUUID(), kind: 'text', text, from: sender.name, to: recipient.name, createdAt: Date.now(), expiresAt: Date.now() + ttl }; deliver(sender, recipient, item); return item;
  }
  async function receiveFile(sender, recipient, rawName, size, source, onProgress, signal) {
    if (signal?.aborted) throw fault(400, 'Передача отменена');
    if (sender.uploading || uploads >= 3) throw fault(429, 'Передача уже идёт');
    if (files.size + uploads >= 500) throw fault(507, 'Достигнут предел временных файлов');
    if (!Number.isSafeInteger(size) || size < 0) throw fault(411, 'Неизвестен размер файла');
    if (size > maxFile) throw fault(413, 'Файл превышает допустимый размер');
    if (reserved + size > 2 * MAX_FILE) throw fault(507, 'Временное хранилище заполнено');
    const name = Array.from(String(rawName).replace(/[\x00-\x1f\x7f/\\\u202a-\u202e\u2066-\u2069]/g, '_')).slice(0, 180).join('') || 'file';
    const file = { id: randomUUID(), name, size, recipient: recipient.id, sender: sender.id, createdAt: Date.now() };
    file.path = path.join(directory, file.id); reserved += size; uploads++; sender.uploading = true; publishPresence();
    let transferred = 0, header = Buffer.alloc(0), reported = 0;
    const report = loaded => { const now = Date.now(); if (loaded !== size && now - reported < 100) return; reported = now; try { onProgress?.(loaded); } catch { /* Progress cannot fail the transfer. */ } };
    try {
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        if (signal?.aborted) { callback(fault(400, 'Передача отменена')); return; }
        if (header.length < 16) header = Buffer.concat([header, chunk.subarray(0, 16 - header.length)]);
        transferred += chunk.length;
        if (transferred > size) { callback(fault(413, 'Некорректный размер файла')); return; }
        report(transferred); callback(null, chunk);
      } });
      const stream = source();
      if (signal) { const abort = () => { if (!stream.destroyed) stream.destroy(fault(400, 'Передача отменена')); }; if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
      await pipeline(stream, limiter, createWriteStream(file.path, { flags: 'wx', mode: 0o600 }));
      if (signal?.aborted) throw fault(400, 'Передача отменена');
      if (transferred !== size) throw fault(400, 'Передача прервалась');
      if (!devices.has(recipient.id) || !devices.has(sender.id)) throw fault(403, 'Доступ устройства отозван');
      file.expiresAt = Date.now() + ttl; file.preview = imageType(header, size);
      const item = { id: file.id, kind: 'file', name, size, from: sender.name, to: recipient.name, createdAt: file.createdAt, expiresAt: file.expiresAt, preview: Boolean(file.preview) };
      files.set(file.id, file); deliver(sender, recipient, item); return item;
    } catch (error) { files.delete(file.id); reserved -= size; await rm(file.path, { force: true }); throw error; }
    finally { uploads--; sender.uploading = false; publishPresence(); }
  }
  async function sendLocalFiles(recipientId, paths, onProgress, signal) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 500) throw fault(400, 'Добавьте файлы');
    const items = [];
    for (let index = 0; index < paths.length; index++) {
      if (signal?.aborted) throw fault(400, 'Передача отменена');
      const filePath = paths[index];
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw fault(400, 'Некорректный файл');
      let info; try { info = await stat(filePath); } catch { throw fault(404, 'Файл из буфера больше недоступен'); }
      if (!info.isFile()) throw fault(400, 'Папки отправить нельзя');
      const recipient = recipientFor(hostDevice, recipientId), name = path.basename(filePath);
      const progress = loaded => { try { onProgress?.({ index, total: paths.length, name, loaded, size: info.size }); } catch { /* Progress cannot fail the transfer. */ } };
      progress(0);
      try { items.push(await receiveFile(hostDevice, recipient, name, info.size, () => createReadStream(filePath), progress, signal)); }
      catch (error) { if (!error.status && ['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw fault(404, 'Файл из буфера больше недоступен'); throw error; }
    }
    return items;
  }
  const handler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    try {
      const secure = Boolean(req.socket.encrypted), scheme = secure ? 'https' : 'http', authority = req.headers.host || '', url = new URL(req.url, `${scheme}://${authority}`);
      if (!allowedHosts.has(url.hostname) || Number(url.port || (secure ? 443 : 80)) !== (secure ? actualSecurePort : actualPort)) throw fault(403, 'Адрес не разрешён');
      const origin = `${scheme}://${authority}`;
      if (req.headers.origin && req.headers.origin !== origin) throw fault(403, 'Запрос с другого сайта запрещён');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fault(403, 'Запрос с другого сайта запрещён');
      if (req.method === 'POST' && req.headers.origin !== origin) throw fault(403, 'Требуется приложение FlyDrop');
      if (!secure && !local(req) && !['/setup', '/setup.js', '/i18n.js', '/certificate.mobileconfig', '/ca.cer', '/style.css', '/icon.svg'].includes(url.pathname)) throw fault(426, 'Для передачи требуется HTTPS. Настройте сертификат на /setup');
      if (req.method === 'GET' && url.pathname === '/health') { json(res, 200, { app: 'FlyDrop', version: '0.3.0', securePort: actualSecurePort }); return; }
      if (req.method === 'GET' && url.pathname === '/setup') { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(await readFile(path.join(ROOT, 'public', 'setup.html'))); return; }
      if (req.method === 'GET' && ['/certificate.mobileconfig', '/ca.cer'].includes(url.pathname)) {
        const profile = url.pathname.endsWith('.mobileconfig'); res.writeHead(200, { 'Content-Type': profile ? 'application/x-apple-aspen-config' : 'application/pkix-cert', 'Content-Disposition': `attachment; filename="${profile ? 'FlyDrop.mobileconfig' : 'FlyDrop.cer'}"` }); res.end(profile ? mobileProfile(material, vault.hostId) : new X509Certificate(material.ca).raw); return;
      }
      if (req.method === 'GET' && STATIC.has(url.pathname)) { const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] }); res.end(await readFile(path.join(ROOT, 'public', file))); return; }
      if (req.method === 'POST' && url.pathname === '/api/connect') {
        const body = await readJSON(req);
        if (local(req)) {
          let existingHost = false;
          try { existingHost = authenticate(req).isHost; } catch {}
          const ticket = typeof body.desktopTicket === 'string' ? browserTickets.get(digest(body.desktopTicket)) : undefined;
          if (!existingHost && !equal(req.headers['x-flydrop-desktop'], desktopKey) && !(ticket && ticket > Date.now())) throw fault(401, 'Откройте Windows-приложение FlyDrop. Для браузера используйте пункт «Открыть в браузере» в меню трея');
          if (ticket) browserTickets.delete(digest(body.desktopTicket));
          issueSession(req, res, hostDevice); json(res, 200, state(hostDevice)); return;
        }
        if (!secure) throw fault(426, 'Требуется HTTPS');
        const trustedToken = cookie(req, '__Host-flydrop-trust'), trusted = trustedToken && vault.trusted.find(v => equal(v.tokenHash, digest(trustedToken)) && v.expiresAt > Date.now());
        if (trusted) { const device = rememberDevice(trusted); trusted.lastSeen = Date.now(); await store.save(); issueSession(req, res, device); json(res, 200, state(device)); return; }
        limited(plainIP(req.socket.remoteAddress));
        if (invitation.expiresAt < Date.now() || !(equal(body.key, invitation.key) || equal(body.code, invitation.code))) throw fault(403, 'Неверный или истёкший код. Обновите подключение на Windows');
        if (liveRequests().length >= 8) throw fault(429, 'Слишком много ожидающих устройств');
        const id = randomUUID(), token = newSecret(), request = { id, tokenHash: digest(token), name: cleanName(body.name) || 'iPhone', type: ['phone', 'tablet', 'computer'].includes(body.type) ? body.type : 'phone', address: plainIP(req.socket.remoteAddress), verificationCode: String(randomInt(100000, 1000000)), status: 'waiting', expiresAt: Date.now() + 5 * 60000 };
        pending.set(id, request); publishRequests(); try { onPairing(request); } catch { /* Optional notification */ }
        json(res, 202, { pending: true, requestId: id, token, verificationCode: request.verificationCode, expiresAt: request.expiresAt }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/pair-status') {
        if (!secure || local(req)) throw fault(403, 'Только для подключаемого устройства');
        const { requestId, token } = await readJSON(req), request = pending.get(requestId);
        if (!request || !equal(request.tokenHash, digest(typeof token === 'string' ? token : '')) || request.address !== plainIP(req.socket.remoteAddress) || request.expiresAt < Date.now()) throw fault(403, 'Запрос истёк. Подключитесь заново');
        if (request.status === 'rejected') throw fault(403, 'Подключение отклонено на компьютере'); if (request.status === 'waiting') { json(res, 202, { pending: true }); return; }
        const device = devices.get(request.deviceId); if (!device) throw fault(403, 'Доступ отозван');
        if (request.trustToken) setCookie(res, '__Host-flydrop-trust', request.trustToken, true, 30 * 86400);
        issueSession(req, res, device); pending.delete(request.id); json(res, 200, state(device)); return;
      }
      if (!url.pathname.startsWith('/api/')) throw fault(404, 'Не найдено'); const device = authenticate(req);
      if (req.method === 'GET' && url.pathname === '/api/state') { json(res, 200, state(device)); return; }
      if (req.method === 'POST' && url.pathname === '/api/name') {
        const body = await readJSON(req), name = cleanName(body.name); if (!name) throw fault(400, 'Введите имя до 40 символов'); device.name = name;
        if (device.isHost) vault.hostName = name; else { const trust = vault.trusted.find(v => v.id === device.id); if (trust) trust.name = name; } await store.save(); broadcast(); json(res, 200, state(device)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/pairing/rotate') { requireHost(device); await readJSON(req); invitation = freshInvitation(); for (const request of pending.values()) if (request.status === 'waiting') request.status = 'rejected'; publishRequests(); json(res, 200, state(device)); return; }
      const pairingAction = url.pathname.match(/^\/api\/pairings\/([\da-f-]{36})\/(approve|reject)$/);
      if (req.method === 'POST' && pairingAction) {
        requireHost(device); const body = await readJSON(req), request = pending.get(pairingAction[1]); if (!request || request.status !== 'waiting' || request.expiresAt < Date.now()) throw fault(404, 'Запрос больше не действует');
        if (pairingAction[2] === 'reject') request.status = 'rejected';
        else {
          if (devices.size >= 32 || vault.trusted.length >= 32) throw fault(429, 'Достигнут предел устройств');
          const record = { id: randomUUID(), name: request.name, type: request.type, createdAt: Date.now(), lastSeen: Date.now(), expiresAt: Date.now() + 30 * 24 * HOUR };
          if (body.remember === true) { request.trustToken = newSecret(); record.tokenHash = digest(request.trustToken); vault.trusted.push(record); try { await store.save(); } catch (error) { vault.trusted = vault.trusted.filter(v => v.id !== record.id); request.trustToken = undefined; throw error; } }
          rememberDevice(record); request.deviceId = record.id; request.status = 'approved';
        }
        publishRequests(); emit(hostDevice, 'trust', trustedList()); json(res, 200, state(device)); return;
      }
      const revokeAction = url.pathname.match(/^\/api\/devices\/([\da-f-]{36})\/revoke$/);
      if (req.method === 'POST' && revokeAction) { requireHost(device); await readJSON(req); await revoke(revokeAction[1]); json(res, 200, state(device)); return; }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        requireHost(device); const body = await readJSON(req); if (typeof body.lastRecipient === 'string' && (body.lastRecipient === '' || (devices.has(body.lastRecipient) && body.lastRecipient !== device.id))) vault.settings.lastRecipient = body.lastRecipient; if (typeof body.notifications === 'boolean') vault.settings.notifications = body.notifications; if (typeof body.autoSave === 'boolean') vault.settings.autoSave = body.autoSave; await store.save(); json(res, 200, state(device)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/qr') {
        requireHost(device); const link = links().find(v => v.address === (url.searchParams.get('address') || addresses[0])); if (!link) throw fault(404, 'Не найдена локальная сеть'); const svg = await QRCode.toString(url.searchParams.get('mode') === 'setup' ? link.setupUrl : link.url, { type: 'svg', margin: 2, color: { dark: '#18261e', light: '#ffffff' } }); res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(svg); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (device.streams.size >= 8) throw fault(429, 'Закройте лишние вкладки');
        const token = cookie(req, req.socket.encrypted ? '__Host-flydrop-session' : 'flydrop-local'); res.sessionExpiry = sessions.get(digest(token)).expiresAt;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.write('retry: 2000\n\n'); device.streams.add(res); res.on('error', () => { device.streams.delete(res); res.destroy(); }); broadcast(); emit(device, 'state', state(device)); req.on('close', () => { device.streams.delete(res); device.lastSeen = Date.now(); broadcast(); }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/text') { const body = await readJSON(req); json(res, 201, textTo(device, req.headers['x-recipient'], body.text)); return; }
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        const recipient = recipientFor(device, req.headers['x-recipient']); if (device.uploading || uploads >= 3) throw fault(429, 'Передача уже идёт'); if (files.size + uploads >= 500) throw fault(507, 'Достигнут предел временных файлов');
        const length = req.headers['content-length'], size = Number(length); if (length === undefined || !Number.isSafeInteger(size) || size < 0) throw fault(411, 'Неизвестен размер файла'); if (size > maxFile) throw fault(413, 'Файл превышает допустимый размер'); if (reserved + size > 2 * MAX_FILE) throw fault(507, 'Временное хранилище заполнено');
        let name; try { name = decodeURIComponent(req.headers['x-filename'] || 'file'); } catch { throw fault(400, 'Некорректное имя файла'); }
        json(res, 201, await receiveFile(device, recipient, name, size, () => req)); return;
      }
      const fileAction = url.pathname.match(/^\/api\/(download|preview)\/([\da-f-]{36})$/);
      if (req.method === 'GET' && fileAction) {
        const file = files.get(fileAction[2]), preview = fileAction[1] === 'preview'; if (!file || file.expiresAt <= Date.now()) throw fault(404, 'Срок хранения файла истёк'); if (file.recipient !== device.id) throw fault(403, 'Этот файл адресован другому устройству'); if (preview && !file.preview) throw fault(415, 'Предпросмотр доступен для небольших PNG, JPEG и WebP');
        await stat(file.path); const ascii = file.name.replace(/[^a-zA-Z0-9._-]/g, '_'), encoded = encodeURIComponent(file.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox"); res.writeHead(200, { 'Content-Type': preview ? file.preview : 'application/octet-stream', 'Content-Length': file.size, 'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}` }); await pipeline(createReadStream(file.path), res); return;
      }
      throw fault(404, 'Не найдено');
    } catch (error) { if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: error.status ? error.message : 'Ошибка сервера. Попробуйте ещё раз' }); else if (!res.writableEnded) res.destroy(); if (!error.status && !['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ABORT_ERR'].includes(error.code)) console.error(error.message); }
  };
  const server = http.createServer(handler), secureServer = https.createServer({ key: material.key, cert: material.cert, minVersion: 'TLSv1.2' }, handler);
  for (const s of [server, secureServer]) { s.requestTimeout = 30 * 60000; s.headersTimeout = 20000; s.maxHeadersCount = 50; }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); actualPort = server.address().port;
    await new Promise((resolve, reject) => { secureServer.once('error', reject); secureServer.listen(securePort, host, resolve); }); actualSecurePort = secureServer.address().port;
  } catch (error) { server.closeAllConnections(); server.close(); secureServer.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  async function sweep() {
    const now = Date.now(); for (const file of files.values()) if (file.expiresAt <= now) await removeFile(file);
    for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token); for (const [id, request] of pending) if (request.expiresAt <= now) pending.delete(id); for (const [ip, attempt] of attempts) if (attempt.until <= now) attempts.delete(ip); for (const [token, expiresAt] of browserTickets) if (expiresAt <= now) browserTickets.delete(token);
    for (const device of devices.values()) { device.inbox = device.inbox.filter(v => v.expiresAt > now); device.outbox = device.outbox.filter(v => v.expiresAt > now); for (const stream of device.streams) { if (stream.sessionExpiry <= now) { stream.end(); device.streams.delete(stream); } else if (!stream.destroyed && !stream.writableEnded) stream.write(': heartbeat\n\n'); } if (!device.isHost && !device.streams.size && !device.uploading && now - device.lastSeen > 24 * HOUR) devices.delete(device.id); }
    for (const trust of [...vault.trusted]) if (trust.expiresAt <= now) await revoke(trust.id);
  }
  const timer = setInterval(() => void sweep().catch(e => console.error(e.message)), 15000); timer.unref();
  return {
    server, secureServer, desktopKey, port: actualPort, securePort: actualSecurePort, material, directory, vault, store, sweep, getState: () => state(hostDevice), sendClipboard: text => textTo(hostDevice, vault.settings.lastRecipient, text), sendLocalFiles,
    browserLink() { const token = newSecret(); if (browserTickets.size >= 32) browserTickets.clear(); browserTickets.set(digest(token), Date.now() + 120000); return `http://localhost:${actualPort}/#desktop=${token}`; },
    async incomingFile(id) { const file = files.get(id); if (!file || file.recipient !== hostDevice.id || file.expiresAt <= Date.now()) throw new Error('Файл недоступен'); return { path: file.path, name: file.name }; },
    async close() { if (closing) return; closing = true; clearInterval(timer); for (const device of devices.values()) for (const stream of device.streams) stream.end(); for (const s of [server, secureServer]) s.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => secureServer.close(resolve))]); await store.flush(); await rm(directory, { recursive: true, force: true }); },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317), securePort = Number(process.env.HTTPS_PORT || 4318); if (![port, securePort].every(p => Number.isInteger(p) && p > 0 && p < 65536) || port === securePort) throw new Error('Задайте разные PORT и HTTPS_PORT от 1 до 65535');
  let app;
  try { const vaultStore = await openVault(path.join(process.env.APPDATA || os.homedir(), 'FlyDrop', 'security')); app = await createApp({ port, securePort, vaultStore }); }
  catch (error) { console.error(error.code === 'EADDRINUSE' ? `Порт ${port}/${securePort} занят. Откройте http://localhost:${port} или закройте старый FlyDrop.` : `Не удалось запустить FlyDrop: ${error.message}`); process.exit(1); }
  console.log(`\n  FlyDrop 0.3.0 — HTTPS + подтверждение устройств\n  Windows: http://localhost:${app.port}\n  iPhone: настройте сертификат, затем используйте HTTPS QR-код.\n  Ctrl+C для выхода.\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
