import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileProfile } from '../../../security.js';
import { isAllowedPeer, plainIP } from './net.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');

export function createPlainHandler(ctx) {
  return async (req, res) => {
    const ip = plainIP(req.socket.remoteAddress || '');
    if (!isAllowedPeer(ip, { allowLoopback: true })) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Только локальная сеть');
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && url.pathname === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok\n');
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/setup' || url.pathname === '/setup.html')) {
      const body = await readFile(path.join(WEB, 'setup.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/style.css') {
      const body = await readFile(path.join(WEB, 'style.css'));
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Content-Length': body.length });
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
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><meta charset="utf-8"><title>Пульт</title><p>Сначала откройте <a href="/setup">/setup</a>. Управление только по https. <a href="/ping">/ping</a> должен показать ok.</p>');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
  };
}

export function listenPlain(handler, port) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}
