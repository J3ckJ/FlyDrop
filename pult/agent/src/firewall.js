const RULE = 'Pult';

export function resetFirewallGuard() {}

export function firewallDisabled(argv = process.argv, env = process.env) {
  if (argv.includes('--no-firewall')) return true;
  const value = env.PULT_NO_FIREWALL;
  return value === '1' || value === 'true';
}

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

export function planFirewall({ ports, adapterName, profiles, rules }) {
  const list = normalizePorts(ports);
  const matched = profiles.find(item => item.name.toLowerCase() === String(adapterName || '').toLowerCase());
  const kind = matched ? profileKind(matched.category) : 'unknown';
  const missing = list.filter(port => !firewallAllowsPort(rules[port] || rules['*'] || '', port));
  const notes = [];
  if (kind === 'public') {
    notes.push(`Сеть «${adapterName || 'Wi-Fi'}» сейчас общедоступная. Windows не пускает iPhone на компьютер в общедоступной сети.`);
    notes.push('Параметры → Сеть и Интернет → Wi-Fi → ваша сеть → тип профиля сети → Частная.');
    notes.push('Правило брандмауэра для общедоступной сети Пульт не добавляет.');
    return { kind, missing, apply: false, notes };
  }
  if (kind === 'domain') {
    notes.push(`Сеть «${adapterName || 'Ethernet'}» в домене. Правило частной сети на неё не действует, пока профиль не станет частным.`);
  }
  if (!missing.length) {
    notes.push(`Брандмауэр: входящие TCP ${list.join(' и ')} уже разрешены для частной сети.`);
    return { kind, missing, apply: false, notes };
  }
  notes.push(`Брандмауэр: для частной сети нет входящего правила на TCP ${missing.join(' и ')}. Его добавляет pult.exe.`);
  return { kind, missing, apply: true, notes };
}

export async function ensureWindowsFirewall({ ports, platform = process.platform, disabled = false } = {}) {
  if (platform !== 'win32') return { applied: false, notes: [], skipped: false };
  const list = normalizePorts(ports);
  if (disabled) {
    return { applied: false, skipped: true, notes: [`Проверка брандмауэра выключена (--no-firewall / PULT_NO_FIREWALL). Порт ${list.join(', ') || String(RULE)} не менялся.`] };
  }
  return {
    applied: false,
    skipped: true,
    notes: ['Правило брандмауэра для частной сети добавляет pult.exe через API Windows. Команда node правило не создаёт.'],
  };
}

function normalizePorts(ports) {
  return [...new Set((ports || []).map(port => Number(port)).filter(port => Number.isInteger(port) && port > 0 && port < 65536))];
}
