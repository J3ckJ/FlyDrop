import dgram from 'node:dgram';
import { isMac } from './protocol.js';

export function parseMac(mac) {
  if (!isMac(mac)) throw Object.assign(new Error('Некорректный MAC-адрес'), { code: 'mac' });
  return mac.split(/[:-]/).map(part => Number.parseInt(part, 16));
}

export function magicPacket(mac) {
  const bytes = parseMac(mac);
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let repeat = 0; repeat < 16; repeat++) {
    for (let index = 0; index < 6; index++) packet[6 + repeat * 6 + index] = bytes[index];
  }
  return packet;
}

export function sendMagicPacket(mac, { address = '255.255.255.255', port = 9 } = {}) {
  const packet = magicPacket(mac);
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  return new Promise((resolve, reject) => {
    const finish = error => {
      socket.close();
      if (error) reject(error);
      else resolve(packet);
    };
    socket.once('error', finish);
    socket.bind(0, () => {
      try { socket.setBroadcast(true); } catch (error) { finish(error); return; }
      socket.send(packet, port, address, finish);
    });
  });
}
