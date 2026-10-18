import https from 'node:https';
import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';
import { emptyVault, generateTLS } from '../../../security.js';
import { createHttpHandler } from './http.js';
import { encodeFrame } from './jpeg.js';
import { createPush } from './push.js';
import { advertise, primaryMac, privateIPv4 } from './mdns.js';
import { isAllowedPeer, plainIP } from './net.js';
import { startFlydrop } from './flydrop-bridge.js';
import { createPlatform } from './platform/index.js';
import { DEFAULT_PORT, LIMITS, errorMessage, eventMessage, parseMessage, resultMessage } from './protocol.js';
import { newCode, openStore } from './store.js';
import { sendMagicPacket } from './wol.js';
import { attachWebSocket } from './ws.js';

function equalCode(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return [...value.trim().replace(/[\u0000-\u001f\u007f]/g, '')].slice(0, LIMITS.maxName).join('');
}

export async function createAgent(options = {}) {
  const platform = options.platformApi || createPlatform(options.platform || 'auto', options.platformOptions);
  const directory = options.dataDir;
  if (!directory) throw new Error('Нужна папка данных');
  const store = options.store || await openStore(directory);
  const name = options.name || os.hostname() || 'Компьютер';
  const osName = options.os || (platform.kind === 'mock' ? (options.mockOs || 'windows') : platform.kind === 'macos' ? 'macos' : platform.kind === 'windows' ? 'windows' : 'linux');
  const addresses = privateIPv4();
  const vault = emptyVault();
  vault.hostName = name;
  const material = await generateTLS(vault, addresses);
  const sessions = new Set();
  const attempts = new Map();
  let pairingCode = options.pairingCode || newCode();
  let transfer = { active: false, name: '', loaded: 0, total: 0, state: 'idle' };
  const mac = options.mac || primaryMac();
  const nowFn = options.now || (() => new Date());

  const fly = options.flydrop === false ? null : await startFlydrop({
    port: options.flydropPort,
    securePort: options.flydropSecurePort,
    onPairing: request => { void considerFlydrop(request); },
    onReceived: item => {
      transfer = { active: false, name: item.name || item.text || '', loaded: item.size || 0, total: item.size || 0, state: 'done' };
      const notice = { source: 'FlyDrop', title: item.kind === 'file' ? 'Файл получен' : 'Текст получен', body: item.name || item.text || '', at: Date.now(), topic: 'pult-flydrop' };
      broadcast('event.notification', notice);
      void notify(notice);
      broadcast('event.flydrop', transfer);
    },
    onPresence: presence => {
      if (presence?.uploading && !transfer.active) transfer = { ...transfer, active: true, state: 'uploading' };
      if (presence && presence.uploading === false && transfer.state === 'uploading') transfer = { ...transfer, active: false };
    },
  });

  function peers() {
    return [...sessions].filter(session => session.paired).map(session => plainIP(session.peer));
  }

  async function considerFlydrop(request) {
    try {
      if (!fly || fly.external) return;
      if (!peers().includes(request.address)) return;
      await fly.approve(request.id, true);
    } catch { /* Телефон останется в очереди FlyDrop, если локальное подтверждение не удалось. */ }
  }

  function broadcast(type, payload) {
    const text = eventMessage(type, payload);
    for (const session of sessions) if (session.paired && session.socket.alive) session.socket.send(text);
  }

  async function publicInfo(paired) {
    const flyInfo = fly ? await (fly.current ? fly.current() : fly.info()) : null;
    return {
      name,
      os: osName,
      protocol: 1,
      paired,
      fingerprint: material.fingerprint,
      mac,
      demo: platform.kind === 'mock',
      flydrop: flyInfo ? {
        external: Boolean(flyInfo.external),
        httpPort: flyInfo.httpPort,
        httpsPort: flyInfo.httpsPort,
        fingerprint: flyInfo.fingerprint,
        ...(paired && !flyInfo.external ? { code: flyInfo.code, hostId: flyInfo.hostId } : {}),
      } : null,
    };
  }

  async function statusPayload() {
    const status = await platform.getStatus();
    const percent = transfer.total > 0 ? Math.round((transfer.loaded / transfer.total) * 100) : 0;
    return { ...status, name, os: osName, mac, online: true, flydrop: { ...transfer, percent } };
  }

  function failLimit(ip) {
    const now = Date.now();
    const prior = attempts.get(ip);
    const slot = prior && prior.until > now ? prior : { count: 0, until: now + LIMITS.pairingWindowMs };
    if (slot.count >= LIMITS.pairingAttempts) throw new Error('Слишком много попыток. Подождите минуту');
    slot.count += 1;
    attempts.set(ip, slot);
  }

  async function handle(session, message) {
    const { type, payload } = message;
    if (!session.paired && type !== 'hello' && type !== 'pair') throw new Error('Сначала сопряжение');
    switch (type) {
      case 'hello': {
        const device = payload.token ? store.findToken(payload.token) : null;
        if (payload.token && !device) throw new Error('Телефон не сопряжён');
        session.paired = Boolean(device);
        session.device = device;
        if (device) await store.touch(device.id);
        return await publicInfo(session.paired);
      }
      case 'pair': {
        if (!equalCode(payload.code, pairingCode)) {
          failLimit(session.peer);
          throw new Error('Неверный код. Он показан на компьютере');
        }
        const saved = await store.remember({ name: cleanName(payload.name) || session.pendingName || 'iPhone' });
        session.paired = true;
        session.device = saved.device;
        pairingCode = newCode();
        return { ...(await publicInfo(true)), token: saved.token, deviceId: saved.device.id };
      }
      case 'status.get':
        return statusPayload();
      case 'screen.subscribe':
        startScreen(session, payload.fps || LIMITS.defaultFps);
        return { fps: payload.fps || LIMITS.defaultFps };
      case 'screen.unsubscribe':
        stopScreen(session);
        return {};
      case 'input.move':
        await platform.move(payload.dx, payload.dy);
        return {};
      case 'input.click':
        await platform.click(payload.button || 'left', payload.count || 1);
        return {};
      case 'input.scroll':
        await platform.scroll(payload.dx, payload.dy);
        return {};
      case 'input.key':
        await platform.key(payload.key, payload.down, payload.modifiers || []);
        return {};
      case 'input.text':
        await platform.typeText(payload.text);
        return {};
      case 'volume.set':
        if (payload.level !== undefined) await platform.setVolume(payload.level);
        if (payload.muted !== undefined) await platform.setMuted(payload.muted);
        return statusPayload();
      case 'media.command':
        await platform.media(payload.action);
        broadcast('event.media', await statusPayload());
        return statusPayload();
      case 'apps.list':
        return { apps: await platform.listApps() };
      case 'apps.launch':
        return { app: await platform.launchApp(payload.id) };
      case 'clipboard.get':
        return { text: await platform.getClipboard() };
      case 'clipboard.set':
        await platform.setClipboard(payload.text);
        broadcast('event.clipboard', { text: payload.text, from: name, at: Date.now() });
        return {};
      case 'notifications.list':
        return { items: await platform.pollNotifications() };
      case 'power.action':
        return power(payload);
      case 'wol.wake':
        await sendMagicPacket(payload.mac);
        return { sent: true };
      case 'wol.schedule.list':
        return { schedules: store.data.schedules };
      case 'wol.schedule.put':
        return { schedule: await store.putSchedule(payload) };
      case 'wol.schedule.delete':
        await store.deleteSchedule(payload.id);
        return {};
      case 'flydrop.progress':
        transfer = {
          active: payload.state === 'uploading',
          name: payload.name,
          loaded: payload.loaded,
          total: payload.total,
          state: payload.state,
        };
        const percent = payload.total ? Math.round((payload.loaded / payload.total) * 100) : 0;
        broadcast('event.flydrop', { ...transfer, percent });
        void notify({ title: 'FlyDrop', body: `${payload.name} · ${percent}%`, topic: 'pult-flydrop', percent });
        return { accepted: true };
      case 'flydrop.info':
        return (await publicInfo(true)).flydrop;
      default: {
        const unknown = type;
        throw new Error(`Команда не обработана: ${unknown}`);
      }
    }
  }

  async function power(payload) {
    if (payload.action === 'shutdown' && payload.hold !== true) throw new Error('Выключение только удержанием');
    if ((payload.action === 'shutdown' || payload.action === 'restart') && transfer.active && payload.force !== true) {
      const percent = transfer.total ? Math.round((transfer.loaded / transfer.total) * 100) : 0;
      return { performed: false, warning: `FlyDrop ещё идёт: ${percent}% — выключение подождёт`, transfer: { ...transfer, percent } };
    }
    await platform.power(payload.action);
    return { performed: true };
  }

  function stopScreen(session) {
    if (session.screen) clearTimeout(session.screen);
    session.screen = null;
    session.streaming = false;
  }

  function startScreen(session, fps) {
    stopScreen(session);
    session.streaming = true;
    const interval = Math.round(1000 / Math.min(LIMITS.maxFps, Math.max(1, fps)));
    const pump = async () => {
      if (!session.streaming || !session.socket.alive) return;
      const started = Date.now();
      try {
        const frame = await platform.captureFrame();
        if (frame.jpeg.length > LIMITS.maxFrameBytes) throw new Error('Кадр больше 1 МБ');
        session.seq = (session.seq || 0) + 1;
        session.socket.sendBinary(encodeFrame(frame.jpeg, { seq: session.seq, width: frame.width, height: frame.height }));
      } catch (error) {
        session.socket.send(eventMessage('event.screen', { error: error.message }));
      }
      if (!session.streaming) return;
      const wait = Math.max(0, interval - (Date.now() - started));
      session.screen = setTimeout(pump, wait);
    };
    session.screen = setTimeout(pump, 0);
  }

  const push = await createPush(store);
  const notify = payload => push.notify(payload).catch(() => {});
  const server = https.createServer({ key: material.key, cert: material.cert, minVersion: 'TLSv1.2' }, createHttpHandler({
    material,
    hostId: store.data.hostId,
    push,
    fly,
    authorize: token => store.findToken(token),
  }));
  server.on('connection', socket => {
    if (!isAllowedPeer(socket.remoteAddress, { allowLoopback: options.allowLoopback !== false })) socket.destroy();
  });
  if (fly?.app) {
    for (const endpoint of [fly.app.server, fly.app.secureServer]) {
      endpoint.on('connection', socket => {
        if (!isAllowedPeer(socket.remoteAddress, { allowLoopback: true })) socket.destroy();
      });
    }
  }
  attachWebSocket(server, (socket, peer) => {
    if (!isAllowedPeer(peer, { allowLoopback: options.allowLoopback !== false })) {
      socket.close(1008, 'Только локальная сеть');
      return;
    }
    if (sessions.size >= LIMITS.maxSessions) {
      socket.close(1013, 'Слишком много подключений');
      return;
    }
    const session = { socket, peer: plainIP(peer), paired: false, device: null, streaming: false, screen: null, seq: 0 };
    sessions.add(session);
    socket.on('text', raw => {
      const parsed = parseMessage(raw);
      if (parsed.error) {
        socket.send(errorMessage(null, parsed.error));
        return;
      }
      if (parsed.message.type === 'hello' && parsed.message.payload.name) session.pendingName = cleanName(parsed.message.payload.name);
      handle(session, parsed.message).then(payload => {
        socket.send(resultMessage(parsed.message, payload));
      }).catch(error => {
        socket.send(errorMessage(parsed.message, error.message));
      });
    });
    socket.on('close', () => {
      stopScreen(session);
      sessions.delete(session);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, options.host || '0.0.0.0', resolve);
  });
  const port = server.address().port;
  const discovery = options.advertise === false ? null : advertise({
    instance: name.replace(/[^\w\- .а-яА-ЯёЁ]/gu, '').trim() || 'Pult',
    host: `${vault.hostId.slice(0, 8)}.local`,
    port,
    addresses: addresses.length ? addresses : ['127.0.0.1'],
    txt: { os: osName, ver: '1', fp: material.fingerprint.replaceAll(':', '').slice(0, 16), fly: String(fly?.info().httpsPort || 0) },
  });

  const timer = setInterval(() => { void tickSchedules(); }, options.scheduleInterval || 15000);
  timer.unref?.();

  async function tickSchedules() {
    const current = nowFn();
    const key = `${current.getFullYear()}-${current.getMonth() + 1}-${current.getDate()}`;
    for (const schedule of [...store.data.schedules]) {
      if (schedule.hour !== current.getHours() || schedule.minute !== current.getMinutes() || schedule.lastFiredDate === key) continue;
      await store.markSchedule(schedule.id, key);
      await (options.wake || sendMagicPacket)(schedule.mac);
      broadcast('event.wol', { id: schedule.id, mac: schedule.mac, label: schedule.label });
    }
  }

  return {
    port,
    name,
    os: osName,
    mac,
    fingerprint: material.fingerprint,
    ca: material.ca,
    material,
    platform,
    store,
    fly,
    get pairingCode() { return pairingCode; },
    info: paired => publicInfo(Boolean(paired)),
    tickSchedules,
    broadcast,
    async revoke(id) { return store.revoke(id); },
    async close() {
      clearInterval(timer);
      discovery?.close();
      for (const session of sessions) {
        stopScreen(session);
        session.socket.close(1001, 'Агент останавливается');
      }
      if (platform.close) platform.close();
      await fly?.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
