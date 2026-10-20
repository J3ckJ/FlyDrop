import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, newSecret } from '../security.js';
import { seal, open as unseal } from './box.js';
import { CHUNK, chunkBounds, createTransfer } from './chunks.js';
import { heicPlan, h264Plan, proxyPlan } from './convert.js';
import { createHistory } from './history.js';
import { clusterEvents, destination, insideRoot, safeSegment } from './layout.js';
import { notificationLine, partition, reportText } from './report.js';
import { shortcutPlist } from './shortcut.js';

const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function emptyBatch() { return { copied: 0, skipped: 0, errors: 0, verified: 0, folders: [], resumes: [], proxies: 0, jpg: 0, bytes: 0, total: 0 }; }
const IMAGE = 20 * 1024 * 1024;

function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp' && /heic|heix|heif|mif1/i.test(buf.toString('ascii', 8, 12))) return 'image/heic';
  return '';
}
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
async function readBody(req, max, fault) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw fault(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function extOf(name, mime) {
  const ext = path.extname(name || '').toLowerCase();
  if (ext) return ext;
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/heic') return '.heic';
  return '';
}
function isHeic(name, mime) { return mime === 'image/heic' || /\.hei[cf]$/i.test(name || ''); }
function isVideo(name, mime) { return /^video\//.test(mime || '') || /\.(mov|mp4|m4v)$/i.test(name || ''); }

export async function createModes({ vault, store, fault, directory, dataDirectory, unloadRoot, hostDevice, devices, emit, now = () => Date.now(), chunkSize = CHUNK, runPlan, onNotice = () => {}, securePort = () => 4318 }) {
  const rootDir = () => vault.settings.unloadFolder || unloadRoot || path.join(directory, 'unload');
  const dot = () => path.join(rootDir(), '.flydrop');
  const history = createHistory({ now, hideSensitive: () => vault.settings.clipboardHideSensitive !== false });
  const media = new Map();
  const jobs = new Map();
  let active = null;
  let batch = emptyBatch();
  const flags = () => ({
    hideSensitive: vault.settings.clipboardHideSensitive !== false,
    history: vault.settings.clipboardHistory !== false,
    persist: vault.settings.clipboardPersist === true,
    heicToJpg: vault.settings.heicToJpg !== false,
    hevcToH264: vault.settings.hevcToH264 === true,
    makeProxy: vault.settings.makeProxy !== false,
  });
  function bufferKey() {
    if (!vault.bufferKey) vault.bufferKey = randomBytes(32).toString('base64url');
    const key = Buffer.from(vault.bufferKey, 'base64url');
    if (key.length !== 32) throw fault(500, 'Ключ истории повреждён');
    return key;
  }
  async function saveHistory() {
    if (!flags().persist) { vault.bufferHistory = []; await store.save(); return; }
    vault.bufferHistory = history.exportPersisted(bufferKey());
    await store.save();
  }
  if (Array.isArray(vault.bufferHistory) && vault.bufferHistory.length && vault.bufferKey) {
    try { history.importPersisted(vault.bufferHistory, Buffer.from(vault.bufferKey, 'base64url')); } catch { /* A damaged history must not stop FlyDrop. */ }
  }
  async function loadIndex() {
    try { return JSON.parse(await readFile(path.join(dot(), 'index.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { byHash: {}, last: [] }; }
  }
  let index = await loadIndex();
  async function saveIndex() {
    await mkdir(dot(), { recursive: true });
    const file = path.join(dot(), 'index.json');
    const temporary = path.join(dot(), `index-${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(temporary, JSON.stringify(index), { mode: 0o600 });
    await rename(temporary, file);
  }
  async function loadJobs() {
    let names = [];
    try { names = await readdir(path.join(dot(), 'partials')); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(await readFile(path.join(dot(), 'partials', name), 'utf8'));
        if (!meta?.id || !meta.sha256) continue;
        jobs.set(meta.id, { ...meta, transfer: createTransfer({ size: meta.size, chunkSize: meta.chunkSize || chunkSize, received: meta.received || [] }) });
      } catch { /* Skip a torn partial. */ }
    }
  }
  await loadJobs();
  function phone() {
    const peers = [...devices.values()].filter(device => !device.isHost && device.type !== 'computer');
    const chosen = peers.find(device => device.id === vault.settings.lastRecipient) || peers.find(device => device.streams.size) || peers[0];
    return chosen || null;
  }
  function publish() {
    const payload = view(hostDevice);
    emit(hostDevice, 'buffer', payload);
    for (const device of devices.values()) if (!device.isHost) emit(device, 'buffer', view(device));
  }
  function visible(item) {
    const keep = flags().history || item.pinned || item.status === 'waiting' || item.status === 'queued';
    return keep;
  }
  function view(device) {
    const peer = device.isHost ? phone() : hostDevice;
    const online = Boolean(peer?.streams?.size);
    return {
      items: history.list(now()).filter(visible),
      online,
      peerName: peer?.name || (device.isHost ? 'iPhone' : 'Windows ПК'),
      settings: device.isHost ? flags() : { hideSensitive: flags().hideSensitive },
    };
  }
  function unloadView() {
    const job = active;
    const known = Object.values(index.byHash || {});
    const last = [...known].sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0))[0];
    return {
      phase: job?.phase || (vault.lastUnload ? 'done' : 'idle'),
      folder: rootDir(),
      settings: flags(),
      hint: last ? { name: last.name, takenAt: last.takenAt, calendar: last.calendar } : null,
      thumbs: (index.last || []).slice(0, 5),
      job: job ? publicJob(job) : null,
      report: vault.lastUnload || null,
    };
  }
  function publicJob(job) {
    const doneBytes = Math.min(job.size, (job.transfer?.received().length || 0) * (job.chunkSize || chunkSize));
    return {
      id: job.id, name: job.name, size: job.size, phase: job.phase, copied: job.copied || 0, skipped: job.skipped || 0,
      errors: job.errors || 0, left: job.left ?? 0, total: job.total || 0, bytesDone: job.bytesDone || doneBytes, bytesTotal: job.bytesTotal || job.size,
      chunk: job.transfer ? { index: job.currentChunk || 0, count: job.transfer.count, fileBytes: doneBytes, fileSize: job.size } : null,
      paused: job.phase === 'paused', folders: job.folders || [],
    };
  }
  async function rememberMedia(id, bytes, mime) {
    const dir = path.join(dataDirectory || directory, 'buffer');
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, id);
    if (flags().persist) await writeFile(target, seal(bufferKey(), bytes), { encoding: 'utf8', mode: 0o600 });
    else await writeFile(target, bytes, { mode: 0o600 });
    media.set(id, { path: target, sealed: flags().persist, mime });
  }
  async function addBuffer(input) {
    const item = history.add(input, now());
    if (input.bytes) await rememberMedia(item.id, input.bytes, input.mime);
    if (flags().persist && !item.sensitive) await saveHistory();
    publish();
    return item;
  }
  async function fromHost({ kind, text, bytes, mime, name, source = 'hotkey' }) {
    const target = phone();
    const item = await addBuffer({
      kind: kind === 'image' ? 'image' : 'text', text: text || '', bytes, mime, name: name || (kind === 'image' ? 'Снимок.png' : ''),
      size: bytes?.length || undefined, status: 'waiting', direction: 'to-phone', source, from: hostDevice.name, to: target?.name || 'iPhone',
    });
    return item;
  }
  async function takeToken(header) {
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw fault(401, 'Нет ключа команды');
    const hash = digest(token);
    const row = (vault.bufferTokens || []).find(item => equal(item.hash, hash) && item.expiresAt > now());
    if (!row) throw fault(401, 'Команда устарела. Откройте FlyDrop и добавьте её заново');
    return row;
  }
  async function ingest(req, res) {
    const row = await takeToken(req.headers.authorization || '');
    const body = await readBody(req, IMAGE, fault);
    const mime = sniff(body) || (/^image\//.test(req.headers['content-type'] || '') ? req.headers['content-type'].split(';')[0] : '');
    const source = req.headers['x-flydrop-source'] === 'backtap' ? 'backtap' : 'shortcut';
    let name = 'image';
    try { name = decodeURIComponent(req.headers['x-filename'] || '') || 'image'; } catch { name = 'image'; }
    if (mime) {
      await addBuffer({ kind: 'image', bytes: body, mime, name: safeSegment(name), size: body.length, status: 'received', direction: 'from-phone', source, from: row.name || 'iPhone', to: hostDevice.name });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Доставлено в FlyDrop');
      return;
    }
    const text = body.toString('utf8');
    const item = await addBuffer({ kind: 'text', text, status: 'received', direction: 'from-phone', source, from: row.name || 'iPhone', to: hostDevice.name });
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(item.sensitive ? 'Доставлено. Секрет скрыт и скоро исчезнет' : 'Доставлено в FlyDrop');
  }
  async function issueShortcut(device, host) {
    const token = newSecret();
    vault.bufferTokens = [...(vault.bufferTokens || []).filter(item => item.expiresAt > now() && item.deviceId !== device.id), { hash: digest(token), deviceId: device.id, name: device.name, expiresAt: now() + 30 * 24 * 3600000 }];
    await store.save();
    const endpoint = `https://${host}/api/buffer/ingest`;
    return shortcutPlist({ url: endpoint, token });
  }
  async function readMedia(id) {
    const item = history.raw(id);
    const stored = media.get(id);
    if (!item || item.kind !== 'image' || !stored) throw fault(404, 'Картинки уже нет');
    const bytes = await readFile(stored.path);
    return { mime: stored.mime, name: item.name, bytes: stored.sealed ? unseal(bufferKey(), bytes.toString('utf8')) : bytes };
  }
  async function forgetDevice(id) {
    vault.bufferTokens = (vault.bufferTokens || []).filter(item => item.deviceId !== id);
    await store.save();
  }
  function batchFrom(files) {
    const groups = clusterEvents(files);
    const copy = [];
    for (const group of groups) for (const file of group.files) copy.push({ ...file, eventName: file.eventName || group.name });
    return { groups, files: copy };
  }
  async function startJob(meta) {
    const id = meta.id;
    const partial = path.join(dot(), 'partials', `${id}.bin`);
    const descriptor = path.join(dot(), 'partials', `${id}.json`);
    await mkdir(path.dirname(partial), { recursive: true });
    try { await writeFile(partial, Buffer.alloc(0), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const job = { ...meta, phase: 'uploading', path: partial, descriptor, transfer: createTransfer({ size: meta.size, chunkSize: meta.chunkSize || chunkSize, received: meta.received || [] }), copied: active?.copied || 0 };
    jobs.set(id, job);
    active = job;
    await writeFile(descriptor, JSON.stringify({ ...meta, received: job.transfer.received() }), { mode: 0o600 });
    return job;
  }
  async function route(req, res, { device, url }) {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && url.pathname === '/api/buffer') { send(200, view(device)); return true; }
    if (req.method === 'POST' && url.pathname === '/api/buffer') {
      const type = req.headers['content-type'] || '';
      if (type.startsWith('image/') || type === 'application/octet-stream') {
        const body = await readBody(req, IMAGE, fault);
        const mime = sniff(body) || (type.startsWith('image/') ? type : '');
        if (!mime) throw fault(415, 'В буфер можно текст, ссылку или картинку PNG, JPEG, WebP, HEIC');
        let name = 'image';
        try { name = decodeURIComponent(req.headers['x-filename'] || 'image'); } catch { throw fault(400, 'Некорректное имя файла'); }
        const item = await addBuffer({ kind: 'image', bytes: body, mime, name: safeSegment(name), size: body.length, status: device.isHost ? 'waiting' : 'received', direction: device.isHost ? 'to-phone' : 'from-phone', source: req.headers['x-flydrop-source'] || 'share', from: device.name, to: device.isHost ? (phone()?.name || 'iPhone') : hostDevice.name });
        send(201, item); return true;
      }
      const body = JSON.parse((await readBody(req, 256 * 1024, fault)).toString('utf8') || '{}');
      const item = await addBuffer({ kind: 'text', text: body.text, status: device.isHost ? 'waiting' : 'received', direction: device.isHost ? 'to-phone' : 'from-phone', source: body.source || 'share', from: device.name, to: device.isHost ? (phone()?.name || 'iPhone') : hostDevice.name });
      send(201, item); return true;
    }
    const bufferAction = url.pathname.match(/^\/api\/buffer\/([\da-f-]{36})\/(pin|ack|reveal)$/);
    if (req.method === 'POST' && bufferAction) {
      const raw = await readBody(req, 64 * 1024, fault);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const [id, action] = [bufferAction[1], bufferAction[2]];
      if (action === 'reveal') { send(200, history.reveal(id, now())); return true; }
      if (action === 'ack') { send(200, history.setStatus(id, 'delivered')); if (flags().persist) await saveHistory(); publish(); return true; }
      send(200, history.pin(id, body.pinned !== false, now()));
      if (flags().persist) await saveHistory();
      publish();
      return true;
    }
    const mediaRoute = url.pathname.match(/^\/api\/buffer\/([\da-f-]{36})\/media$/);
    if (req.method === 'GET' && mediaRoute) {
      const file = await readMedia(mediaRoute[1]);
      res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.bytes.length, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
      res.end(file.bytes); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/buffer/settings') {
      if (!device.isHost) throw fault(403, 'Это действие доступно только на компьютере');
      const body = JSON.parse((await readBody(req, 64 * 1024, fault)).toString('utf8') || '{}');
      if (typeof body.hideSensitive === 'boolean') vault.settings.clipboardHideSensitive = body.hideSensitive;
      if (typeof body.history === 'boolean') vault.settings.clipboardHistory = body.history;
      if (typeof body.persist === 'boolean') vault.settings.clipboardPersist = body.persist;
      await saveHistory();
      publish();
      send(200, view(device)); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/buffer/shortcut') {
      const port = typeof securePort === 'function' ? securePort() : securePort;
      const host = url.hostname && port ? `${url.hostname}:${port}` : url.host;
      if (!host) throw fault(400, 'Неизвестный адрес компьютера');
      const plist = await issueShortcut(device.isHost ? (phone() || device) : device, host);
      res.writeHead(200, { 'Content-Type': 'application/x-apple-shortcut', 'Content-Disposition': 'attachment; filename="FlyDrop.shortcut"' });
      res.end(plist); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/unload') { send(200, unloadView()); return true; }
    if (req.method === 'POST' && url.pathname === '/api/unload/settings') {
      if (!device.isHost) throw fault(403, 'Это действие доступно только на компьютере');
      const body = JSON.parse((await readBody(req, 64 * 1024, fault)).toString('utf8') || '{}');
      if (typeof body.heicToJpg === 'boolean') vault.settings.heicToJpg = body.heicToJpg;
      if (typeof body.hevcToH264 === 'boolean') vault.settings.hevcToH264 = body.hevcToH264;
      if (typeof body.makeProxy === 'boolean') vault.settings.makeProxy = body.makeProxy;
      if (typeof body.folder === 'string' && body.folder.trim()) {
        vault.settings.unloadFolder = path.resolve(body.folder);
      }
      await store.save();
      send(200, unloadView()); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/unload/probe') {
      const body = JSON.parse((await readBody(req, 2 * 1024 * 1024, fault)).toString('utf8') || '{}');
      if (!Array.isArray(body.files) || body.files.length > 5000) throw fault(400, 'Выберите фото и видео');
      const known = new Set(Object.keys(index.byHash || {}));
      for (const job of jobs.values()) if (!job.transfer.complete()) known.delete(job.sha256);
      const named = body.files.map(file => ({ ...file, size: Number(file.size), eventName: safeSegment(body.eventName || file.eventName || '', '') }));
      const { accept, skip } = partition(named, known);
      const grouped = clusterEvents(accept);
      const ordered = [];
      const used = new Set();
      for (const group of grouped) {
        let name = group.name || '';
        const day = String(group.files[0].calendar || '');
        const key = `${day}:${name}`;
        if (used.has(key)) name = name ? `${name} ${ordered.length + 1}` : `Съёмка ${ordered.length + 1}`;
        used.add(`${day}:${name}`);
        for (const file of group.files) ordered.push({ ...file, eventName: name });
      }
      batch = { ...emptyBatch(), skipped: skip.length, total: ordered.length, bytes: ordered.reduce((sum, file) => sum + (file.size || 0), 0) };
      const queued = [];
      for (const file of ordered) {
        const existing = [...jobs.values()].find(job => job.sha256 === file.sha256 && !job.transfer.complete());
        const meta = existing || await startJob({
          id: randomUUID(), name: safeSegment(file.name), size: file.size, sha256: file.sha256,
          chunkSize, received: [], takenAt: Number(file.takenAt) || now(), calendar: file.calendar || '', eventName: file.eventName || '',
          lat: Number.isFinite(file.lat) ? file.lat : null, lon: Number.isFinite(file.lon) ? file.lon : null, mime: file.mime || '', createdAt: now(),
        });
        meta.total = batch.total; meta.skipped = batch.skipped; meta.left = batch.total; meta.bytesTotal = batch.bytes; meta.phase = 'uploading'; meta.copied = batch.copied;
        queued.push({ clientId: file.clientId || file.name, uploadId: meta.id, missing: meta.transfer.missing(), size: meta.size, chunkSize: meta.chunkSize || chunkSize });
      }
      if (queued[0]) active = jobs.get(queued[0].uploadId);
      send(200, { accept: queued, skip: skip.map(file => ({ clientId: file.clientId || file.name, name: file.name, sha256: file.sha256 })), hint: unloadView().hint });
      emit(hostDevice, 'unload', unloadView());
      return true;
    }
    const chunkRoute = url.pathname.match(/^\/api\/unload\/([\da-f-]{36})\/chunks\/(\d+)$/);
    if (req.method === 'PUT' && chunkRoute) {
      const job = jobs.get(chunkRoute[1]);
      if (!job) throw fault(404, 'Выгрузка не найдена. Начните её снова');
      if (job.phase === 'paused') throw fault(409, 'Выгрузка на паузе');
      const indexNo = Number(chunkRoute[2]);
      const hadHoles = job.transfer.missing().length && job.transfer.received().length > 0 && !job.transfer.received().includes(indexNo);
      const body = await readBody(req, chunkSize, fault);
      const result = job.transfer.accept(indexNo, body.length);
      const handle = await open(job.path, 'r+');
      try { await handle.write(body, 0, body.length, result.bounds.start); }
      finally { await handle.close(); }
      job.currentChunk = indexNo + 1;
      job.bytesDone = job.transfer.received().reduce((sum, index) => sum + chunkBounds(job.size, index, job.chunkSize || chunkSize).length, 0);
      if (hadHoles && req.headers['x-flydrop-resume'] === '1' && !job.resumeNoted) {
        job.resumeNoted = true;
        job.resumeLines = [...(job.resumeLines || []), `${job.name} с ${formatBytes(result.bounds.start)}`];
      }
      await writeFile(job.descriptor, JSON.stringify({ ...job, transfer: undefined, received: job.transfer.received(), chunkSize: job.chunkSize || chunkSize }), { mode: 0o600 });
      active = job;
      emit(hostDevice, 'unload', unloadView());
      send(200, { missing: result.missing, done: result.done });
      return true;
    }
    const finishRoute = url.pathname.match(/^\/api\/unload\/([\da-f-]{36})\/finish$/);
    if (req.method === 'POST' && finishRoute) {
      const job = jobs.get(finishRoute[1]);
      if (!job || !job.transfer.complete()) throw fault(409, 'Ещё не все части доехали');
      const raw = await readBody(req, 80 * 1024, fault);
      const actual = await hashFile(job.path);
      if (actual !== job.sha256) {
        job.phase = 'error';
        job.errors = (job.errors || 0) + 1;
        active = job;
        throw fault(409, 'Контрольная сумма не совпала. Повторите только этот файл');
      }
      const placed = destination({ root: rootDir(), takenAt: job.takenAt, calendar: job.calendar, eventName: job.eventName, filename: job.name });
      if (!insideRoot(rootDir(), placed.absolute)) throw fault(400, 'Имя файла не подходит для папки');
      const finalPath = await moveIntoPlace(job.path, placed.absolute, fault);
      const stamp = new Date((job.takenAt || now()) / 1);
      await utimes(finalPath, stamp, stamp).catch(() => {});
      index.byHash[job.sha256] = { name: job.name, size: job.size, takenAt: job.takenAt, calendar: job.calendar || placed.folder.slice(0, 10), path: finalPath, folder: placed.folder };
      index.last = [{ name: job.name, takenAt: job.takenAt, folder: placed.folder }, ...(index.last || []).filter(item => item.name !== job.name)].slice(0, 5);
      await saveIndex();
      const body = JSON.parse(raw.toString('utf8') || '{}');
      if (typeof body.thumb === 'string' && body.thumb.startsWith('data:image/jpeg;base64,') && body.thumb.length < 40000) {
        index.last[0].thumb = body.thumb;
        await saveIndex();
      }
      const converted = await convertFile(finalPath, job, placed);
      job.phase = 'done';
      batch.verified += 1;
      batch.copied += 1;
      batch.bytes += job.size;
      batch.folders = [...new Set([...batch.folders, placed.folder])];
      batch.jpg += converted.jpg ? 1 : 0;
      batch.proxies += converted.proxy ? 1 : 0;
      batch.resumes = [...new Set([...batch.resumes, ...(job.resumeLines || [])])];
      job.verified = batch.verified;
      job.copied = batch.copied;
      job.folders = batch.folders;
      job.jpg = batch.jpg;
      job.proxies = batch.proxies;
      job.resumeLines = batch.resumes;
      job.left = Math.max(0, batch.total - batch.copied);
      await rm(job.descriptor, { force: true });
      jobs.delete(job.id);
      active = job;
      emit(hostDevice, 'unload', unloadView());
      send(200, { ok: true, path: finalPath, sha256: actual, folder: placed.folder, ...converted });
      return true;
    }
    const control = url.pathname.match(/^\/api\/unload\/([\da-f-]{36})\/(pause|resume)$/);
    if (req.method === 'POST' && control) {
      await readBody(req, 1024, fault);
      const job = jobs.get(control[1]) || active;
      if (!job) throw fault(404, 'Сейчас ничего не выгружается');
      job.phase = control[2] === 'pause' ? 'paused' : 'uploading';
      active = job;
      emit(hostDevice, 'unload', unloadView());
      send(200, publicJob(job)); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/unload/report') {
      if (!device.isHost && device.id === device.id) { /* phone or host may close a batch */ }
      const body = JSON.parse((await readBody(req, 256 * 1024, fault)).toString('utf8') || '{}');
      const stats = {
        copied: body.copied || 0, skipped: body.skipped || 0, errors: body.errors || 0, verified: body.verified || body.copied || 0,
        resumes: body.resumes || active?.resumeLines || [], folders: body.folders || active?.folders || [], proxies: body.proxies || active?.proxies || 0,
        jpg: body.jpg || active?.jpg || 0, bytes: body.bytes || 0,
      };
      const text = reportText(stats);
      const file = path.join(rootDir(), '_flydrop-report.txt');
      await mkdir(rootDir(), { recursive: true });
      await writeFile(file, text, { mode: 0o600 });
      vault.lastUnload = { ...stats, text, file, at: now(), line: notificationLine(stats) };
      await store.save();
      if (active) active.phase = 'done';
      try { onNotice({ title: 'Выгрузка завершена', body: notificationLine(stats) }); } catch { /* A toast cannot fail the report. */ }
      emit(hostDevice, 'unload', unloadView());
      send(200, vault.lastUnload); return true;
    }
    return false;
  }
  async function convertFile(file, job) {
    const result = { jpg: false, proxy: false, h264: false, notes: [] };
    if (!runPlan) return result;
    const base = path.basename(file, path.extname(file));
    try {
      if (flags().heicToJpg && isHeic(job.name, job.mime)) {
        const output = destination({ root: rootDir(), takenAt: job.takenAt, calendar: job.calendar, eventName: job.eventName, bucket: 'jpg', filename: `${base}.jpg` }).absolute;
        await mkdir(path.dirname(output), { recursive: true });
        await runPlan(heicPlan({ ffmpeg: process.env.FLYDROP_FFMPEG || 'ffmpeg', heif: process.env.FLYDROP_HEIF || '', input: file, output }));
        result.jpg = true;
      }
      if (isVideo(job.name, job.mime) && flags().hevcToH264) {
        const output = path.join(path.dirname(file), `${base}.mp4`);
        await runPlan(h264Plan({ ffmpeg: process.env.FLYDROP_FFMPEG || 'ffmpeg', input: file, output, encoder: process.platform === 'win32' ? 'h264_mf' : 'libopenh264' }));
        result.h264 = true;
      }
      if (isVideo(job.name, job.mime) && flags().makeProxy) {
        const output = destination({ root: rootDir(), takenAt: job.takenAt, calendar: job.calendar, eventName: job.eventName, bucket: 'proxy', filename: `${base}_proxy.mov` }).absolute;
        await mkdir(path.dirname(output), { recursive: true });
        await runPlan(proxyPlan({ ffmpeg: process.env.FLYDROP_FFMPEG || 'ffmpeg', input: file, output }));
        result.proxy = true;
      }
    } catch (error) {
      result.notes.push(error.message || 'Конвертер не запустился. Оригинал сохранён');
    }
    return result;
  }
  async function sweep() {
    const removed = history.sweep(now());
    for (const id of removed) {
      const stored = media.get(id);
      if (stored) { await rm(stored.path, { force: true }); media.delete(id); }
    }
    vault.bufferTokens = (vault.bufferTokens || []).filter(item => item.expiresAt > now());
    if (removed.length && flags().persist) await saveHistory();
    if (removed.length) publish();
  }
  return { route, ingest, sweep, view, unloadView, fromHost, forgetDevice, rootDir, publish };
}

async function moveIntoPlace(from, to, fault) {
  await mkdir(path.dirname(to), { recursive: true });
  for (let index = 0; index < 50; index++) {
    const candidate = index ? to.replace(/(\.[^.\\/]+)?$/, match => ` (${index})${match || ''}`) : to;
    try { await rename(from, candidate); return candidate; }
    catch (error) {
      if (error.code === 'EXDEV') {
        await writeFile(candidate, await readFile(from), { mode: 0o600 });
        await rm(from, { force: true });
        return candidate;
      }
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw fault(500, 'Не удалось записать файл в папку');
}

function formatBytes(value) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} МБ`;
  return `${value} Б`;
}
