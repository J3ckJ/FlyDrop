import { SHOTS } from './shot-fixtures.js';
import { createSha256 } from './sha256.js';

const MAX_UNLOAD = 64 * 1024 ** 3;
const tr = (ru, en) => (document.documentElement.lang === 'en' ? en : ru);
const pad = value => String(value).padStart(2, '0');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function svg(markup, width, height) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  element.setAttribute('width', String(width));
  element.setAttribute('height', String(height));
  element.setAttribute('viewBox', '0 0 24 24');
  element.setAttribute('fill', 'none');
  element.setAttribute('stroke', 'currentColor');
  element.setAttribute('stroke-width', '2');
  element.setAttribute('stroke-linecap', 'round');
  element.setAttribute('stroke-linejoin', 'round');
  element.setAttribute('aria-hidden', 'true');
  element.innerHTML = markup;
  return element;
}
const ICONS = {
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-4.5"/>',
  note: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  refresh: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/>',
  wifi: '<path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0"/><path d="M3 3l18 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
};
function icon(name, size = 18) { return svg(ICONS[name] || ICONS.note, size, size); }
function bytes(size) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let index = 0;
  let value = size || 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  const shown = index === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 0 : 1).replace('.', ',');
  return `${shown} ${units[index]}`;
}
function ago(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return tr(`${seconds} с назад`, `${seconds}s ago`);
  if (seconds < 3600) return tr(`${Math.round(seconds / 60)} мин назад`, `${Math.round(seconds / 60)} min ago`);
  if (seconds < 86400 * 2) return seconds < 86400 ? tr('сегодня', 'today') : tr('вчера', 'yesterday');
  return new Date(ts).toLocaleDateString(document.documentElement.lang === 'en' ? 'en-GB' : 'ru-RU');
}
function remain(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}
function calendarDay(ms) {
  const date = new Date(ms || Date.now());
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
async function hashBlob(file) {
  const hash = createSha256();
  const reader = file.stream().getReader();
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    hash.update(step.value);
  }
  return hash.hex();
}
function showCopyDialog(text) {
  const dialog = document.getElementById('copy-dialog');
  const area = document.getElementById('copy-value');
  if (!dialog || !area) return 'failed';
  area.value = text;
  if (!dialog.open) dialog.showModal();
  return 'manual';
}
async function copyText(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(area);
  area.focus();
  area.select();
  let legacy = false;
  try { legacy = document.execCommand('copy'); } catch { legacy = false; }
  area.remove();
  if (legacy) return 'copied';
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return showCopyDialog(text);
  }
}
async function userVerified() {
  if (!window.PublicKeyCredential) return false;
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'FlyDrop' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'flydrop', displayName: 'FlyDrop' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { userVerification: 'required', authenticatorAttachment: 'platform' },
        timeout: 20000,
      },
    });
    return Boolean(cred);
  } catch {
    return false;
  }
}

