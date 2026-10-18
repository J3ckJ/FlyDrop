import dgram from 'node:dgram';
import os from 'node:os';
import { SERVICE_TYPE } from './protocol.js';
import { isPrivateIPv4 } from './net.js';

function encodeName(name) {
  const labels = name.replace(/\.$/, '').split('.');
  const parts = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    if (!bytes.length || bytes.length > 63) throw new Error('Некорректное имя mDNS');
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function record(name, type, clas, ttl, data) {
  const suffix = Buffer.alloc(10);
  suffix.writeUInt16BE(type, 0);
  suffix.writeUInt16BE(clas, 2);
  suffix.writeUInt32BE(ttl, 4);
  suffix.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), suffix, data]);
}

function ptrData(target) {
  return encodeName(target);
}

function srvData(port, target) {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(port, 4);
  return Buffer.concat([head, encodeName(target)]);
}

function txtData(entries) {
  const chunks = Object.entries(entries).map(([key, value]) => {
    const text = Buffer.from(`${key}=${value}`, 'utf8');
    if (text.length > 255) throw new Error('Слишком длинная TXT-запись');
    return Buffer.concat([Buffer.from([text.length]), text]);
  });
  return chunks.length ? Buffer.concat(chunks) : Buffer.from([0]);
}

function aData(ip) {
  return Buffer.from(ip.split('.').map(part => Number(part)));
}

export function buildAnnouncement({ instance, host, port, addresses, txt, ttl = 120 }) {
  const service = SERVICE_TYPE;
  const instanceName = `${instance}.${service}`;
  const answers = [];
  for (const address of addresses) {
    answers.push(record(service, 12, 0x8001, ttl, ptrData(instanceName)));
    answers.push(record(instanceName, 33, 0x8001, ttl, srvData(port, host)));
    answers.push(record(instanceName, 16, 0x8001, ttl, txtData(txt)));
    answers.push(record(host, 1, 0x8001, ttl, aData(address)));
  }
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, ...answers]);
}

export function privateIPv4() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) found.push(entry.address);
    }
  }
  return [...new Set(found)];
}

export function primaryMac() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.mac && entry.mac !== '00:00:00:00:00:00') return entry.mac;
    }
  }
  return null;
}

export function advertise({ instance, host, port, txt, addresses = privateIPv4() }) {
  if (!addresses.length) return { close() {}, packet: null };
  const packet = buildAnnouncement({ instance, host, port, addresses, txt });
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timer;
  const send = () => {
    for (const address of addresses) {
      try { socket.setMulticastInterface?.(address); } catch { /* Some platforms pick the interface themselves. */ }
      socket.send(packet, 5353, '224.0.0.251');
    }
  };
  socket.on('error', () => { /* Discovery is optional; the phone can enter the address. */ });
  socket.bind(5353, () => {
    try {
      socket.setMulticastTTL(255);
      socket.addMembership('224.0.0.251');
    } catch { /* Announcements still go out if membership fails. */ }
    send();
    timer = setInterval(send, 8000);
    timer.unref?.();
  });
  return {
    packet,
    close() {
      clearInterval(timer);
      socket.close();
    },
  };
}
