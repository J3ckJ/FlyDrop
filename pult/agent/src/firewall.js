import { safeExecFile } from './platform/spawn.js';

const RULE = 'Pult';
let skipReason = '';

export function resetFirewallGuard() {
  skipReason = '';
}

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

export function netshProfileKinds(text) {
  const raw = String(text || '');
  const kinds = [];
  if (/Public Profile Settings/i.test(raw)) kinds.push('public');
  if (/Private Profile Settings/i.test(raw)) kinds.push('private');
  if (/Domain Profile Settings/i.test(raw)) kinds.push('domain');
  return kinds;
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

export async function ensureWindowsFirewall({ ports, adapterName, platform = process.platform, exec = defaultExec, disabled = false } = {}) {
  if (platform !== 'win32') return { applied: false, notes: [], skipped: false };
  const list = normalizePorts(ports);
  const command = firewallCommand(list);
  if (disabled) {
    const note = command
      ? `Проверка брандмауэра выключена (--no-firewall / PULT_NO_FIREWALL). Если iPhone не открывается: ${command}`
      : 'Проверка брандмауэра выключена (--no-firewall / PULT_NO_FIREWALL).';
    return { applied: false, skipped: true, command, notes: [note] };
  }
  if (skipReason) return { applied: false, skipped: true, blocked: true, command, notes: skipReason.split('\n') };
  try {
    const profileRun = await exec('netsh', ['advfirewall', 'show', 'currentprofile']);
    if (profileRun?.blocked) return lockSkip(list, blockedNotes(list, profileRun));
    const kinds = netshProfileKinds(profileRun?.stdout || '');
    if (kinds.includes('public') && (kinds.includes('private') || kinds.includes('domain'))) {
      const notes = [
        'Сейчас активны и частный, и общедоступный профили. Правило Пульт не добавляет, чтобы не открыть общедоступную сеть.',
      ];
      if (command) notes.push(`Если сеть iPhone частная, выполните от администратора: ${command}`);
      return { applied: false, skipped: false, command, notes };
    }
    const rules = {};
    for (const port of list) {
      const shown = await exec('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in', 'protocol=tcp', `localport=${port}`]);
      if (shown?.blocked) return lockSkip(list, blockedNotes(list, shown));
      rules[port] = shown?.stdout || '';
    }
    const category = kinds.includes('public') ? 'public' : kinds.includes('domain') ? 'domain' : kinds.includes('private') ? 'private' : '';
    const profiles = category ? [{ name: adapterName || '', category }] : [];
    const plan = planFirewall({ ports: list, adapterName, profiles, rules });
    let applied = false;
    if (plan.apply && plan.command) {
      const added = await exec('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${RULE}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${plan.missing.join(',')}`, 'profile=private']);
      if (added?.blocked) return lockSkip(list, blockedNotes(list, added));
      applied = added?.code === 0;
      if (applied) plan.notes.push('Правило брандмауэра для частной сети добавлено.');
      else plan.notes.push('Добавить правило не удалось: запустите команду выше от администратора.');
    }
    return { applied, notes: plan.notes, command: plan.command, skipped: false };
  } catch (error) {
    return lockSkip(list, blockedNotes(list, error));
  }
}

function lockSkip(ports, notes) {
  skipReason = notes.join('\n');
  return { applied: false, skipped: true, blocked: true, command: firewallCommand(ports), notes };
}

function blockedNotes(ports, error) {
  const command = firewallCommand(ports);
  const why = error?.killed ? 'таймаут' : (error?.code || 'ошибка запуска');
  const notes = [`Проверка брандмауэра не запустилась (${why}). Агент продолжает работу.`];
  if (command) notes.push(`Если iPhone не открывается, выполните от администратора: ${command}`);
  notes.push('Повтор в этом запуске пропущен. Отключить проверку: --no-firewall или PULT_NO_FIREWALL=1.');
  return notes;
}

function normalizePorts(ports) {
  return [...new Set((ports || []).map(port => Number(port)).filter(port => Number.isInteger(port) && port > 0 && port < 65536))];
}

function defaultExec(file, args) {
  return safeExecFile(file, args, { timeout: 20000 });
}
