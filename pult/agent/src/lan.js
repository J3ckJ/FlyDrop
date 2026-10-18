import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { isPrivateIPv4, plainIP } from './net.js';
import { safeExecFile } from './platform/spawn.js';

const VIRTUAL = /virtual|vethernet|hyper-?v|wsl|docker|virtualbox|vbox|vmware|vmnet|loopback|tap|tun|tunnel|vpn|tailscale|wireguard|hamachi|npcap|bluetooth|zerotier|nordlynx|cisco|anyconnect|fortinet|ppp|isatap|teredo|host-only|sangfor/i;
const WIFI = /wi-?fi|wlan|wireless|беспровод/i;
const ETHERNET = /ethernet|локальн|lan\b/i;

export function isLinkLocal(ip) {
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(plainIP(ip));
}

export function isVirtualAdapter(name) {
  return VIRTUAL.test(String(name || ''));
}

function isIpv4(entry) {
  return entry?.family === 'IPv4' || entry?.family === 4;
}

function usableMac(mac) {
  if (!mac || mac === '00:00:00:00:00:00') return '';
  return mac;
}

function nameRank(name) {
  if (WIFI.test(name)) return 0;
  if (ETHERNET.test(name) && !isVirtualAdapter(name)) return 1;
  return 2;
}

export function parseWindowsRoutePrint(text) {
  const routes = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)/.exec(line);
    if (!match) continue;
    routes.push({ gateway: match[1], address: match[2], metric: Number(match[3]), name: '' });
  }
  return routes.sort((a, b) => a.metric - b.metric);
}

export function parseLinuxProcRoute(text) {
  const routes = [];
  for (const line of String(text || '').split(/\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7 || parts[1] !== '00000000') continue;
    routes.push({ name: parts[0], gateway: hexIp(parts[2]), address: '', metric: Number(parts[6]) || 0 });
  }
  return routes.sort((a, b) => a.metric - b.metric);
}

export function parseDarwinRoute(text) {
  const gateway = /^\s*gateway:\s+(\S+)/m.exec(text)?.[1] || '';
  const name = /^\s*interface:\s+(\S+)/m.exec(text)?.[1] || '';
  if (!name && !gateway) return [];
  return [{ name, gateway, address: '', metric: 0 }];
}

function hexIp(hex) {
  const value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value)) return '';
  return [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255].join('.');
}

function matchesRoute(adapter, route) {
  if (route.address && route.address === adapter.address) return true;
  if (route.name && route.name === adapter.name) return true;
  return false;
}

export function describeAdapters(interfaceMap, routes = []) {
  const skipped = [];
  const physical = [];
  for (const [name, entries] of Object.entries(interfaceMap || {})) {
    for (const entry of entries || []) {
      if (!isIpv4(entry) || entry.internal) continue;
      const address = plainIP(entry.address);
      if (isLinkLocal(address)) {
        skipped.push({ name, address, reason: 'link-local' });
        continue;
      }
      if (!isPrivateIPv4(address)) continue;
      if (isVirtualAdapter(name)) {
        skipped.push({ name, address, reason: 'virtual' });
        continue;
      }
      physical.push({ name, address, mac: usableMac(entry.mac) });
    }
  }
  const unique = [];
  for (const adapter of physical) {
    if (!unique.some(item => item.address === adapter.address)) unique.push(adapter);
  }
  const routed = routes.filter(route => unique.some(adapter => matchesRoute(adapter, route)));
  const preferred = routed.length
    ? unique.filter(adapter => routed.some(route => matchesRoute(adapter, route)))
    : [...unique].sort((a, b) => nameRank(a.name) - nameRank(b.name) || a.name.localeCompare(b.name));
  const ordered = [];
  for (const route of routed) {
    const adapter = unique.find(item => matchesRoute(item, route));
    if (adapter && !ordered.some(item => item.address === adapter.address)) ordered.push(adapter);
  }
  for (const adapter of preferred) {
    if (!ordered.some(item => item.address === adapter.address)) ordered.push(adapter);
  }
  return { phone: ordered, skipped, gateway: routed.length > 0, foreignGateway: routes.length > 0 && routed.length === 0 };
}

export async function readDefaultRoutes(options = {}) {
  const platform = options.platform || process.platform;
  const exec = options.exec || run;
  try {
    if (platform === 'win32') {
      const { stdout } = await exec('route', ['print', '-4']);
      return parseWindowsRoutePrint(stdout);
    }
    if (platform === 'darwin') {
      const { stdout } = await exec('route', ['-n', 'get', 'default']);
      return parseDarwinRoute(stdout);
    }
    const text = options.routeText != null ? options.routeText : await readFile('/proc/net/route', 'utf8');
    return parseLinuxProcRoute(text);
  } catch {
    return [];
  }
}

export async function currentLan() {
  return describeAdapters(os.networkInterfaces(), await readDefaultRoutes());
}

async function run(file, args) {
  const result = await safeExecFile(file, args, { timeout: 8000 });
  return { code: result.blocked ? 1 : result.code, stdout: result.blocked ? '' : result.stdout, stderr: result.stderr };
}
