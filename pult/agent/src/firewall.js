import { execFile } from 'node:child_process';

const RULE = 'Pult';

export function parseConnectionProfiles(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  let data;
  try { data = JSON.parse(trimmed); } catch { return []; }
  const list = Array.isArray(data) ? data : [data];
  return list.filter(item => item && typeof item === 'object').map(item => ({
    name: String(item.InterfaceAlias || item.Name || ''),
    category: item.NetworkCategory,
  }));
}

export function profileKind(category) {
  if (category === 0 || category === '0' || /^public$/i.test(String(category || ''))) return 'public';
  if (category === 1 || category === '1' || /^private$/i.test(String(category || ''))) return 'private';
  if (category === 2 || category === '2' || /domain/i.test(String(category || ''))) return 'domain';
  return 'unknown';
}

export function firewallAllowsPort(text, port) {
  const blocks = String(text || '').split(/\r?\n(?=Rule Name:)/);
  for (const block of blocks) {
    if (!/Enabled:\s+Yes/i.test(block) || !/Action:\s+Allow/i.test(block)) continue;
    const profiles = /Profiles:\s+(.+)/i.exec(block)?.[1] || '';
    if (!/private|any/i.test(profiles)) continue;
    const local = /LocalPort:\s+(.+)/i.exec(block)?.[1] || '';
    const ports = local.split(/[^\d]+/).filter(Boolean);
    if (/^any$/i.test(local.trim()) || ports.includes(String(port))) return true;
  }
  return false;
}

export function firewallCommand(ports) {
  const list = normalizePorts(ports);
  if (!list.length) return '';
  return `netsh advfirewall firewall add rule name="${RULE}" dir=in action=allow protocol=TCP localport=${list.join(',')} profile=private`;
}

export function planFirewall({ ports, adapterName, profiles, rules }) {
  const list = normalizePorts(ports);
  const matched = profiles.find(item => item.name.toLowerCase() === String(adapterName || '').toLowerCase());
  const kind = matched ? profileKind(matched.category) : 'unknown';
  const missing = list.filter(port => !firewallAllowsPort(rules[port] || rules['*'] || '', port));
  const notes = [];
  const command = missing.length ? firewallCommand(missing) : '';
  if (kind === 'public') {
    notes.push(`Сеть «${adapterName || 'Wi-Fi'}» сейчас общедоступная. Windows не пускает iPhone на компьютер в общедоступной сети.`);
    notes.push('Параметры → Сеть и Интернет → Wi-Fi → ваша сеть → тип профиля сети → Частная.');
    notes.push('Правило брандмауэра для общедоступной сети Пульт не добавляет.');
    if (command) notes.push(`Когда сеть станет частной, выполните от администратора: ${command}`);
    return { kind, missing, command, apply: false, notes };
  }
  if (kind === 'domain') {
    notes.push(`Сеть «${adapterName || 'Ethernet'}» в домене. Правило частной сети на неё не действует, пока профиль не станет частным.`);
  }
  if (!missing.length) {
    notes.push(`Брандмауэр: входящие TCP ${list.join(' и ')} уже разрешены для частной сети.`);
    return { kind, missing, command: '', apply: false, notes };
  }
  notes.push(`Брандмауэр: для частной сети нет входящего правила на TCP ${missing.join(' и ')}.`);
  notes.push(`Если окно не от администратора, выполните один раз: ${command}`);
  return { kind, missing, command, apply: true, notes };
}

export async function ensureWindowsFirewall({ ports, adapterName, platform = process.platform, exec = defaultExec } = {}) {
  if (platform !== 'win32') return { applied: false, notes: [] };
  const list = normalizePorts(ports);
  const profileRun = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress']);
  const rules = {};
  for (const port of list) {
    const shown = await exec('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in', 'protocol=tcp', `localport=${port}`]);
    rules[port] = shown.stdout || '';
  }
  const plan = planFirewall({
    ports: list,
    adapterName,
    profiles: parseConnectionProfiles(profileRun.stdout || ''),
    rules,
  });
  let applied = false;
  if (plan.apply && plan.command) {
    const added = await exec('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${RULE}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${plan.missing.join(',')}`, 'profile=private']);
    applied = added.code === 0;
    if (applied) plan.notes.push('Правило брандмауэра для частной сети добавлено.');
    else plan.notes.push('Добавить правило не удалось: запустите команду выше от администратора.');
  }
  return { applied, notes: plan.notes, command: plan.command };
}

function normalizePorts(ports) {
  return [...new Set((ports || []).map(port => Number(port)).filter(port => Number.isInteger(port) && port > 0 && port < 65536))];
}

function defaultExec(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code || 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
