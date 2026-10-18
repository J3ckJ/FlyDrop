import os from 'node:os';
import path from 'node:path';
import { createAgent } from './agent.js';
import { privateIPv4 } from './mdns.js';
import { openStore } from './store.js';

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return true;
  return value;
}

function defaultDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'Pult');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Pult');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'pult');
}

const dataDir = flag('--data') && flag('--data') !== true ? flag('--data') : defaultDir();

if (flag('--revoke')) {
  const store = await openStore(dataDir);
  const removed = await store.revoke(String(flag('--revoke')));
  console.log(removed ? 'Телефон удалён из сопряжённых.' : 'Такого телефона нет.');
  process.exit(0);
}

const agent = await createAgent({
  dataDir,
  name: flag('--name') && flag('--name') !== true ? String(flag('--name')) : os.hostname(),
  platform: flag('--mock') ? 'mock' : 'auto',
  port: flag('--port') && flag('--port') !== true ? Number(flag('--port')) : 4720,
  advertise: !flag('--no-mdns'),
  mockOs: flag('--os') && flag('--os') !== true ? String(flag('--os')) : 'windows',
});

const fly = agent.fly?.info?.() || null;
console.log('');
console.log('  Пульт');
console.log(`  Компьютер: ${agent.name} · ${agent.os}`);
console.log(`  Код сопряжения: ${agent.pairingCode}`);
console.log(`  Порт: ${agent.port}  ·  только локальная сеть`);
const addresses = privateIPv4();
for (const address of addresses) console.log(`  iPhone: https://${address}:${agent.port}/`);
if (!addresses.length) console.log(`  iPhone: https://<адрес компьютера>:${agent.port}/`);
console.log(`  На этом компьютере: https://localhost:${agent.port}/`);
console.log(`  Отпечаток: ${agent.fingerprint}`);
if (agent.mac) console.log(`  MAC для Wake-on-LAN: ${agent.mac}`);
if (fly?.external) console.log(`  FlyDrop уже запущен: https://…:${fly.httpsPort} — подтвердите телефон в его окне`);
else if (fly) console.log(`  FlyDrop внутри Пульта: HTTPS ${fly.httpsPort}, файлы до 1 ГБ`);
else console.log('  FlyDrop выключен');
console.log('');
console.log('  Телефон вводит этот код. Без кода управление недоступно.');
console.log('  Ctrl+C завершает работу.');
console.log('');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await agent.close();
    process.exit(0);
  });
}
