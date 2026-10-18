import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { createAgent } from './agent.js';
import { ensureWindowsFirewall, firewallCommand, firewallDisabled } from './firewall.js';
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
const primary = agent.lan.phone[0];
const phoneUrl = primary ? `https://${primary.address}:${agent.port}/` : '';
console.log('');
console.log('  Пульт');
console.log(`  Компьютер: ${agent.name} · ${agent.os}`);
console.log(`  Код сопряжения: ${agent.pairingCode}`);
console.log(`  Порт: ${agent.port}  ·  только локальная сеть`);
if (primary) {
  console.log(`  iPhone: ${phoneUrl}`);
  console.log(`  Адаптер: ${primary.name}`);
  if (agent.lan.foreignGateway) console.log('  Шлюз по умолчанию смотрит не в этот адаптер. iPhone должен быть в той же сети, что и адрес выше.');
  else if (!agent.lan.gateway) console.log('  Шлюз по умолчанию не найден. Если сетей несколько, сверьте адрес с Wi-Fi компьютера.');
  const qr = await QRCode.toString(phoneUrl, { type: 'utf8', errorCorrectionLevel: 'M', margin: 2 });
  console.log(qr.split('\n').map(line => (line ? `  ${line}` : '')).join('\n'));
  const extraLabel = agent.lan.gateway ? 'Другая сеть со шлюзом' : 'Ещё физический адаптер';
  for (const extra of agent.lan.phone.slice(1)) console.log(`  ${extraLabel}: https://${extra.address}:${agent.port}/  ·  ${extra.name}`);
} else {
  console.log(`  iPhone: https://<адрес Wi-Fi компьютера>:${agent.port}/`);
  console.log('  Не найден адаптер Wi-Fi или Ethernet в локальной сети.');
}
if (agent.lan.skipped.length) {
  console.log('  Не открывайте эти адреса на iPhone — это виртуальные или локальные адаптеры:');
  for (const item of agent.lan.skipped) console.log(`    ${item.name}  ${item.address}  ·  ${item.reason === 'link-local' ? '169.254, связи нет' : 'виртуальный адаптер'}`);
}
console.log(`  На этом компьютере: https://localhost:${agent.port}/`);
console.log(`  Отпечаток: ${agent.fingerprint}`);
if (agent.mac) console.log(`  MAC для Wake-on-LAN: ${agent.mac}`);
if (fly?.external) console.log(`  FlyDrop уже запущен: https://…:${fly.httpsPort} — подтвердите телефон в его окне`);
else if (fly) console.log(`  FlyDrop внутри Пульта: HTTPS ${fly.httpsPort}, файлы до 1 ГБ`);
else console.log('  FlyDrop выключен');
const firewallPorts = [agent.port, fly?.httpsPort].filter(Boolean);
let firewall = { notes: [] };
try {
  firewall = await ensureWindowsFirewall({
    ports: firewallPorts,
    adapterName: primary?.name,
    disabled: firewallDisabled(),
  });
} catch (error) {
  const command = firewallCommand(firewallPorts);
  firewall = {
    notes: [
      `Проверка брандмауэра не запустилась (${error.code || error.message}). Агент продолжает работу.`,
      command ? `Если iPhone не открывается, выполните от администратора: ${command}` : '',
    ].filter(Boolean),
  };
}
for (const note of firewall.notes) console.log(`  ${note}`);
console.log('');
console.log('  Телефон вводит этот код. Без кода управление недоступно.');
console.log('  Телефон и компьютер — в одной Wi-Fi. Сканируйте код или откройте строку iPhone.');
console.log('  Ctrl+C завершает работу.');
console.log('');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await agent.close();
    process.exit(0);
  });
}
