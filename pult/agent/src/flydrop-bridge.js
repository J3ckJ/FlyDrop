import http from 'node:http';
import https from 'node:https';
import { emptyVault } from '../../../security.js';
import { createApp } from '../../../server.js';

function cookies(response) {
  return response.headers['set-cookie']?.map(value => value.split(';')[0]).join('; ') || '';
}

function request(app, route, { method = 'GET', body, cookie = '', headers = {} } = {}) {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: app.port,
      path: route,
      method,
      headers: {
        Host: `127.0.0.1:${app.port}`,
        Origin: `http://127.0.0.1:${app.port}`,
        Cookie: cookie,
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        let value;
        try { value = JSON.parse(raw.toString('utf8')); } catch { value = null; }
        resolve({ status: response.statusCode, headers: response.headers, value, raw });
      });
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

function httpsRequest(app, route, { method = 'GET', body, cookie = '', headers = {}, localAddress = '127.0.0.2' } = {}) {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port: app.securePort,
      path: route,
      method,
      ca: app.material.ca,
      servername: 'localhost',
      localAddress,
      headers: {
        Host: `127.0.0.1:${app.securePort}`,
        Origin: `https://127.0.0.1:${app.securePort}`,
        Cookie: cookie,
        ...(bytes && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...(bytes ? { 'Content-Length': bytes.length } : {}),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        let value = null;
        try { value = JSON.parse(raw.toString('utf8')); } catch { value = null; }
        resolve({ status: response.statusCode, headers: response.headers, value, raw });
      });
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

async function hostCookie(app) {
  const response = await request(app, '/api/connect', {
    method: 'POST',
    body: {},
    headers: { 'X-FlyDrop-Desktop': app.desktopKey },
  });
  if (response.status !== 200) throw new Error('Не удалось открыть локальный сеанс FlyDrop');
  return cookies(response);
}

export async function probeExternalFlydrop() {
  try {
    const health = await new Promise((resolve, reject) => {
      const req = http.get('http://127.0.0.1:4317/health', response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
        });
      });
      req.setTimeout(800, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
    if (health?.app !== 'FlyDrop' || !health.securePort) return null;
    return { external: true, httpPort: 4317, httpsPort: health.securePort, code: null, fingerprint: null };
  } catch {
    return null;
  }
}

export async function startFlydrop({ onPairing, onReceived, onPresence, port = 0, securePort = 0 } = {}) {
  const external = port === 0 && securePort === 0 ? await probeExternalFlydrop() : null;
  if (external) {
    return {
      external: true,
      info: () => external,
      async approve() { return false; },
      async close() {},
    };
  }
  const vaultStore = { value: emptyVault(), save: async () => {}, flush: async () => {} };
  let app;
  try {
    app = await createApp({ port, securePort, host: '0.0.0.0', vaultStore, onPairing, onReceived, onPresence });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      const found = await probeExternalFlydrop();
      if (found) return { external: true, info: () => found, async approve() { return false; }, async close() {} };
    }
    throw error;
  }
  const cookie = await hostCookie(app);
  const presence = http.get({
    hostname: '127.0.0.1',
    port: app.port,
    path: '/api/events',
    headers: { Host: `127.0.0.1:${app.port}`, Cookie: cookie },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('FlyDrop не открыл присутствие компьютера')), 3000);
    presence.once('error', error => { clearTimeout(timer); reject(error); });
    presence.once('response', response => {
      response.on('data', () => {});
      response.once('data', () => { clearTimeout(timer); resolve(); });
    });
  });
  return {
    external: false,
    app,
    info() {
      const state = app.getState();
      return {
        external: false,
        httpPort: app.port,
        httpsPort: app.securePort,
        code: state.security.pairingCode,
        fingerprint: state.security.fingerprint,
        hostId: state.self.id,
        pairingExpiresAt: state.security.pairingExpiresAt,
      };
    },
    async current() {
      if (this.info().pairingExpiresAt < Date.now()) {
        await request(app, '/api/pairing/rotate', { method: 'POST', cookie, body: {} });
      }
      return this.info();
    },
    async approve(id, remember = true) {
      const response = await request(app, `/api/pairings/${id}/approve`, { method: 'POST', cookie, body: { remember } });
      return response.status === 200;
    },
    async openRelay() {
      if (this.relay) return this.relay;
      const info = this.info();
      const pending = await httpsRequest(app, '/api/connect', { method: 'POST', body: { code: info.code, name: 'Пульт', type: 'phone' } });
      if (pending.status !== 202) throw Object.assign(new Error(pending.value?.error || 'FlyDrop не принял Пульт'), { status: pending.status || 502 });
      await this.approve(pending.value.requestId, true);
      let ready;
      for (let attempt = 0; attempt < 20; attempt++) {
        ready = await httpsRequest(app, '/api/pair-status', { method: 'POST', body: { requestId: pending.value.requestId, token: pending.value.token } });
        if (ready.status === 200) break;
        await this.approve(pending.value.requestId, true);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      if (ready.status !== 200) throw Object.assign(new Error(ready.value?.error || 'FlyDrop не подтвердил Пульт'), { status: 502 });
      this.relay = { cookie: cookies(ready), hostId: info.hostId };
      return this.relay;
    },
    upload(filename, size, source) {
      return this.openRelay().then(relay => new Promise((resolve, reject) => {
        const req = https.request({
          hostname: '127.0.0.1',
          port: app.securePort,
          path: '/api/upload',
          method: 'POST',
          ca: app.material.ca,
          servername: 'localhost',
          localAddress: '127.0.0.2',
          headers: {
            Host: `127.0.0.1:${app.securePort}`,
            Origin: `https://127.0.0.1:${app.securePort}`,
            Cookie: relay.cookie,
            'Content-Type': 'application/octet-stream',
            'Content-Length': size,
            'X-Recipient': relay.hostId,
            'X-Filename': encodeURIComponent(filename),
          },
        }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            let value = null;
            try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { value = null; }
            if (response.statusCode >= 400) reject(Object.assign(new Error(value?.error || 'FlyDrop отклонил файл'), { status: response.statusCode }));
            else resolve(value);
          });
        });
        req.on('error', reject);
        source.on('error', reject);
        source.pipe(req);
      }));
    },
    async close() { presence.destroy(); await app.close(); },
  };
}
