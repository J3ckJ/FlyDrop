import { detectLanguage, translate, localize, applyDocument } from './i18n.js';
let lang = detectLanguage();
const t = (key, vars) => translate(lang, key, vars);
const locale = () => lang === 'en' ? 'en-GB' : 'ru-RU';
const $ = id => document.getElementById(id);
const icon = name => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
};
const node = (tag, className, value) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
};
const bytes = size => { const labels = t('units'), index = size < 1024 ? 0 : size < 1024 ** 2 ? 1 : size < 1024 ** 3 ? 2 : 3; return `${index ? (size / 1024 ** index).toFixed(1) : size} ${labels[index]}`; };
const deviceType = /iPad|Tablet/i.test(navigator.userAgent) || (/Mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1) ? 'tablet' : /iPhone|Android.*Mobile/i.test(navigator.userAgent) ? 'phone' : 'computer';
const defaultName = /iPhone/i.test(navigator.userAgent) ? 'iPhone' : /iPad/i.test(navigator.userAgent) ? 'iPad' : /Android/i.test(navigator.userAgent) ? 'Android' : /Windows/i.test(navigator.userAgent) ? 'Windows' : /Mac/i.test(navigator.userAgent) ? 'Mac' : 'Компьютер';
const fragmentKey = new URLSearchParams(location.hash.slice(1)).get('pair');
let desktopTicket = new URLSearchParams(location.hash.slice(1)).get('desktop');
let pairKey = fragmentKey || sessionStorage.getItem('flydrop-pair');
if (fragmentKey) {
  sessionStorage.setItem('flydrop-pair', fragmentKey);
}
if (fragmentKey || desktopTicket) history.replaceState(null, '', location.pathname + location.search);
let current;
let events;
let selectedFiles = [];
let mode = 'file';
let connected = false;
let busy = false;
let activeUpload;
let cancelled = false;
let toastTimer;
let booting = false;
let qrMode = 'connect';
let pairingTimer;
const desktop = window.flydropDesktop;
const VIEWS = ['transfer', 'inbox', 'security', 'how'];
let currentView = 'transfer';
function viewFromLocation() {
  const name = location.hash.replace(/^#/, '').split('&')[0];
  return VIEWS.includes(name) ? name : 'transfer';
}
function showView(name, options = {}) {
  const view = VIEWS.includes(name) ? name : 'transfer';
  currentView = view;
  for (const id of VIEWS) {
    const panel = document.getElementById(`view-${id}`);
    if (panel) panel.hidden = id !== view;
  }
  for (const link of document.querySelectorAll('.nav-item[data-view]')) {
    const active = link.dataset.view === view;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const crumb = document.getElementById('crumb-page');
  if (crumb) crumb.textContent = t(`nav.${view}`);
  if (!options.silent && location.hash !== `#${view}`) history[options.replace ? 'replaceState' : 'pushState'](null, '', `#${view}`);
  if (!options.keepScroll) window.scrollTo(0, 0);
}
const qrTabs = node('div', 'qr-tabs');
for (const mode of ['connect', 'setup']) {
  const button = node('button', 'text-action', ''); button.dataset.mode = mode;
  button.addEventListener('click', () => { qrMode = mode; updateNetwork(); }); qrTabs.append(button);
}
$('host-connect').insertBefore(qrTabs, $('host-connect').querySelector('.qr-wrap'));
function paintQrTabs() { for (const button of qrTabs.querySelectorAll('button')) button.textContent = t(button.dataset.mode === 'setup' ? 'qr.setup' : 'qr.connect'); }
function toast(message, error = false) {
  clearTimeout(toastTimer); $('toast').textContent = localize(lang, message);
  $('toast').classList.toggle('error', error); $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 4000);
}
async function api(route, options = {}) {
  let response;
  try { response = await fetch(route, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); }
  catch { throw new Error('Нет связи с компьютером. Проверьте Wi-Fi и запущен ли FlyDrop на Windows'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('Сервер недоступен. Проверьте приложение на Windows'); }
  if (!response.ok) {
    if (response.status === 401) { connected = false; updateSend(); }
    throw Object.assign(new Error(data.error || 'Не удалось выполнить запрос'), { status: response.status });
  }
  return data;
}
function updateConnection(value) {
  connected = value; $('connection-status').classList.toggle('online', value);
  $('connection-status').lastChild.textContent = value ? t('status.online') : t('status.offline');
  updateSend();
}
function updateSend() {
  const ready = mode === 'file' ? selectedFiles.length > 0 : Boolean($('text-input').value.trim());
  $('send').disabled = busy || !connected || !$('recipient').value || !ready;
  $('send-label').textContent = busy ? t('send.busy') : mode === 'file' ? selectedFiles.length > 1 ? t('send.filesCount', { count: selectedFiles.length }) : t('send.files') : t('send.text');
  $('recipient').disabled = busy;
  $('dropzone').disabled = busy;
  $('text-input').disabled = busy;
  $('file-tab').disabled = busy;
  $('text-tab').disabled = busy;
  $('paste').disabled = busy;
}
function renderDevices(devices) {
  if (!current) return;
  const previous = $('recipient').value;
  const peers = [...new Map(devices.filter(device => device.id !== current.self.id && !(current.self.isHost && device.isHost)).map(device => [device.id, device])).values()];
  $('recipient').replaceChildren();
  $('recipient').append(new Option(peers.length ? t('recipient.placeholder') : t('recipient.waiting'), ''));
  for (const peer of peers) $('recipient').append(new Option(peer.name, peer.id));
  const chosen = previous || sessionStorage.getItem('flydrop-recipient') || (current.self.isHost ? current.settings?.lastRecipient : '');
  if (peers.some(peer => peer.id === chosen)) $('recipient').value = chosen;
  current.devices = devices;
  $('recipient-dot').classList.toggle('online', peers.length > 0);
  $('recipient-hint').textContent = peers.length ? t('recipient.hintOpen') : current.self.isHost ? t('recipient.hintPhone') : t('recipient.hintComputer');
  updateRecipientIcon(); updateSend();
}
function updateRecipientIcon() {
  const peer = current?.devices.find(peer => peer.id === $('recipient').value);
  $('recipient-icon').replaceChildren(icon(peer?.type === 'computer' ? 'computer' : 'phone').firstChild);
}
function renderHistory() {
  if (!current) return;
  const now = Date.now();
  current.inbox = current.inbox.filter(item => item.expiresAt > now);
  current.outbox = current.outbox.filter(item => item.expiresAt > now);
  $('inbox-count').textContent = current.inbox.length;
  $('empty-inbox').hidden = current.inbox.length > 0;
  $('outbox-section').hidden = current.outbox.length === 0;
  $('inbox-items').replaceChildren(...[...current.inbox].reverse().map(item => renderItem(item, true)));
  $('outbox-items').replaceChildren(...[...current.outbox].reverse().map(item => renderItem(item, false)));
}
function renderItem(item, incoming) {
  const row = node('article', 'transfer-item');
  const image = node('span', 'item-icon'); image.append(icon(item.kind === 'file' ? 'file' : 'text'));
  const content = node('div', 'item-content');
  if (item.kind === 'file') content.append(node('strong', '', item.name));
  else content.append(node('p', 'item-text', item.text));
  const time = new Date(item.createdAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  const details = `${incoming ? t('from', { name: item.from }) : t('for', { name: item.to })} · ${item.kind === 'file' ? `${bytes(item.size)} · ` : ''}${time}`;
  content.append(node('p', '', details)); row.append(image, content);
  if (incoming && item.kind === 'file' && item.preview) {
    const preview = node('img', 'file-preview'); preview.alt = t('preview.alt', { name: item.name }); preview.loading = 'lazy'; preview.src = `/api/preview/${item.id}`; content.prepend(preview);
  }
  if (incoming && item.kind === 'file') {
    if (desktop && current.self.isHost) {
      const save = node('button', 'item-action', t('save')); save.prepend(icon('download'));
      save.addEventListener('click', async () => { save.disabled = true; try { const result = await desktop.saveFile(item.id); toast(t('saved', { name: result.name })); } catch (error) { toast(error.message, true); } finally { save.disabled = false; } }); row.append(save);
    } else {
      const link = node('a', 'item-action', t('download')); link.href = `/api/download/${encodeURIComponent(item.id)}`; link.download = item.name; link.prepend(icon('download')); row.append(link);
    }
  } else if (incoming) {
    const button = node('button', 'item-action', t('copy.action')); button.prepend(icon('copy'));
    button.addEventListener('click', () => copy(item.text)); row.append(button);
  } else {
    const mark = node('span', 'sent-mark', t('delivered')); mark.prepend(icon('check')); row.append(mark);
  }
  return row;
}
function addItem(list, item) {
  if (!current[list].some(existing => existing.id === item.id)) current[list].push(item);
  renderHistory();
}
function displayState(data) {
  current = data;
  $('self-name').textContent = data.self.name;
  $('self-icon').setAttribute('href', `#i-${data.self.type === 'computer' ? 'computer' : 'phone'}`);
  $('host-connect').hidden = !data.self.isHost;
  $('guest-connect').hidden = data.self.isHost;
  $('connect-title').textContent = data.self.isHost ? t('connect.title') : t('connect.guestTitle');
  $('connect-subtitle').textContent = data.self.isHost ? t('connect.sub') : t('connect.guestSub');
  $('dropzone').querySelector('small').textContent = t('limit', { size: bytes(data.maxFile) });
  if (data.self.isHost) {
    const previous = $('network').value;
    $('network').replaceChildren(...data.links.map(link => new Option(`${link.name}${link.virtual ? t('net.vpn') : ''} · ${link.address}`, link.address)));
    if (data.links.some(link => link.address === previous)) $('network').value = previous;
    $('network-choice').hidden = data.links.length < 2;
    $('no-network').hidden = data.links.length > 0;
    $('qr').parentElement.hidden = data.links.length === 0;
    $('local-url').parentElement.hidden = data.links.length === 0;
    updateNetwork();
  }
  renderDevices(data.devices); renderHistory();
  renderSecurity(data.security); renderOnboarding();
  $('pwa-guide').hidden = !['phone', 'tablet'].includes(deviceType) || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  $('app').hidden = false; $('gate').hidden = true; $('loading').hidden = true;
}
function paintQr() {
  const link = current?.links.find(item => item.address === $('network').value);
  if (!link) return null;
  $('qr').alt = t('qr.alt'); $('qr').src = `/api/qr?address=${encodeURIComponent(link.address)}&mode=${qrMode}`;
  $('local-url').textContent = qrMode === 'setup' ? link.setupUrl : link.url.split('#')[0];
  $('setup-link').href = '/setup';
  qrTabs.querySelectorAll('button').forEach(button => button.classList.toggle('selected', button.dataset.mode === qrMode));
  $('host-connect').querySelector('h3').textContent = qrMode === 'setup' ? t('qr.setupHeading') : t('qr.heading');
  $('host-connect').querySelector('.connect-description').textContent = qrMode === 'setup' ? t('qr.setupText') : t('qr.text');
  return link;
}
function updateNetwork() {
  paintQr();
  renderOnboarding();
}
const ONBOARD_STEPS = ['welcome', 'network', 'certificate', 'trust', 'connect', 'approve'];
let onboardIndex = 0;
let onboardLatched = false;
let onboardAlready = false;
function onboardDismissed() {
  try { return localStorage.getItem('flydrop-onboarded') === '1'; } catch { return false; }
}
function syncPairingBanner() {
  if (current?.self.isHost && current.security) renderRequests(current.security.requests || []);
}
function revealOnboarding() {
  const layer = $('onboarding');
  const opening = layer.hidden;
  layer.hidden = false;
  document.body.style.overflow = 'hidden';
  syncPairingBanner();
  return opening;
}
function dismissOnboarding() {
  try { localStorage.setItem('flydrop-onboarded', '1'); sessionStorage.removeItem('flydrop-onboard-step'); } catch { /* The screen can still close for this visit. */ }
  onboardLatched = false;
  const layer = $('onboarding');
  if (layer) layer.hidden = true;
  document.body.style.overflow = '';
  syncPairingBanner();
}
function onboardFresh() {
  return !(current?.security?.trusted || []).length && !(current?.devices || []).length;
}
function onboardHints(step) {
  return [1, 2].map(index => {
    const key = `onboard.${step}.${index}`;
    const text = t(key);
    return text === key ? '' : text;
  }).filter(Boolean);
}
function pairingDigits() {
  const block = node('div', 'onboarding-digits');
  block.append(node('small', '', t('code.label')), node('strong', 'request-code', current.security?.pairingCode || ''));
  const expiry = current.security?.pairingExpiresAt;
  block.append(node('span', '', expiry > Date.now() ? t('code.until', { time: new Date(expiry).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) }) : t('code.expired')));
  return block;
}
async function refreshPairingCode(button) {
  button.disabled = true;
  try { displayState(await api('/api/pairing/rotate', { method: 'POST', body: '{}' })); toast(t('rotate.done')); }
  catch (error) { toast(error.message, true); button.disabled = false; }
}
function onboardStage(step, requests) {
  if (step === 'approve' && requests.length === 1) {
    const art = node('div', 'onboarding-art');
    art.append(node('strong', 'request-code', requests[0].verificationCode));
    return art;
  }
  if (step === 'approve' && !requests.length && current.security?.pairingCode) {
    const art = node('div', 'onboarding-code-stage');
    art.append(node('span', '', t('code.label')), node('strong', 'request-code', current.security.pairingCode));
    return art;
  }
  if (step === 'trust') {
    const mark = node('div', 'onboarding-mark');
    mark.append(icon('check'));
    return mark;
  }
  const link = (current.links || []).find(item => item.address === $('network').value);
  if ((step === 'certificate' || step === 'connect') && link) {
    const frame = node('div', 'onboarding-qr');
    const image = document.createElement('img');
    image.alt = t('qr.alt'); image.width = 210; image.height = 210;
    image.src = `/api/qr?address=${encodeURIComponent(link.address)}&mode=${qrMode}`;
    frame.append(image, node('code', '', qrMode === 'setup' ? link.setupUrl : link.url.split('#')[0]));
    return frame;
  }
  const art = node('div', 'onboarding-art');
  if (step === 'network' || ((step === 'certificate' || step === 'connect') && !link)) art.append(icon('wifi'));
  else art.append(icon('computer'), node('span', 'connection-dashes', '···'), icon('phone'));
  return art;
}
function onboardExtra(step, requests) {
  const extra = document.createDocumentFragment();
  if (step === 'welcome' && onboardAlready) extra.append(node('p', 'onboarding-note', t('onboard.already')));
  if (step === 'network') {
    if (!(current.links || []).length) extra.append(node('p', 'connection-warning', t('noNetwork')));
    else if (current.links.length > 1) {
      const field = node('label', 'onboarding-meta');
      field.append(node('small', '', t('network.label')));
      const select = document.createElement('select');
      select.className = 'onboarding-select';
      for (const link of current.links) select.append(new Option(`${link.name}${link.virtual ? t('net.vpn') : ''} · ${link.address}`, link.address));
      select.value = $('network').value;
      select.addEventListener('change', () => { $('network').value = select.value; updateNetwork(); });
      field.append(select); extra.append(field);
    }
  }
  if ((step === 'certificate' || step === 'trust') && current.security?.fingerprint) {
    const meta = node('div', 'onboarding-meta');
    if (current.security.certificateName) meta.append(node('small', '', t('onboard.certName')), node('code', '', current.security.certificateName));
    meta.append(node('small', '', t('onboard.sha')), node('code', '', current.security.fingerprint));
    extra.append(meta);
  }
  if (step === 'connect' && current.security?.pairingCode) {
    extra.append(node('p', 'onboarding-note', t('onboard.connect.code')), pairingDigits());
  }
  if (step === 'approve') {
    if (requests.length) extra.append(...requests.map(requestCard));
    else if (onboardAlready) extra.append(node('p', 'onboarding-note', t('onboard.already')));
    else {
      const expiry = current.security?.pairingExpiresAt;
      extra.append(node('p', 'onboarding-note', expiry > Date.now() ? t('code.until', { time: new Date(expiry).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) }) : t('code.expired')));
      const refresh = node('button', 'text-action', t('code.rotate'));
      refresh.type = 'button';
      refresh.addEventListener('click', () => refreshPairingCode(refresh));
      extra.append(refresh);
    }
  }
  return extra;
}
function paintOnboardingReady() {
  const opening = revealOnboarding();
  $('onboarding-kicker').textContent = t('onboard.readyKicker');
  $('onboarding-title').textContent = t('onboard.ready.title');
  $('onboarding-text').textContent = t('onboard.ready.text');
  $('onboarding-list').hidden = true; $('onboarding-list').replaceChildren();
  $('onboarding-extra').replaceChildren();
  $('onboarding-dots').replaceChildren();
  $('onboarding-back').hidden = true; $('onboarding-skip').hidden = true;
  const next = $('onboarding-next');
  next.hidden = false; next.disabled = false; next.dataset.action = 'done'; next.textContent = t('onboard.done');
  const mark = node('div', 'onboarding-mark'); mark.append(icon('check'));
  $('onboarding-stage').replaceChildren(mark);
  if (opening) next.focus();
}
function renderOnboarding() {
  const layer = $('onboarding');
  if (!layer) return;
  if (!current?.self.isHost || onboardDismissed()) { layer.hidden = true; document.body.style.overflow = ''; syncPairingBanner(); return; }
  const fresh = onboardFresh();
  if (!onboardLatched) {
    onboardLatched = true; onboardAlready = !fresh;
    let saved = 0;
    try { saved = Number(sessionStorage.getItem('flydrop-onboard-step')); } catch { saved = 0; }
    onboardIndex = Number.isInteger(saved) && saved >= 0 && saved < ONBOARD_STEPS.length ? saved : 0;
  }
  if (!onboardAlready && !fresh) { paintOnboardingReady(); return; }
  const requests = current.security?.requests || [];
  const approveAt = ONBOARD_STEPS.indexOf('approve');
  if (requests.length && onboardIndex < approveAt) onboardIndex = approveAt;
  try { sessionStorage.setItem('flydrop-onboard-step', String(onboardIndex)); } catch { /* The step still stays for this visit. */ }
  const step = ONBOARD_STEPS[onboardIndex] || 'welcome';
  const mode = step === 'certificate' || step === 'trust' ? 'setup' : 'connect';
  if (qrMode !== mode && (current.links || []).length) { qrMode = mode; paintQr(); }
  const opening = revealOnboarding();
  $('onboarding-kicker').textContent = t('onboard.progress', { step: onboardIndex + 1, total: ONBOARD_STEPS.length });
  const waitingForPhone = step === 'approve' && !requests.length && !onboardAlready;
  $('onboarding-title').textContent = t(waitingForPhone ? 'onboard.approve.waitTitle' : `onboard.${step}.title`);
  $('onboarding-text').textContent = t(waitingForPhone ? 'onboard.approve.waitText' : `onboard.${step}.text`);
  const hints = onboardHints(step);
  const list = $('onboarding-list');
  list.hidden = hints.length === 0;
  list.replaceChildren(...hints.map((text, index) => {
    const item = node('li');
    item.append(node('span', 'onboarding-index', String(index + 1)), node('span', 'onboarding-hint', text));
    return item;
  }));
  $('onboarding-extra').replaceChildren(onboardExtra(step, requests));
  $('onboarding-dots').replaceChildren(...ONBOARD_STEPS.map((_, index) => {
    const mark = document.createElement('i');
    if (index === onboardIndex) mark.className = 'on';
    else if (index < onboardIndex) mark.className = 'done';
    return mark;
  }));
  const back = $('onboarding-back');
  const skip = $('onboarding-skip');
  const next = $('onboarding-next');
  back.hidden = onboardIndex === 0; back.textContent = t('onboard.back');
  skip.hidden = false; skip.textContent = t('onboard.skip');
  const waiting = step === 'approve' && !requests.length && !onboardAlready;
  const expired = waiting && (current.security?.pairingExpiresAt || 0) <= Date.now();
  const deciding = step === 'approve' && requests.length > 0;
  next.hidden = deciding;
  next.disabled = (waiting && !expired) || (step === 'network' && !(current.links || []).length);
  next.dataset.action = expired ? 'rotate' : step === 'approve' && onboardAlready && !requests.length ? 'done' : 'next';
  next.textContent = expired ? t('code.rotate') : waiting ? t('onboard.wait') : next.dataset.action === 'done' ? t('onboard.done') : t('onboard.next');
  $('onboarding-stage').replaceChildren(onboardStage(step, requests));
  if (opening && !next.hidden) next.focus();
}
function openEvents() {
  events?.close(); events = new EventSource('/api/events');
  events.onopen = () => updateConnection(true);
  events.onerror = async () => {
    updateConnection(false);
    // Recover from a restarted server, whose in-memory session has expired.
    try { await api('/api/state'); } catch (error) {
      if (error.status === 401) {
        events?.close(); current = null; void boot();
      }
    }
  };
  events.addEventListener('state', event => { displayState(JSON.parse(event.data)); updateConnection(true); });
  events.addEventListener('devices', event => { renderDevices(JSON.parse(event.data)); renderOnboarding(); });
  events.addEventListener('received', event => {
    const item = JSON.parse(event.data); addItem('inbox', item);
    toast(item.kind === 'file' ? t('received.file', { name: item.name }) : t('received.text', { name: item.from }));
  });
  events.addEventListener('sent', event => addItem('outbox', JSON.parse(event.data)));
  events.addEventListener('expired', event => {
    const { id } = JSON.parse(event.data);
    current.inbox = current.inbox.filter(item => item.id !== id); current.outbox = current.outbox.filter(item => item.id !== id); renderHistory();
  });
  events.addEventListener('pairings', event => { const requests = JSON.parse(event.data); if (current?.security) current.security.requests = requests; renderRequests(requests); renderOnboarding(); });
  events.addEventListener('trust', event => { current.security.trusted = JSON.parse(event.data); renderSecurity(current.security); renderOnboarding(); });
  events.addEventListener('revoked', () => { events.close(); current = null; pairKey = null; sessionStorage.removeItem('flydrop-pair'); showGate('Доступ отозван', 'Для нового подключения введите актуальный код с компьютера.', false); updateConnection(false); });
}
async function boot() {
  if (booting) return; booting = true; $('loading').hidden = false; $('gate').hidden = true;
  try {
    let savedPending;
    try { savedPending = JSON.parse(sessionStorage.getItem('flydrop-pending') || 'null'); } catch { sessionStorage.removeItem('flydrop-pending'); }
    if (savedPending?.expiresAt > Date.now()) { waitForApproval(savedPending); return; }
    let data;
    try { data = await api('/api/state'); } catch (error) {
      if (error.status !== 401) throw error;
      data = await api('/api/connect', { method: 'POST', body: JSON.stringify({ key: pairKey, desktopTicket, name: localStorage.getItem('flydrop-name') || defaultName, type: deviceType }) });
    }
    if (data.pending) { waitForApproval(data); return; }
    sessionStorage.removeItem('flydrop-pair'); sessionStorage.removeItem('flydrop-pending'); pairKey = null; desktopTicket = null;
    displayState(data); openEvents();
  } catch (error) {
    showGate('Давайте подключимся', error.message, false);
    updateConnection(false);
  } finally { booting = false; }
}
function setMode(value) {
  mode = value;
  for (const type of ['file', 'text']) {
    const selected = type === value;
    $(`${type}-tab`).classList.toggle('selected', selected); $(`${type}-tab`).setAttribute('aria-selected', selected);
    $(`${type}-tab`).tabIndex = selected ? 0 : -1; $(`${type}-panel`).hidden = !selected;
  }
  updateSend();
}
function selectFiles(files) {
  if (busy) return;
  let rejected = 0;
  for (const file of files) {
    if (file.size > current.maxFile) { rejected++; continue; }
    if (!selectedFiles.some(existing => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) selectedFiles.push(file);
  }
  if (rejected) toast(t('tooBig', { size: bytes(current.maxFile), count: rejected }), true);
  renderSelectedFiles(); updateSend();
}
function renderSelectedFiles() {
  $('selected-files').replaceChildren(...selectedFiles.map((file, index) => {
    const row = node('div', 'selected-file'); row.append(icon('file'));
    const details = node('div'); details.append(node('strong', '', file.name), node('small', '', bytes(file.size)));
    const remove = node('button', 'icon-button'); remove.append(icon('close')); remove.disabled = busy;
    remove.setAttribute('aria-label', t('remove', { name: file.name }));
    remove.addEventListener('click', () => { selectedFiles.splice(index, 1); renderSelectedFiles(); updateSend(); });
    row.append(details, remove); return row;
  }));
}
function upload(file, recipient, index, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); activeUpload = xhr;
    xhr.open('POST', '/api/upload'); xhr.setRequestHeader('X-Recipient', recipient);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name)); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.timeout = 30 * 60 * 1000;
    $('progress-label').textContent = `${index + 1} / ${total} · ${file.name}`;
    $('progress').value = 0; $('progress-percent').textContent = '0%';
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) {
        const percent = Math.round(event.loaded / event.total * 100);
        $('progress').value = percent; $('progress-percent').textContent = `${percent}%`;
      }
    };
    xhr.onload = () => {
      let result;
      try { result = JSON.parse(xhr.responseText); } catch { reject(new Error('Не удалось подтвердить передачу')); return; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(result);
      else reject(new Error(result.error || 'Не удалось передать файл'));
    };
    xhr.onerror = () => reject(new Error('Связь прервалась. Проверьте Wi-Fi и приложение на Windows'));
    xhr.onabort = () => reject(new Error('Передача отменена'));
    xhr.ontimeout = () => reject(new Error('Передача заняла слишком много времени. Повторите попытку'));
    xhr.send(file);
  });
}
async function send() {
  if ($('send').disabled) return;
  const recipient = $('recipient').value;
  busy = true; cancelled = false; updateSend(); renderSelectedFiles();
  try {
    if (mode === 'text') {
      const item = await api('/api/text', { method: 'POST', headers: { 'X-Recipient': recipient }, body: JSON.stringify({ text: $('text-input').value }) });
      addItem('outbox', item); $('text-input').value = ''; updateCounter(); toast(t('text.sent'));
    } else {
      $('progress-area').hidden = false;
      const queue = [...selectedFiles];
      for (let index = 0; index < queue.length; index++) {
        if (cancelled) throw new Error('Передача отменена');
        const file = queue[index];
        let item;
        if (file.clipboardId) {
          $('progress-label').textContent = `${index + 1} / ${queue.length} · ${file.name}`;
          $('progress').value = 0; $('progress-percent').textContent = '0%';
          item = await desktop.sendStagedFile(recipient, file.clipboardId);
        } else item = await upload(file, recipient, index, queue.length);
        addItem('outbox', item); selectedFiles = selectedFiles.filter(existing => existing !== file); renderSelectedFiles();
      }
      toast(queue.length > 1 ? t('files.sentMany') : t('files.sent'));
    }
  } catch (error) { toast(error.message, true); }
  finally { busy = false; activeUpload = null; $('progress-area').hidden = true; renderSelectedFiles(); updateSend(); }
}
async function copy(value) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) await navigator.clipboard.writeText(value);
    else {
      // Synchronous fallback keeps the iOS user activation intact.
      const input = node('textarea'); input.value = value; input.style.position = 'fixed'; input.style.top = '0'; input.style.opacity = '0';
      document.body.append(input); input.focus(); input.select(); input.setSelectionRange(0, value.length);
      const successful = document.execCommand('copy'); input.remove();
      if (!successful) throw new Error('Clipboard unavailable');
    }
    toast(t('copied'));
  } catch {
    $('copy-value').value = value; $('copy-dialog').showModal(); $('copy-value').focus(); $('copy-value').select(); $('copy-value').setSelectionRange(0, value.length);
  }
}
function updateCounter() { $('text-counter').textContent = `${$('text-input').value.length.toLocaleString(locale())} / ${Number(50000).toLocaleString(locale())}`; }
let gateView;
function showGate(title, message, waiting) {
  gateView = { title, message, waiting };
  $('gate-title').textContent = localize(lang, title); $('gate-message').textContent = localize(lang, message);
  $('gate').hidden = false; $('app').hidden = true; $('loading').hidden = true;
  $('pair-code-form').hidden = waiting || location.protocol !== 'https:';
  $('verification-code').hidden = !waiting; $('retry').hidden = waiting;
}
function waitForApproval(data) {
  clearTimeout(pairingTimer); sessionStorage.setItem('flydrop-pending', JSON.stringify(data));
  showGate('Подтвердите на Windows', 'Сверьте этот код с запросом в приложении на компьютере и нажмите «Разрешить». До подтверждения доступ к передаче закрыт.', true);
  $('verification-code').textContent = data.verificationCode;
  const poll = async () => {
    if (data.expiresAt <= Date.now()) { sessionStorage.removeItem('flydrop-pending'); showGate('Запрос истёк', 'Введите новый код подключения с компьютера.', false); return; }
    try {
      const result = await api('/api/pair-status', { method: 'POST', body: JSON.stringify({ requestId: data.requestId, token: data.token }) });
      if (result.pending) { pairingTimer = setTimeout(poll, 2000); return; }
      sessionStorage.removeItem('flydrop-pending'); sessionStorage.removeItem('flydrop-pair'); pairKey = null;
      displayState(result); openEvents(); toast('Компьютер подтвердил подключение');
    } catch (error) {
      if (error.status === 403) { sessionStorage.removeItem('flydrop-pending'); showGate('Подключение не разрешено', error.message, false); }
      else { $('gate-message').textContent = error.message; pairingTimer = setTimeout(poll, 4000); }
    }
  };
  pairingTimer = setTimeout(poll, 1000);
}
function requestCard(request) {
  const row = node('article', 'request-row');
  row.append(node('strong', '', request.name), node('span', 'request-code', request.verificationCode), node('small', '', t('pair.address', { address: request.address })));
  const label = node('label', 'remember-device'), remember = node('input'); remember.type = 'checkbox'; remember.checked = true; label.append(remember, document.createTextNode(t('remember'))); row.append(label);
  const actions = node('div', 'request-actions');
  for (const [action, title] of [['approve', t('approve')], ['reject', t('reject')]]) {
    const button = node('button', action === 'approve' ? 'primary' : 'item-action', title);
    button.addEventListener('click', async () => {
      actions.querySelectorAll('button').forEach(item => { item.disabled = true; });
      try { displayState(await api(`/api/pairings/${request.id}/${action}`, { method: 'POST', body: JSON.stringify({ remember: remember.checked }) })); toast(action === 'approve' ? t('approved') : t('rejected')); }
      catch (error) { toast(error.message, true); actions.querySelectorAll('button').forEach(item => { item.disabled = false; }); }
    }); actions.append(button);
  }
  row.append(actions); return row;
}
function renderRequests(requests) {
  if (!current?.self.isHost) { $('pairing-requests').hidden = true; return; }
  $('pairing-requests').hidden = requests.length === 0 || !$('onboarding').hidden;
  $('requests-list').replaceChildren(...requests.map(requestCard));
}
function renderSecurity(security) {
  if (!current) return;
  $('host-security').hidden = !current.self.isHost; $('guest-security').hidden = current.self.isHost;
  if (!current.self.isHost) return;
  $('invitation-code').textContent = security.pairingCode;
  $('invitation-expiry').textContent = security.pairingExpiresAt > Date.now() ? t('code.until', { time: new Date(security.pairingExpiresAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) }) : t('code.expired');
  $('certificate-name').textContent = security.certificateName;
  $('certificate-fingerprint').textContent = security.fingerprint;
  $('notifications-setting').checked = current.settings?.notifications !== false;
  if ($('autosave-setting')) $('autosave-setting').checked = current.settings?.autoSave === true;
  renderRequests(security.requests || []);
  const trusted = security.trusted || [];
  $('no-trusted').hidden = trusted.length > 0;
  $('trusted-list').replaceChildren(...trusted.map(device => {
    const row = node('div', 'trusted-row'), detail = node('div');
    detail.append(node('strong', '', device.name), node('small', '', `${device.online ? t('trusted.online') : t('trusted.offline')} · ${device.remembered ? t('trusted.until', { date: new Date(device.expiresAt).toLocaleDateString(locale()) }) : t('trusted.once')}`));
    const button = node('button', 'item-action', t('trusted.revoke'));
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { displayState(await api(`/api/devices/${device.id}/revoke`, { method: 'POST', body: '{}' })); toast(t('revoked')); }
      catch (error) { toast(error.message, true); button.disabled = false; }
    }); row.append(icon(device.type === 'computer' ? 'computer' : 'phone'), detail, button); return row;
  }));
  $('diagnostics').replaceChildren(...[
    t('diag.self'),
    ...current.links.map(link => t(link.virtual ? 'diag.virtual' : 'diag.adapter', { name: link.name, address: link.address })),
    t('diag.count', { count: current.devices.length }),
    t('diag.https'),
  ].map(text => node('li', '', text)));
  $('desktop-settings').hidden = !desktop;
}
$('connect-code').addEventListener('click', async () => {
  const code = $('pair-code').value.trim(); if (!/^\d{6}$/.test(code)) { toast(t('code.invalid'), true); return; }
  $('connect-code').disabled = true;
  try {
    const data = await api('/api/connect', { method: 'POST', body: JSON.stringify({ code, name: localStorage.getItem('flydrop-name') || defaultName, type: deviceType }) });
    if (data.pending) waitForApproval(data); else { displayState(data); openEvents(); }
  } catch (error) { toast(error.message, true); } finally { $('connect-code').disabled = false; }
});
$('rotate-pairing').addEventListener('click', async () => {
  $('rotate-pairing').disabled = true;
  try { displayState(await api('/api/pairing/rotate', { method: 'POST', body: '{}' })); toast(t('rotate.done')); }
  catch (error) { toast(error.message, true); } finally { $('rotate-pairing').disabled = false; }
});
$('notifications-setting').addEventListener('change', async () => {
  try { const data = await api('/api/settings', { method: 'POST', body: JSON.stringify({ notifications: $('notifications-setting').checked }) }); current.settings = data.settings; }
  catch (error) { toast(error.message, true); $('notifications-setting').checked = current.settings?.notifications !== false; }
});
let refreshDesktop = async () => {};
if (desktop) {
  refreshDesktop = async () => { const prefs = await desktop.settings(); $('autostart-setting').checked = prefs.launchAtLogin; $('downloads-folder').textContent = prefs.downloadsFolder; $('shortcut-status').textContent = prefs.shortcuts ? t('shortcut.on') : t('shortcut.off'); };
  void refreshDesktop().catch(error => toast(error.message, true));
  $('choose-folder').addEventListener('click', async () => { try { await desktop.chooseFolder(); await refreshDesktop(); } catch (error) { toast(error.message, true); } });
  $('autostart-setting').addEventListener('change', async () => { try { await desktop.setAutostart($('autostart-setting').checked); await refreshDesktop(); } catch (error) { toast(error.message, true); await refreshDesktop(); } });
  $('autosave-setting').addEventListener('change', async () => {
    try { const data = await api('/api/settings', { method: 'POST', body: JSON.stringify({ autoSave: $('autosave-setting').checked }) }); current.settings = data.settings; }
    catch (error) { toast(error.message, true); $('autosave-setting').checked = current.settings?.autoSave === true; }
  });
  desktop.onClipboard(value => {
    if (busy) { toast(t('busy'), true); return; }
    selectedFiles = []; renderSelectedFiles(); showView('transfer'); setMode('text');
    $('text-input').value = value.slice(0, 50000); updateCounter(); updateSend(); $('text-input').focus();
    toast(t('clipboard.text'));
  });
  desktop.onClipboardFiles(files => {
    if (busy) { toast(t('busy'), true); return; }
    showView('transfer'); setMode('file');
    selectedFiles = files.map(file => ({ clipboardId: file.id, name: file.name, size: file.size, lastModified: 0 }));
    renderSelectedFiles(); updateSend();
    toast(files.length > 1 ? t('clipboard.files', { count: files.length }) : t('clipboard.file'));
  });
  desktop.onTransferProgress(progress => {
    if (!busy) return;
    $('progress-area').hidden = false;
    if (progress.name) $('progress-label').textContent = progress.total > 1 ? `${progress.index + 1} / ${progress.total} · ${progress.name}` : progress.name;
    const percent = progress.size ? Math.min(100, Math.round((progress.loaded || 0) / progress.size * 100)) : 0;
    $('progress').value = percent; $('progress-percent').textContent = `${percent}%`;
  });
  desktop.onTransferLock(locked => {
    if (locked) busy = true;
    else if (!activeUpload) { busy = false; $('progress-area').hidden = true; }
    updateSend(); renderSelectedFiles();
  });
  desktop.onMessage(message => toast(message));
}
document.addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'Enter' && !event.shiftKey && current) { event.preventDefault(); void send(); } });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => { /* Transfer still works without shell cache */ });
window.addEventListener('online', () => { if (!current) void boot(); });
window.addEventListener('offline', () => updateConnection(false));
$('file-tab').addEventListener('click', () => setMode('file'));
$('text-tab').addEventListener('click', () => setMode('text'));
for (const type of ['file', 'text']) $(`${type}-tab`).addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const value = event.key === 'Home' ? 'file' : event.key === 'End' ? 'text' : type === 'file' ? 'text' : 'file';
  setMode(value); $(`${value}-tab`).focus();
});
$('dropzone').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => { selectFiles(event.target.files); event.target.value = ''; });
for (const event of ['dragenter', 'dragover']) $('dropzone').addEventListener(event, e => { e.preventDefault(); if (!busy) $('dropzone').classList.add('dragging'); });
for (const event of ['dragleave', 'drop']) $('dropzone').addEventListener(event, e => { e.preventDefault(); $('dropzone').classList.remove('dragging'); });
$('dropzone').addEventListener('drop', event => selectFiles(event.dataTransfer.files));
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
$('recipient').addEventListener('change', () => {
  sessionStorage.setItem('flydrop-recipient', $('recipient').value); updateRecipientIcon(); updateSend();
  if (current?.self.isHost) void api('/api/settings', { method: 'POST', body: JSON.stringify({ lastRecipient: $('recipient').value }) }).then(data => { current.settings = data.settings; }).catch(error => toast(error.message, true));
});
$('text-input').addEventListener('input', () => { updateCounter(); updateSend(); });
$('send').addEventListener('click', send);
$('cancel-transfer').addEventListener('click', () => { cancelled = true; activeUpload?.abort(); void desktop?.cancelTransfer(); });
$('network').addEventListener('change', updateNetwork);
$('copy-link').addEventListener('click', () => {
  const link = current.links.find(link => link.address === $('network').value);
  if (link) copy(qrMode === 'setup' ? link.setupUrl : link.url);
});
$('paste').addEventListener('click', async () => {
  if (!navigator.clipboard?.readText || !window.isSecureContext) {
    $('text-input').focus(); toast(t('paste.manual')); return;
  }
  try { $('text-input').value = (await navigator.clipboard.readText()).slice(0, 50000); updateCounter(); updateSend(); }
  catch { $('text-input').focus(); toast(t('paste.fallback')); }
});
$('device-name-button').addEventListener('click', () => {
  if (!current) return;
  $('name-input').value = current.self.name; $('name-dialog').showModal(); $('name-input').focus(); $('name-input').select();
});
async function saveName() {
  const name = $('name-input').value.trim();
  if (!name) { $('name-input').reportValidity(); return; }
  $('save-name').disabled = true;
  try {
    const data = await api('/api/name', { method: 'POST', body: JSON.stringify({ name }) });
    localStorage.setItem('flydrop-name', name); displayState(data); $('name-dialog').close(); toast(t('name.saved'));
  } catch (error) { toast(error.message, true); } finally { $('save-name').disabled = false; }
}
$('save-name').addEventListener('click', saveName);
$('name-dialog').querySelector('form').addEventListener('submit', event => {
  if (event.submitter?.classList.contains('dialog-close')) return;
  event.preventDefault(); void saveName();
});
$('retry').addEventListener('click', boot);
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !current) return;
  try { displayState(await api('/api/state')); } catch { /* EventSource handles reconnect */ }
});
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
function showLanguage() {
  applyDocument(lang); paintQrTabs();
  const button = $('language-toggle');
  if (button) { button.textContent = lang === 'en' ? 'RU' : 'EN'; button.title = t('lang.switch'); button.setAttribute('aria-label', t('lang.switch')); }
  const apple = $('apple-help');
  if (apple) apple.href = lang === 'en' ? 'https://support.apple.com/en-us/102390' : 'https://support.apple.com/ru-ru/102390';
  if (desktop?.setLanguage) void desktop.setLanguage(lang).catch(() => {});
  if (gateView && !$('gate').hidden) showGate(gateView.title, gateView.message, gateView.waiting);
  if (current) { displayState(current); updateCounter(); if (desktop) void refreshDesktop().catch(() => {}); }
  else updateCounter();
  const statusKey = current || gateView ? (connected ? 'status.online' : 'status.offline') : 'status.connecting';
  $('connection-status').lastChild.textContent = t(statusKey);
  showView(currentView, { silent: true, keepScroll: true });
}
$('onboarding-back')?.addEventListener('click', () => { onboardIndex = Math.max(0, onboardIndex - 1); renderOnboarding(); });
$('onboarding-skip')?.addEventListener('click', dismissOnboarding);
$('onboarding-next')?.addEventListener('click', () => {
  if ($('onboarding-next').dataset.action === 'done') { dismissOnboarding(); return; }
  if ($('onboarding-next').dataset.action === 'rotate') { refreshPairingCode($('onboarding-next')); return; }
  if (onboardIndex >= ONBOARD_STEPS.length - 1) return;
  onboardIndex += 1; renderOnboarding();
});
for (const link of document.querySelectorAll('[data-view]')) {
  link.addEventListener('click', event => {
    if (!link.getAttribute('href')?.startsWith('#')) return;
    event.preventDefault();
    showView(link.dataset.view);
  });
}
window.addEventListener('hashchange', () => showView(viewFromLocation(), { silent: true }));
window.addEventListener('popstate', () => showView(viewFromLocation(), { silent: true }));
showView(viewFromLocation(), { replace: true });
$('language-toggle')?.addEventListener('click', () => {
  lang = lang === 'en' ? 'ru' : 'en';
  try { localStorage.setItem('flydrop-lang', lang); } catch { /* Preference stays for this visit. */ }
  showLanguage();
});
setInterval(renderHistory, 15000);
showLanguage();
void boot();