export function startModes({ api, toast, desktop, showView }) {
  const params = new URLSearchParams(location.search);
  const shot = params.get('shot');
  if (shot) {
    document.body.classList.add('fd-shot');
    const root = node('div', 'shot-root');
    const markup = SHOTS[shot];
    if (!markup) root.textContent = 'Нет такого кадра';
    else root.innerHTML = markup;
    document.body.append(root);
    const loading = document.getElementById('loading');
    if (loading) loading.hidden = true;
    return { shot: true, apply() {}, buffer() {}, unload() {}, online() {}, viewChanged() {} };
  }

  const forced = params.get('ui');
  const narrow = window.matchMedia('(max-width: 760px)');
  const phoneUA = /iPhone|Android.*Mobile/i.test(navigator.userAgent);
  let buffer = { items: [], online: false, peerName: 'Windows ПК', settings: {} };
  let unload = { phase: 'idle', folder: '', settings: {}, hint: null, thumbs: [], job: null, report: null };
  let queue = [];
  let linkUp = true;
  let bufferScreen = 'list';
  let uploadScreen = 'pick';
  let draft = '';
  let hostDraft = '';
  let eventName = '';
  let run = null;
  let paused = false;
  let resumeWait = null;
  let wakeLock = null;
  let host = false;
  const localStats = { copied: 0, skipped: 0, errors: 0, verified: 0, proxies: 0, bytes: 0, folders: [], resumes: [], current: '', fileDone: 0, fileSize: 0, bytesDone: 0, bytesTotal: 0, left: 0, total: 0 };

  function phoneLayout() {
    if (forced === 'phone') return true;
    if (forced === 'win') return false;
    return !desktop && (narrow.matches || phoneUA);
  }
  function syncChrome() {
    const phone = phoneLayout();
    document.body.classList.toggle('phone-ui', phone);
    document.body.classList.toggle('win-ui', !phone && (forced === 'win' || Boolean(desktop)));
    const bar = document.getElementById('winbar');
    if (bar) bar.hidden = !document.body.classList.contains('win-ui');
    const theme = document.querySelector('meta[name="theme-color"]');
    if (theme) theme.setAttribute('content', phone ? '#0b0c0e' : '#f7f8f5');
  }
  function segment(active) {
    const bar = node('div', 'seg glass');
    for (const [id, label] of [['transfer', tr('Передача', 'Transfer')], ['buffer', tr('Буфер', 'Clipboard')], ['upload', tr('Выгрузка', 'Unload')]]) {
      const button = node('button', id === active ? 'a' : '', label);
      button.type = 'button';
      button.addEventListener('click', () => showView(id));
      bar.append(button);
    }
    return bar;
  }
  function connection(name) {
    const row = node('div', 'cnx');
    const dot = node('i', linkUp && buffer.online ? '' : 'off');
    const online = linkUp && buffer.online;
    row.append(dot, document.createTextNode(online
      ? `${name} · ${tr('на связи', 'online')}`
      : tr('нет связи', 'offline')));
    return row;
  }
  function statusText(item) {
    if (item.status === 'waiting') return tr('ждёт', 'waiting');
    if (item.status === 'queued') return tr('очередь', 'queued');
    if (item.status === 'delivered') return '✓ ' + tr('доставлено', 'delivered');
    if (item.status === 'received') return '✓ ' + tr('получено', 'received');
    return item.status || '';
  }
  function statusColor(item) {
    if (item.status === 'delivered' || item.status === 'received') return '#30d158';
    if (item.status === 'waiting' || item.status === 'queued') return '#ff9f0a';
    return '#8e9198';
  }
  function detail(item) {
    if (item.sensitive) return item.sensitiveKind === 'otp' ? tr('Код из SMS · скрыт', 'SMS code · hidden') : tr('Пароль · скрыт, не пишется в историю', 'Password · hidden, not stored');
    if (item.kind === 'link') return tr('Ссылка', 'Link');
    if (item.kind === 'image') return tr(`Картинка · ${bytes(item.size)}`, `Image · ${bytes(item.size)}`);
    return tr(`Текст · ${item.size || item.title.length} символов`, `Text · ${item.size || item.title.length}`);
  }
  function peerLabel() {
    const name = buffer.peerName || (host ? 'iPhone' : 'Windows ПК');
    if (host) return name;
    return name.startsWith('Windows') ? name : `Windows ПК · ${name}`;
  }

  async function postBuffer(body, headers) {
    const response = await fetch('/api/buffer', { method: 'POST', body, headers });
    if (!response.ok) {
      let message = tr('Не удалось отправить', 'Could not send');
      try { message = (await response.json()).error || message; } catch { /* plain text */ }
      throw new Error(message);
    }
    return response.json();
  }
  async function flushQueue() {
    if (!linkUp) return;
    const pending = queue;
    queue = [];
    for (const item of pending) {
      try {
        if (item.file) {
          await postBuffer(await item.file.arrayBuffer(), { 'Content-Type': item.file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(item.name || 'image'), 'X-FlyDrop-Source': 'share' });
        } else await api('/api/buffer', { method: 'POST', body: JSON.stringify({ text: item.text, source: 'share' }) });
      } catch {
        queue.push(item);
        linkUp = false;
        break;
      }
    }
    render();
  }
  async function sendDraft() {
    const text = draft.trim();
    if (!text) return;
    const item = { id: crypto.randomUUID(), text, createdAt: Date.now() };
    if (!linkUp) { queue.push(item); draft = ''; toast(tr('В очереди, пока открыт FlyDrop', 'Queued while FlyDrop stays open')); render(); return; }
    try {
      await api('/api/buffer', { method: 'POST', body: JSON.stringify({ text, source: 'share' }) });
      draft = '';
      toast(tr('Отправлено на компьютер', 'Sent to the computer'));
    } catch (error) {
      queue.push(item);
      draft = '';
      linkUp = false;
      toast(error.message || tr('Нет связи, текст в очереди', 'Offline, text is queued'), true);
    }
    render();
  }
  async function sendImage(file) {
    if (!file) return;
    const item = { id: crypto.randomUUID(), file, name: file.name, createdAt: Date.now() };
    if (!linkUp) { queue.push(item); toast(tr('Картинка в очереди', 'Image queued')); render(); return; }
    try {
      await postBuffer(await file.arrayBuffer(), { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'image'), 'X-FlyDrop-Source': 'share' });
      toast(tr('Картинка на компьютере', 'Image is on the computer'));
    } catch (error) {
      queue.push(item);
      linkUp = false;
      toast(error.message, true);
    }
    render();
  }
  async function copyItem(item) {
    if (item.sensitive) { await reveal(item); return; }
    if (item.kind === 'image') {
      try {
        const response = await fetch(`/api/buffer/${item.id}/media`);
        if (!response.ok) throw new Error(tr('Картинки уже нет', 'Image is gone'));
        const blob = await response.blob();
        if (navigator.clipboard?.write && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
          toast(tr('Картинка скопирована', 'Image copied'));
        } else {
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = item.name || 'flydrop.png';
          link.click();
          toast(tr('Сохранили картинку: буфер iOS её не принял', 'Saved the image; iOS clipboard refused it'));
        }
      } catch (error) { toast(error.message, true); return; }
    } else {
      const mode = await copyText(item.title || '');
      toast(mode === 'manual' ? tr('Выделите текст и скопируйте', 'Select the text and copy it') : tr('Скопировано', 'Copied'));
    }
    if (item.status === 'waiting') {
      try { await api(`/api/buffer/${item.id}/ack`, { method: 'POST', body: '{}' }); } catch { /* The copy already happened. */ }
    }
  }
  function holdToReveal() {
    const root = document.getElementById('view-buffer');
    if (!root) return Promise.resolve(false);
    return new Promise(resolve => {
      const hold = node('div', 'hold');
      hold.append(node('p', '', tr('Face ID для сайта по IP-адресу iOS не даёт. Удерживайте кнопку секунду, чтобы показать секрет.', 'Face ID is not available for a site on an IP address. Hold the button for a second to reveal the secret.')));
      const control = node('button', 'btn', tr('Удерживайте', 'Hold'));
      control.type = 'button';
      const cancel = node('button', 'btn dark', tr('Не сейчас', 'Not now'));
      cancel.type = 'button';
      cancel.style.marginTop = '8px';
      let timer = 0;
      let settled = false;
      const finish = ok => { if (settled) return; settled = true; clearTimeout(timer); hold.remove(); resolve(ok); };
      control.addEventListener('pointerdown', () => { timer = setTimeout(() => finish(true), 700); });
      control.addEventListener('pointerup', () => clearTimeout(timer));
      control.addEventListener('pointerleave', () => clearTimeout(timer));
      cancel.addEventListener('click', () => finish(false));
      hold.append(control, cancel);
      root.append(hold);
    });
  }
  async function reveal(item) {
    const verified = await userVerified();
    if (!verified && !await holdToReveal()) return;
    try {
      const data = await api(`/api/buffer/${item.id}/reveal`, { method: 'POST', body: '{}' });
      await copyText(data.text || '');
      toast(tr('Секрет скопирован и снова спрячется', 'Secret copied; it will hide again'));
    } catch (error) { toast(error.message, true); }
  }
  async function pin(item) {
    try { await api(`/api/buffer/${item.id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: !item.pinned }) }); }
    catch (error) { toast(error.message, true); }
  }
  async function saveBufferSettings(patch) {
    try { buffer = await api('/api/buffer/settings', { method: 'POST', body: JSON.stringify(patch) }); render(); }
    catch (error) { toast(error.message, true); }
  }
  async function saveUnloadSettings(patch) {
    try { unload = await api('/api/unload/settings', { method: 'POST', body: JSON.stringify(patch) }); render(); }
    catch (error) { toast(error.message, true); }
  }
  async function downloadShortcut() {
    const loopback = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    if (loopback) toast(tr('Команда собрана с этого адреса. На iPhone откройте FlyDrop по Wi-Fi IP, не localhost.', 'This shortcut uses this address. On iPhone open FlyDrop by the Wi-Fi IP, not localhost.'), true);
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      toast(tr('Команде нужен HTTPS. Сначала страница настройки сертификата.', 'The shortcut needs HTTPS. Install the certificate first.'), true);
      return;
    }
    const response = await fetch('/api/buffer/shortcut');
    if (!response.ok) { toast(tr('Не удалось собрать команду', 'Could not build the shortcut'), true); return; }
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'FlyDrop.shortcut';
    link.click();
    toast(tr('Откройте файл в «Командах». Если iOS ругается, включите недоверенные команды.', 'Open the file in Shortcuts. If iOS refuses it, allow untrusted shortcuts.'));
  }
  async function sendDesktopClipboard() {
    if (desktop?.sendToPhone && !hostDraft.trim()) { await desktop.sendToPhone(); return; }
    try {
      let text = hostDraft.trim();
      if (!text) text = (await navigator.clipboard.readText()).trim();
      if (!text) throw new Error(tr('В буфере пусто. Вставьте текст в поле ниже.', 'Clipboard is empty. Paste text in the field below.'));
      await api('/api/buffer', { method: 'POST', body: JSON.stringify({ text, source: 'hotkey' }) });
      hostDraft = '';
      toast(tr('Ждёт на iPhone', 'Waiting on iPhone'));
    } catch (error) { toast(error.message, true); }
  }

  function button(className, label, onClick, id) {
    const element = node('button', className, label);
    element.type = 'button';
    if (id) element.id = id;
    element.addEventListener('click', onClick);
    return element;
  }
  function toggle(on, label, onClick) {
    const wrap = node('span');
    wrap.style.display = 'flex';
    wrap.style.gap = '8px';
    wrap.style.alignItems = 'center';
    const control = node('button', on ? 'tgl' : 'tgl off');
    control.type = 'button';
    control.setAttribute('aria-pressed', String(Boolean(on)));
    control.setAttribute('aria-label', label);
    control.addEventListener('click', onClick);
    wrap.append(control, document.createTextNode(label));
    return wrap;
  }
  function phoneRow(item, queued) {
    const row = node('button', 'it');
    row.type = 'button';
    if (queued) row.style.border = '1px solid rgba(255,159,10,.3)';
    const ico = node('div', 'ico');
    if (item.hasPreview) {
      const image = node('img');
      image.alt = '';
      image.src = `/api/buffer/${item.id}/media`;
      ico.append(image);
    } else ico.append(icon(item.sensitive ? 'shield' : item.kind === 'link' ? 'link' : item.kind === 'image' ? 'photo' : 'note'));
    const text = node('div', 't');
    const title = node('b', item.sensitive ? 'mask' : '', item.title || item.name || '');
    const small = node('small', '', queued ? tr('Ждёт, пока FlyDrop открыт', 'Waits while FlyDrop is open') : detail(item));
    text.append(title, small);
    const mark = node('span', 's', item.sensitive && item.deleteAt ? tr(`удалится ${remain(item.deleteAt - Date.now())}`, `deletes ${remain(item.deleteAt - Date.now())}`) : statusText(queued ? { status: 'queued' } : item));
    mark.style.color = queued ? '#ff9f0a' : statusColor(item);
    if (item.deleteAt) mark.dataset.deleteAt = String(item.deleteAt);
    if (queued) mark.prepend(icon('clock', 14));
    row.append(ico, text, mark);
    row.addEventListener('click', () => { if (!queued) void copyItem(item); });
    return row;
  }

  function renderPhoneBuffer(root) {
    root.className = 'view scr';
    root.append(node('div', 'bk'), segment('buffer'), connection(peerLabel()));
    if (bufferScreen === 'setup') {
      const title = node('div', 'ttl');
      title.append(node('b', '', tr('Двойной стук — текст уже на ПК', 'Back Tap — text is already on the PC')));
      const small = node('small', '', tr('PWA не может слушать стук сама. Это делает быстрая команда iOS: один раз берёт буфер и отправляет на порт передачи.', 'The PWA cannot hear taps. An iOS Shortcut reads the clipboard once and posts it to the transfer port.'));
      title.append(small);
      const steps = node('div', 'sec');
      steps.style.top = '290px';
      const step1 = node('div', 'step');
      step1.append(node('div', 'n ok', '✓'), node('div', '', ''));
      step1.lastChild.append(node('b', '', tr('Добавить команду «В FlyDrop»', 'Add the “To FlyDrop” shortcut')), node('small', '', tr('Внутри: Получить буфер обмена → Получить содержимое URL (POST, ключ этого iPhone).', 'Inside: Get Clipboard → Get Contents of URL (POST, this iPhone’s key).')));
      const step2 = node('div', 'step');
      const body2 = node('div');
      body2.append(node('b', '', tr('Включить «Касание задней панели»', 'Turn on Back Tap')));
      const path = node('div', 'sc');
      path.append(node('i', '', tr('Настройки', 'Settings')), document.createTextNode('→ '), node('i', '', tr('Универс. доступ', 'Accessibility')), document.createTextNode('→ '), node('i', '', tr('Касание', 'Touch')), document.createTextNode('→ '), node('i', '', tr('Касание задней панели', 'Back Tap')), document.createTextNode('→ '), node('i', '', tr('Двойное', 'Double')), document.createTextNode('→ '), node('i', '', tr('В FlyDrop', 'To FlyDrop')));
      body2.append(path);
      step2.append(node('div', 'n', '2'), body2);
      const step3 = node('div', 'step');
      step3.append(node('div', 'n', '3'));
      const body3 = node('div');
      body3.append(node('b', '', tr('Или из «Поделиться»', 'Or from Share')), node('small', '', tr('Выделите текст или фото → Поделиться → В FlyDrop', 'Select text or a photo → Share → To FlyDrop')));
      step3.append(body3);
      steps.append(step1, step2, step3);
      const bottom = node('div', 'botb');
      const add = button('btn', tr('Добавить команду', 'Add shortcut'), () => void downloadShortcut(), 'buffer-shortcut');
      add.prepend(icon('up', 20));
      bottom.append(add, node('small', '', tr('Если iOS не открывает файл, включите недоверенные команды. Стуки работают, пока ПК на связи.', 'If iOS will not open the file, allow untrusted shortcuts. Taps work while the PC is online.')));
      const back = button('btn dark', tr('К буферу', 'Back to clipboard'), () => { bufferScreen = 'list'; render(); });
      back.style.marginTop = '8px';
      bottom.append(back);
      root.append(title, steps, bottom);
      return;
    }
    const waiting = (buffer.items || []).find(item => item.direction === 'to-phone' && item.status === 'waiting' && !item.pinned);
    const pins = (buffer.items || []).filter(item => item.pinned);
    const rest = (buffer.items || []).filter(item => item !== waiting && !item.pinned);
    let top = 138;
    if (!linkUp || !buffer.online) {
      const banner = node('div', 'banner');
      banner.append(icon('wifi', 22));
      const text = node('div');
      text.append(document.createTextNode(tr('Нет связи с Windows ПК', 'No link to the Windows PC')), node('small', '', tr('Проверьте Wi-Fi и что FlyDrop запущен на ПК. Текст ниже подождёт в очереди.', 'Check Wi-Fi and that FlyDrop is open on the PC. Text below waits in the queue.')));
      banner.append(text);
      root.append(banner);
      top = 216;
    } else if (waiting) {
      const hero = node('div', 'hero');
      const head = node('div', 'h');
      head.append(icon('up', 16), document.createTextNode(tr(' С Windows ПК · Ctrl+Shift+Enter', ' From Windows · Ctrl+Shift+Enter')), node('span', 'r', ago(waiting.createdAt)));
      const value = node('div', waiting.sensitive ? 'v mask' : 'v', waiting.title);
      const copy = button('btn', tr('Скопировать на iPhone', 'Copy to iPhone'), () => void copyItem(waiting), 'buffer-copy');
      copy.prepend(icon('copy', 20));
      hero.append(head, value, copy, node('div', 'note', tr('iOS копирует только по касанию. Пока FlyDrop закрыт, текст ждёт здесь.', 'iOS copies only on a tap. Until FlyDrop is open, the text waits here.')));
      root.append(hero);
      top = 430;
    }
    const box = node('div', 'composer');
    const field = node('textarea');
    field.id = 'buffer-compose';
    field.placeholder = tr('Текст или ссылка на компьютер…', 'Text or a link for the computer…');
    field.value = draft;
    field.addEventListener('input', () => { draft = field.value; });
    const send = button('btn', tr('Отправить на ПК', 'Send to PC'), () => void sendDraft(), 'buffer-send');
    box.append(field, send);
    root.append(box);
    if (!waiting && (linkUp && buffer.online)) top = 360;
    if (queue.length) {
      const block = node('div', 'sec');
      block.style.top = `${top}px`;
      const label = node('div', 'lb');
      label.append(node('span', '', tr(`Очередь · ${queue.length}`, `Queue · ${queue.length}`)), node('span', '', tr('уйдёт, когда ПК появится', 'leaves when the PC is back')));
      block.append(label);
      for (const item of queue) block.append(phoneRow({ title: item.text || item.name, kind: item.file ? 'image' : 'text', status: 'queued' }, true));
      root.append(block);
      top += 40 + queue.length * 70;
    }
    if (pins.length) {
      const block = node('div', 'sec');
      block.style.top = `${top}px`;
      const label = node('div', 'lb');
      label.append(node('span', '', tr('Закреплённые', 'Pinned')));
      const row = node('div', 'pins');
      for (const item of pins.slice(0, 3)) {
        const pinButton = node('button', 'pin');
        pinButton.type = 'button';
        pinButton.append(icon('pin', 13), document.createTextNode(' ' + (item.title || '').slice(0, 18)), node('small', item.sensitive ? 'mask' : '', item.sensitive ? '••••••••' : (item.title || '')));
        pinButton.addEventListener('click', () => void copyItem(item));
        row.append(pinButton);
      }
      block.append(label, row);
      root.append(block);
      top += 110;
    }
    const history = node('div', 'sec');
    history.style.top = `${Math.min(top, 520)}px`;
    const label = node('div', 'lb');
    label.append(node('span', '', tr('История', 'History')), node('span', '', tr('живёт 1 час', 'kept 1 hour')));
    history.append(label);
    for (const item of rest.slice(0, 4)) history.append(phoneRow(item));
    if (!rest.length && !pins.length && !waiting && !queue.length) history.append(node('div', 'note', tr('Пока пусто. Текст выше уйдёт на ПК, картинку можно выбрать кнопкой внизу.', 'Nothing yet. Text above goes to the PC. Pick an image with the button below.')));
    root.append(history);
    const bottom = node('div', 'botb');
    const setup = button('btn dark', tr('Двойной стук', 'Back Tap'), () => { bufferScreen = 'setup'; render(); }, 'buffer-setup');
    const file = node('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp,image/heic,.heic,.png,.jpg,.jpeg,.webp';
    file.id = 'buffer-image';
    file.hidden = true;
    file.addEventListener('change', () => { const chosen = file.files?.[0]; file.value = ''; void sendImage(chosen); });
    const pick = button('btn', tr('Картинка на ПК', 'Image to PC'), () => file.click());
    pick.style.marginTop = '8px';
    const retry = button('btn dark', tr('Проверить связь', 'Check the link'), async () => {
      try { await api('/api/state'); linkUp = true; toast(tr('Связь есть', 'Link is up')); await flushQueue(); }
      catch (error) { linkUp = false; toast(error.message, true); render(); }
    }, 'buffer-retry');
    retry.style.marginTop = '8px';
    bottom.append(setup, pick, file, retry, node('small', '', tr('Очередь живёт только пока эта страница открыта. В фоне iOS её гасит.', 'The queue lives only while this page is open. iOS drops it in the background.')));
    root.append(bottom);
  }

  function renderWinBuffer(root) {
    root.className = 'view mode-live';
    root.append(node('h2', '', tr('Буфер', 'Clipboard')), node('div', 'mode-sub', tr('Общий с iPhone · читается только по нажатию, в фоне ничего не уходит', 'Shared with iPhone · read only when you press, nothing leaves in the background')));
    const actions = node('div');
    actions.style.cssText = 'display:flex;gap:10px;margin-top:16px;align-items:center';
    const send = button('wbtn', tr('Отправить буфер на iPhone', 'Send clipboard to iPhone'), () => void sendDesktopClipboard(), 'buffer-send-host');
    send.prepend(icon('up', 15));
    const paste = node('textarea');
    paste.id = 'buffer-host-compose';
    paste.placeholder = tr('Или вставьте текст здесь — если Ctrl+Shift+Enter занят', 'Or paste text here if Ctrl+Shift+Enter is taken');
    paste.value = hostDraft;
    paste.style.cssText = 'display:block;width:100%;min-height:72px;margin-top:12px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:#232428;color:#fff;padding:10px';
    paste.addEventListener('input', () => { hostDraft = paste.value; });
    actions.append(send, node('span', '', ''));
    actions.lastChild.append(node('span', 'kbd', 'Ctrl'), document.createTextNode('+'), node('span', 'kbd', 'Shift'), document.createTextNode('+'), node('span', 'kbd', 'Enter'));
    const card = node('div', 'wcard');
    card.style.marginTop = '18px';
    card.style.padding = '4px 12px';
    const items = buffer.items || [];
    if (!items.length) card.append(node('div', 'wrow', tr('Пока пусто. Скопируйте текст и нажмите Ctrl+Shift+Enter.', 'Nothing yet. Copy text and press Ctrl+Shift+Enter.')));
    for (const item of items.slice(0, 8)) {
      const row = node('button', 'wrow');
      row.type = 'button';
      const ico = node('div', 'ico');
      if (item.hasPreview) { const image = node('img'); image.alt = ''; image.src = `/api/buffer/${item.id}/media`; ico.append(image); }
      else ico.append(icon(item.sensitive ? 'shield' : item.kind === 'link' ? 'link' : item.kind === 'image' ? 'photo' : item.pinned ? 'pin' : 'note', 16));
      const text = node('div', 't');
      text.append(node('b', item.sensitive ? 'mask' : '', item.title || item.name || ''), node('small', '', `${detail(item)} · ${item.direction === 'to-phone' ? '→ iPhone' : tr('с iPhone', 'from iPhone')}`));
      const mark = node('small', '', item.sensitive && item.deleteAt ? tr(`удалится через ${remain(item.deleteAt - Date.now())}`, `deletes in ${remain(item.deleteAt - Date.now())}`) : (item.pinned ? tr('закреплено', 'pinned') : statusText(item)));
      mark.style.color = statusColor(item);
      if (item.deleteAt) mark.dataset.deleteAt = String(item.deleteAt);
      row.append(ico, text, mark);
      row.addEventListener('click', () => void (item.sensitive ? reveal(item) : copyItem(item)));
      const pinButton = button('wbtn s', item.pinned ? tr('Открепить', 'Unpin') : tr('Закрепить', 'Pin'), event => { event.stopPropagation(); void pin(item); });
      pinButton.style.marginLeft = '8px';
      row.append(pinButton);
      card.append(row);
    }
    root.append(actions, paste, card);
    if (host) {
      const settings = buffer.settings || {};
      const row = node('div');
      row.style.cssText = 'display:flex;gap:18px;margin-top:16px;font-size:12.5px;color:#8e9198;flex-wrap:wrap';
      row.append(
        toggle(settings.hideSensitive !== false, tr('Скрывать пароли и коды', 'Hide passwords and codes'), () => void saveBufferSettings({ hideSensitive: settings.hideSensitive === false })),
        toggle(settings.history !== false, tr('Хранить историю 1 час', 'Keep history for 1 hour'), () => void saveBufferSettings({ history: settings.history === false })),
        toggle(settings.persist === true, tr('Писать историю на диск', 'Write history to disk'), () => void saveBufferSettings({ persist: settings.persist !== true })),
      );
      const note = node('p', 'mode-sub', tr('На диске история шифруется DPAPI, секреты — отдельно. По умолчанию на диск ничего не пишется.', 'On disk, history is sealed with DPAPI and secrets are sealed again. Nothing is written unless you turn this on.'));
      root.append(row, note);
    }
    const setup = button('wbtn s', tr('Команда двойного стука', 'Back Tap shortcut'), () => void downloadShortcut(), 'buffer-shortcut');
    setup.style.marginTop = '16px';
    root.append(setup);
  }

  function hintLine() {
    if (unload.hint?.name) return tr(`В пикере откройте «Недавние» и выделяйте свайпом всё новее ${unload.hint.name}. Сколько нового — посчитаем после выбора.`, `In the picker open Recents and select everything newer than ${unload.hint.name}. We count the new files only after you choose.`);
    return tr('PWA не видит медиатеку. Выберите фото и видео сами. Дубли по SHA-256 пропустим.', 'The PWA cannot see the library. Choose the photos and videos yourself. SHA-256 duplicates are skipped.');
  }
  function renderPhoneUpload(root) {
    root.className = 'view scr';
    root.append(node('div', 'bk'), segment('upload'), connection(peerLabel()));
    if (uploadScreen === 'progress' || unload.job?.phase === 'uploading' || unload.job?.phase === 'paused') {
      const total = localStats.bytesTotal || unload.job?.bytesTotal || 1;
      const done = localStats.bytesDone || unload.job?.bytesDone || 0;
      const percent = Math.max(0, Math.min(100, Math.round(done / total * 100)));
      const ring = node('div', 'ring');
      ring.style.background = `conic-gradient(#0a84ff 0 ${percent}%, rgba(255,255,255,.08) ${percent}% 100%)`;
      ring.style.boxShadow = '0 0 50px rgba(10,132,255,.25)';
      const hole = node('div');
      hole.style.cssText = 'position:absolute;inset:14px;border-radius:50%;background:#0b0c0e';
      const label = node('div');
      label.style.position = 'relative';
      label.append(node('b', '', `${percent} %`), node('small', '', `${bytes(done)} ${tr('из', 'of')} ${bytes(total)}`));
      ring.append(hole, label);
      const section = node('div', 'sec');
      section.style.top = '440px';
      const current = node('div', 'cur');
      current.append(node('div', '', localStats.current || unload.job?.name || '…'));
      const bar = node('div', 'pbar');
      const fill = node('i');
      const filePercent = localStats.fileSize ? Math.round(localStats.fileDone / localStats.fileSize * 100) : percent;
      fill.style.width = `${filePercent}%`;
      bar.append(fill);
      current.append(bar, node('div', 'note', tr('Частями по 16 МБ · после обрыва продолжит с места', '16 MB parts · an interruption resumes from the last part')));
      const rows = node('div');
      for (const [name, value] of [[tr('Скопировано', 'Copied'), localStats.copied], [tr('Пропущено (уже на ПК)', 'Skipped (already on PC)'), localStats.skipped], [tr('Осталось', 'Left'), localStats.left]]) {
        const line = node('div', 'kv');
        line.append(node('span', '', name), node('span', '', String(value)));
        rows.append(line);
      }
      section.append(current, rows);
      const bottom = node('div', 'botb');
      const pause = button('btn dark', paused || unload.job?.paused ? tr('Дальше', 'Resume') : tr('Пауза', 'Pause'), () => void togglePause(), 'unload-pause');
      bottom.append(pause, node('small', '', tr('Держите экран открытым — iOS усыпляет PWA в фоне. Экран стараемся не гасить.', 'Keep the screen open — iOS sleeps the PWA in the background. We try to keep the screen awake.')));
      root.append(ring, section, bottom);
      return;
    }
    if (uploadScreen === 'report' && (unload.report || localStats.copied || localStats.skipped)) {
      const report = unload.report || localStats;
      const mark = node('div', 'okc');
      mark.append(icon('check', 40));
      const summary = node('div', 'rep');
      summary.append(node('b', '', tr(`Скопировано ${report.copied || 0}`, `Copied ${report.copied || 0}`)), node('small', '', tr(`пропущено ${report.skipped || 0} дублей · ошибок ${report.errors || 0}`, `skipped ${report.skipped || 0} · errors ${report.errors || 0}`)));
      const nums = node('div', 'nums');
      nums.append(node('div', '', ''), node('div', '', ''));
      nums.children[0].append(node('b', '', bytes(report.bytes || localStats.bytes)), document.createTextNode(tr('объём', 'size')));
      nums.children[1].append(node('b', '', `${report.verified || report.copied || 0}/${report.copied || 0}`), document.createTextNode('SHA-256'));
      const folders = node('div', 'sec');
      folders.style.top = '494px';
      const label = node('div', 'lb');
      label.append(node('span', '', tr('Разложено на ПК', 'Laid out on the PC')));
      folders.append(label);
      for (const folder of (report.folders || localStats.folders || []).slice(0, 3)) {
        const row = node('div', 'it');
        const ico = node('div', 'ico');
        ico.append(icon('folder'));
        const text = node('div', 't');
        text.append(node('b', '', folder));
        row.replaceChildren(ico, text);
        folders.append(row);
      }
      const bottom = node('div', 'botb');
      bottom.append(button('btn', tr('Готово', 'Done'), () => { uploadScreen = 'pick'; render(); }, 'unload-done'), node('small', '', unload.hint?.name ? tr(`Следующая выгрузка начнётся после ${unload.hint.name}`, `The next unload starts after ${unload.hint.name}`) : tr('Оригиналы, даты и пары Live Photo сохранены', 'Originals, dates and Live Photo pairs are kept')));
      root.append(mark, summary, nums, folders, bottom);
      return;
    }
    const card = node('div', 'qbig');
    card.style.top = '138px';
    const label = node('div', 'lb');
    label.append(node('span', '', tr('Прошлая выгрузка', 'Previous unload')));
    card.append(label);
    const when = unload.hint?.takenAt ? new Date(unload.hint.takenAt) : null;
    const big = node('div', 'big1', when ? when.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '') : tr('ещё не было', 'none yet'));
    if (when) big.append(node('span', '', when.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })));
    big.style.marginTop = '10px';
    big.style.fontSize = '52px';
    card.append(big, node('div', 'note', hintLine()));
    const thumbs = node('div', 'thumbs');
    for (const thumb of (unload.thumbs || []).slice(0, 5)) {
      const cell = node('div');
      if (thumb.thumb) { cell.style.backgroundImage = `url(${thumb.thumb})`; cell.style.backgroundSize = 'cover'; }
      else cell.style.background = 'linear-gradient(135deg,#c9b79a,#5d7a85)';
      thumbs.append(cell);
    }
    if (thumbs.childElementCount) card.append(thumbs);
    const steps = node('div', 'sec');
    steps.style.top = '478px';
    const one = node('div', 'step');
    one.style.marginTop = '0';
    one.append(node('div', 'n', '1'));
    const oneBody = node('div');
    oneBody.append(node('b', '', tr('Выбрать в «Фото»', 'Choose in Photos')), node('small', '', tr('Системный пикер: iOS не даёт PWA читать медиатеку сама', 'The system picker: iOS does not let a PWA read the library')));
    one.append(oneBody);
    const two = node('div', 'step');
    two.append(node('div', 'n', '2'));
    const twoBody = node('div');
    twoBody.append(node('b', '', tr('Дубли отсеем по SHA-256', 'Duplicates drop by SHA-256')), node('small', '', tr('Лишнее выбранное ничего не стоит — уже скопированное пропустим', 'Extra picks are free — files already copied are skipped')));
    two.append(twoBody);
    steps.append(one, two);
    const name = node('input');
    name.value = eventName;
    name.placeholder = tr('Название съёмки, если нужно', 'Shoot name, if you want one');
    name.style.cssText = 'margin-top:10px;width:100%;height:44px;border-radius:14px;border:0;background:#16181c;color:#fff;padding:0 14px';
    name.addEventListener('input', () => { eventName = name.value; });
    steps.append(name);
    const file = node('input');
    file.type = 'file';
    file.multiple = true;
    file.accept = 'image/*,video/*,.heic,.mov,.mp4,.jpg,.jpeg,.png';
    file.id = 'unload-input';
    file.hidden = true;
    file.addEventListener('change', () => { const list = [...(file.files || [])]; file.value = ''; void beginUpload(list); });
    const bottom = node('div', 'botb');
    const pick = button('btn', tr('Выбрать в «Фото»', 'Choose in Photos'), () => file.click(), 'unload-pick');
    pick.prepend(icon('photo', 20));
    bottom.append(pick, node('small', '', `${tr('На ПК', 'On PC')}: ${unload.folder || 'FlyDrop'} · ${tr('по датам и событиям · оригиналы', 'by date and event · originals')}`));
    root.append(card, steps, file, bottom);
  }
  function renderWinUpload(root) {
    root.className = 'view mode-live';
    const active = uploadScreen === 'progress' || unload.job?.phase === 'uploading' || unload.job?.phase === 'paused';
    const done = uploadScreen === 'report' || (unload.phase === 'done' && unload.report && !active);
    root.append(node('h2', '', done ? tr('Выгрузка завершена', 'Unload finished') : tr('Выгрузка с iPhone', 'Unload from iPhone')));
    root.append(node('div', 'mode-sub', done ? (unload.report?.line || tr('Отчёт ниже и в _flydrop-report.txt', 'The report is below and in _flydrop-report.txt')) : tr('Только новое · дубли по SHA-256 · оригиналы и метаданные не трогаем', 'Only new files · SHA-256 duplicates · originals and metadata stay')));
    if (active || (localStats.bytesTotal && uploadScreen === 'progress')) {
      const total = localStats.bytesTotal || unload.job?.bytesTotal || 1;
      const soFar = localStats.bytesDone || unload.job?.bytesDone || 0;
      const percent = Math.max(0, Math.min(100, Math.round(soFar / total * 100)));
      const card = node('div', 'wcard');
      card.style.marginTop = '16px';
      const head = node('div');
      head.style.cssText = 'display:flex;justify-content:space-between;font-size:13px';
      head.append(node('b', '', `${paused ? tr('Пауза', 'Paused') : tr('Идёт', 'Running')} · ${percent} %`), node('span', '', `${bytes(soFar)} ${tr('из', 'of')} ${bytes(total)}`));
      const bar = node('div', 'pbar');
      const fill = node('i');
      fill.style.width = `${percent}%`;
      bar.append(fill);
      card.append(head, bar, node('div', 'mode-sub', `${localStats.current || unload.job?.name || ''} · ${tr('скопировано', 'copied')} ${localStats.copied} · ${tr('пропущено', 'skipped')} ${localStats.skipped}`));
      const controls = node('div');
      controls.style.marginTop = '12px';
      controls.append(button('wbtn s', paused ? tr('Дальше', 'Resume') : tr('Пауза', 'Pause'), () => void togglePause(), 'unload-pause'));
      card.append(controls);
      root.append(card);
    }
    if (done) {
      const report = unload.report || localStats;
      const grid = node('div');
      grid.style.cssText = 'display:flex;gap:12px;margin-top:18px;flex-wrap:wrap';
      for (const [value, caption] of [[report.copied || 0, tr('скопировано', 'copied')], [report.skipped || 0, tr('пропущено · уже было', 'skipped · already there')], [report.errors || 0, tr('ошибок', 'errors')], [report.proxies || 0, tr('прокси готово', 'proxies ready')]]) {
        const card = node('div', 'wcard');
        card.style.flex = '1';
        card.append(node('div', '', String(value)), node('div', 'mode-sub', caption));
        card.firstChild.style.fontSize = '30px';
        card.firstChild.style.fontWeight = '700';
        grid.append(card);
      }
      root.append(grid);
      const open = button('wbtn', tr('Открыть папку', 'Open folder'), () => void openFolder(), 'unload-open');
      open.style.marginTop = '14px';
      root.append(open, node('p', 'mode-sub', tr(`Целостность: ${report.verified || report.copied || 0} из ${report.copied || 0} совпали по SHA-256 после записи на диск.`, `Integrity: ${report.verified || report.copied || 0} of ${report.copied || 0} matched SHA-256 after the disk write.`)));
    }
    if (host) {
      const settings = unload.settings || {};
      const card = node('div', 'wcard');
      card.style.marginTop = '16px';
      card.style.padding = '6px 14px';
      const folder = node('div', 'wrow');
      const folderText = node('div', 't');
      folderText.append(node('b', '', unload.folder || tr('Папка не выбрана', 'No folder yet')), node('small', '', tr('Год / дата + событие, внутри Оригиналы, JPG и Proxy', 'Year / date + event, then Originals, JPG and Proxy')));
      folder.append(folderText, button('wbtn s', tr('Папка', 'Folder'), () => void chooseFolder()));
      card.append(folder);
      card.append(settingRow(tr('HEIC → JPG рядом', 'HEIC → JPG beside it'), tr('Оригинал HEIC остаётся', 'The HEIC original stays'), settings.heicToJpg !== false, () => void saveUnloadSettings({ heicToJpg: settings.heicToJpg === false })));
      card.append(settingRow(tr('HEVC → H.264', 'HEVC → H.264'), tr('Для старых плееров · дольше', 'For older players · slower'), settings.hevcToH264 === true, () => void saveUnloadSettings({ hevcToH264: settings.hevcToH264 !== true })));
      card.append(settingRow(tr('Прокси для монтажа', 'Edit proxy'), tr('ProRes Proxy 1080p, если конвертер умеет. Иначе H.264.', 'ProRes Proxy 1080p when the converter can. Otherwise H.264.'), settings.makeProxy !== false, () => void saveUnloadSettings({ makeProxy: settings.makeProxy === false })));
      const meta = node('div', 'wrow');
      meta.style.border = '0';
      const metaText = node('div', 't');
      metaText.append(node('b', '', tr('Метаданные', 'Metadata')), node('small', '', tr('EXIF, дата, геометка, Live Photo вместе', 'EXIF, date, location, Live Photo together')));
      meta.append(metaText, node('span', '', tr('всегда', 'always')));
      meta.lastChild.style.color = '#30d158';
      card.append(meta);
      root.append(card, node('p', 'mode-sub', tr('Конвертер — ffmpeg (LGPL) и, если есть, libheif. PowerShell и cmd не запускаются. Если конвертера нет, оригинал всё равно сохраняется.', 'The converter is ffmpeg (LGPL) and libheif when present. PowerShell and cmd are never started. If the converter is missing, the original is still kept.')));
    } else root.append(node('p', 'mode-sub', hintLine()));
  }
  function settingRow(title, caption, on, onClick) {
    const row = node('div', 'wrow');
    const text = node('div', 't');
    text.append(node('b', '', title), node('small', '', caption));
    row.append(text, toggle(on, title, onClick));
    return row;
  }
  async function chooseFolder() {
    try {
      const picked = desktop?.chooseUnloadFolder ? await desktop.chooseUnloadFolder() : null;
      if (picked?.folder) await saveUnloadSettings({ folder: picked.folder });
      else toast(tr('Папку выбирают в приложении Windows', 'Choose the folder in the Windows app'));
    } catch (error) { toast(error.message, true); }
  }
  async function openFolder() {
    const folder = unload.folder || unload.report?.file;
    if (desktop?.openPath && folder) { await desktop.openPath(folder); return; }
    toast(folder || tr('Папка появится после первой выгрузки', 'The folder appears after the first unload'));
  }
  async function togglePause() {
    paused = !paused;
    const id = run?.id || unload.job?.id;
    if (id) {
      try { await api(`/api/unload/${id}/${paused ? 'pause' : 'resume'}`, { method: 'POST', body: '{}' }); } catch { /* Local pause still stops the phone. */ }
    }
    if (!paused && resumeWait) { const wake = resumeWait; resumeWait = null; wake(); }
    render();
  }
  async function beginUpload(files) {
    if (!files.length) return;
    for (const file of files) if (file.size > MAX_UNLOAD) { toast(tr('Файл больше 64 ГБ', 'A file is over 64 GB'), true); return; }
    Object.assign(localStats, { copied: 0, skipped: 0, errors: 0, verified: 0, proxies: 0, bytes: 0, folders: [], resumes: [], current: '', fileDone: 0, fileSize: 0, bytesDone: 0, bytesTotal: files.reduce((sum, file) => sum + file.size, 0), left: files.length, total: files.length });
    uploadScreen = 'progress';
    paused = false;
    render();
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
    try {
      const described = [];
      let index = 0;
      for (const file of files) {
        index += 1;
        localStats.current = tr(`SHA-256 · ${index} из ${files.length}`, `SHA-256 · ${index} of ${files.length}`);
        render();
        const sha256 = await hashBlob(file);
        described.push({ clientId: crypto.randomUUID(), name: file.name, size: file.size, sha256, takenAt: file.lastModified || Date.now(), calendar: calendarDay(file.lastModified), mime: file.type || '', file });
      }
      const probe = await api('/api/unload/probe', { method: 'POST', body: JSON.stringify({ files: described.map(({ file, ...meta }) => meta), eventName }) });
      const byId = new Map(described.map(item => [item.clientId, item]));
      localStats.skipped = probe.skip?.length || 0;
      localStats.total = (probe.accept?.length || 0) + localStats.skipped;
      localStats.left = probe.accept?.length || 0;
      localStats.bytesTotal = (probe.accept || []).reduce((sum, job) => sum + (byId.get(job.clientId)?.size || 0), 0) || localStats.bytesTotal;
      const folders = new Set();
      for (const job of probe.accept || []) {
        const file = byId.get(job.clientId);
        if (!file) continue;
        run = { id: job.uploadId };
        localStats.current = file.name;
        localStats.fileSize = file.size;
        localStats.fileDone = 0;
        const chunkSize = job.chunkSize || 16 * 1024 * 1024;
        let resume = (job.missing || []).length * chunkSize < file.size;
        for (const part of job.missing || []) {
          while (paused) await new Promise(resolve => { resumeWait = resolve; });
          const start = part * chunkSize;
          const end = Math.min(file.size, start + chunkSize);
          let attempt = 0;
          while (true) {
            const response = await fetch(`/api/unload/${job.uploadId}/chunks/${part}`, { method: 'PUT', body: file.file.slice(start, end), headers: { 'Content-Type': 'application/octet-stream', ...(resume ? { 'X-FlyDrop-Resume': '1' } : {}) } });
            if (response.status === 409) {
              paused = true;
              render();
              await new Promise(resolve => { resumeWait = resolve; });
              continue;
            }
            if (!response.ok) {
              attempt += 1;
              if (attempt > 6) throw new Error(tr(`Не дошла часть ${file.name}`, `A part of ${file.name} did not arrive`));
              await sleep(Math.min(5000, 400 * attempt));
              resume = true;
              localStats.resumes = [...new Set([...localStats.resumes, file.name])];
              continue;
            }
            break;
          }
          localStats.fileDone = end;
          localStats.bytesDone += end - start;
          render();
        }
        const finished = await api(`/api/unload/${job.uploadId}/finish`, { method: 'POST', body: '{}' });
        localStats.copied += 1;
        localStats.verified += 1;
        localStats.bytes += file.size;
        localStats.left = Math.max(0, localStats.left - 1);
        if (finished.folder) folders.add(finished.folder);
        if (finished.proxy) localStats.proxies += 1;
      }
      localStats.folders = [...folders];
      unload = await api('/api/unload/report', { method: 'POST', body: JSON.stringify({ copied: localStats.copied, skipped: localStats.skipped, errors: localStats.errors, verified: localStats.verified, proxies: localStats.proxies, bytes: localStats.bytes, folders: localStats.folders, resumes: localStats.resumes }) });
      uploadScreen = 'report';
      toast(unload.line || tr(`Скопировано ${localStats.copied}, пропущено ${localStats.skipped}`, `Copied ${localStats.copied}, skipped ${localStats.skipped}`));
    } catch (error) {
      localStats.errors += 1;
      uploadScreen = 'report';
      toast(error.message || tr('Выгрузка остановилась. Повторите только то, что не дошло.', 'The unload stopped. Retry only what did not arrive.'), true);
    } finally {
      run = null;
      try { await wakeLock?.release?.(); } catch { /* already released */ }
      wakeLock = null;
      render();
    }
  }

  function render() {
    syncChrome();
    const bufferRoot = document.getElementById('view-buffer');
    const uploadRoot = document.getElementById('view-upload');
    if (!bufferRoot || !uploadRoot) return;
    const bufferShown = !bufferRoot.hidden;
    const uploadShown = !uploadRoot.hidden;
    bufferRoot.replaceChildren();
    uploadRoot.replaceChildren();
    if (phoneLayout()) { renderPhoneBuffer(bufferRoot); renderPhoneUpload(uploadRoot); }
    else { renderWinBuffer(bufferRoot); renderWinUpload(uploadRoot); }
    bufferRoot.hidden = !bufferShown;
    uploadRoot.hidden = !uploadShown;
    if (bufferShown) document.querySelector('.nav-item[data-view="buffer"]')?.classList.remove('has-fresh');
    const jump = document.getElementById('phone-jump');
    if (jump) jump.hidden = !phoneLayout() || bufferShown || uploadShown;
  }
  narrow.addEventListener('change', render);
  setInterval(() => {
    for (const mark of document.querySelectorAll('[data-delete-at]')) {
      const left = Number(mark.dataset.deleteAt) - Date.now();
      if (left <= 0) { void refresh(); return; }
      mark.textContent = tr(`удалится ${remain(left)}`, `deletes ${remain(left)}`);
    }
  }, 1000);
  async function refresh() {
    try { buffer = await api('/api/buffer'); } catch { return; }
    render();
  }

  document.getElementById('win-min')?.addEventListener('click', () => desktop?.windowControls?.minimize());
  document.getElementById('win-max')?.addEventListener('click', () => desktop?.windowControls?.toggleMax());
  document.getElementById('win-close')?.addEventListener('click', () => desktop?.windowControls?.close());
  document.getElementById('win-lang')?.addEventListener('click', () => document.getElementById('language-toggle')?.click());

  return {
    shot: false,
    apply(state) {
      host = Boolean(state?.self?.isHost);
      if (state?.buffer) buffer = state.buffer;
      if (state?.unload) unload = state.unload;
      if (state?.unload?.job?.phase === 'uploading' || state?.unload?.job?.phase === 'paused') uploadScreen = 'progress';
      render();
    },
    buffer(data) {
      const previous = new Set((buffer.items || []).map(item => item.id));
      buffer = data || buffer;
      if (data?.online) linkUp = true;
      render();
      const view = document.getElementById('view-buffer');
      const fresh = (data?.items || []).filter(item => item.direction === 'from-phone' && !previous.has(item.id));
      if (host && view?.hidden && fresh.length) {
        const item = fresh[0];
        toast(item.sensitive ? tr('С iPhone пришло скрытое — откройте «Буфер»', 'Something hidden arrived from iPhone — open Clipboard') : tr(`С iPhone: ${(item.title || '').slice(0, 80)}`, `From iPhone: ${(item.title || '').slice(0, 80)}`));
        document.querySelector('.nav-item[data-view="buffer"]')?.classList.add('has-fresh');
      }
      if (!view?.hidden) document.querySelector('.nav-item[data-view="buffer"]')?.classList.remove('has-fresh');
      if (linkUp) void flushQueue();
    },
    unload(data) { unload = data || unload; render(); },
    online(value) { linkUp = value; if (value) void flushQueue(); else render(); },
    viewChanged() { render(); },
  };
}
