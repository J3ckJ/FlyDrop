import { connect, remember, upload } from './net.js';
import { bootExperiments, experimentReport, holdLockScreen, localNotice, releaseWakeLock, requestWakeLock, setBadge, setPlaybackState, subscribePush } from './experiments.js';
import { zipFiles } from './zip.js';

const root = document.querySelector('#app');
const shot = new URLSearchParams(location.search).get('shot');
const state = {
  phase: 'boot',
  error: '',
  code: '',
  token: localStorage.getItem('pult-token') || '',
  info: null,
  tab: 'computers',
  screen: 'home',
  sheet: null,
  index: 0,
  search: '',
  computers: [],
  tasks: [],
  notes: [],
  clipboard: null,
  recent: [],
  dragId: null,
  hotId: null,
  mods: new Set(),
  experiments: {},
  frameUrl: '',
  hold: 0,
  warning: '',
};

let session;
let pointers = new Map();

function computerById(id) { return state.computers.find(item => item.id === id); }
function current() { return state.computers[state.index] || state.computers[0]; }

function seedDemo(info) {
  state.computers = [
    { id: 'macbook', name: 'MacBook Pro', os: 'macos', online: true, battery: 82, subtitle: 'Spotify, Xcode · батарея 82 %\nWi-Fi «Home» · 192.168.1.24', flydropSoon: true, volume: 40, media: { title: 'Teardrop', artist: 'Massive Attack', app: 'Spotify', playing: true, position: 134, duration: 330 }, apps: [
      { id: 'Spotify', name: 'Spotify', running: true }, { id: 'Safari', name: 'Safari', running: false }, { id: 'Terminal', name: 'Терминал', running: false }, { id: 'Xcode', name: 'Xcode', running: true },
    ] },
    { id: 'self', name: info.name || 'Windows ПК', os: 'windows', online: true, live: true, subtitle: 'в сети · desktop-eugene', volume: 40, media: null, apps: [] },
    { id: 'mini', name: 'mac-mini', os: 'macos', online: false, asleep: true, subtitle: 'спит 3 ч', mac: 'B8:27:EB:00:00:01', backup: '03:00' },
  ];
  state.tasks = [
    { id: 'music', computerId: 'macbook', kind: 'media', title: 'Teardrop', detail: 'Massive Attack · Spotify · 2:14' },
    { id: 'fly', computerId: 'self', kind: 'flydrop', title: 'IMG_2041.jpg', detail: 'FlyDrop → Windows ПК', percent: 64, loaded: 33, total: 51 },
  ];
  state.clipboard = { from: 'MacBook Pro', age: '10 с назад', text: 'ssh://git@mac-mini.local:2222/eugene/el-workspace.git' };
  state.notes = [
    { id: 'n1', title: 'FlyDrop: фото получено', body: 'Windows ПК · сейчас', ok: true },
    { id: 'n2', title: 'Xcode: сборка успешна', body: 'MacBook Pro · 2 мин', ok: true },
    { id: 'n3', title: 'Windows: нужна перезагрузка', body: 'Windows ПК · 14 мин', ok: false },
  ];
  state.recent = [{ id: 'recent-1', file: new File([new Uint8Array(48 * 1024)], 'IMG_2041.jpg', { type: 'image/jpeg' }) }];
}

function singleComputer(info) {
  state.computers = [{ id: 'self', name: info.name || 'Компьютер', os: info.os, online: true, live: true, subtitle: 'в сети', volume: 0, media: null, apps: [], mac: info.mac }];
}

function applyStatus(payload) {
  const computer = computerById('self');
  if (!computer || !payload) return;
  computer.volume = payload.volume ?? computer.volume;
  computer.media = payload.media;
  computer.battery = payload.battery;
  computer.asleep = payload.asleep;
  computer.online = !payload.asleep;
  computer.unavailable = payload.unavailable ? (payload.reason || computer.unavailable || 'Управление недоступно') : '';
  if (payload.flydrop?.active) upsertTransfer(payload.flydrop);
}

function upsertTransfer(fly) {
  const percent = fly.percent ?? (fly.total ? Math.round(fly.loaded / fly.total * 100) : 0);
  const task = { id: 'fly', computerId: 'self', kind: 'flydrop', title: fly.name || 'Файл', detail: `FlyDrop → ${current()?.name || 'компьютер'}`, percent, loaded: fly.loaded, total: fly.total };
  state.tasks = [task, ...state.tasks.filter(item => item.id !== 'fly')];
  if (fly.state === 'done' || fly.state === 'cancelled' || fly.state === 'error') {
    state.tasks = state.tasks.filter(item => item.id !== 'fly');
    state.notes.unshift({ id: crypto.randomUUID(), title: fly.state === 'done' ? 'FlyDrop: файл получен' : 'FlyDrop остановлен', body: fly.name || '', ok: fly.state === 'done' });
  }
}

function filtered() {
  const query = state.search.trim().toLowerCase();
  if (!query) return state.computers;
  return state.computers.filter(computer => `${computer.name} ${computer.subtitle || ''}`.toLowerCase().includes(query));
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function icon(name) {
  const paths = {
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    display: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M4 15h16M12 15v6"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h1M10 10h1M14 10h1M7 14h10"/>',
    volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/>',
    apps: '<circle cx="7" cy="7" r="2.2"/><circle cx="17" cy="7" r="2.2"/><circle cx="7" cy="17" r="2.2"/><circle cx="17" cy="17" r="2.2"/>',
    power: '<path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0"/>',
    inbox: '<path d="M4 13l2.5-8h11l2.5 8v6H4z"/>',
    bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  };
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${paths[name] || ''}</svg>`;
}

function preview(computer) {
  const fps = computer.live ? '<span class="fps">экран · 12 кадр/с</span>' : '';
  if (computer.live && state.frameUrl) return `<div class="preview"><img alt="Экран ${esc(computer.name)}" src="${state.frameUrl}">${fps}</div>`;
  return `<div class="preview"><div class="win" style="left:22px;top:28px;width:120px;height:78px"><span></span></div><div class="win" style="left:90px;top:58px;width:130px;height:70px"><span></span></div>${fps}</div>`;
}

function home() {
  const cards = filtered();
  return `<div class="cards" id="cards">${cards.map(computer => `
    <article class="card ${state.hotId === computer.id ? 'hot' : ''}" data-id="${esc(computer.id)}">
      ${preview(computer)}
      ${state.hotId === computer.id ? `<div class="dropmsg"><b>Отпустите —<br>на ${esc(computer.name)}</b><small>FlyDrop · по Wi-Fi, без облака<br>до 1 ГБ · папка уйдёт zip</small></div>` : ''}
      <div class="meta">
        <div class="presence"><i class="dot ${computer.asleep ? 'amber' : ''}"></i>${computer.asleep ? 'Спит' : 'В сети · рядом'}</div>
        <h2>${esc(computer.name)}</h2>
        <p>${esc(computer.subtitle || '')}</p>
        ${computer.flydropSoon ? '<p class="soon">FlyDrop для Mac — скоро</p>' : `<button class="primary" data-action="control" data-id="${esc(computer.id)}">${icon('display')} Управлять</button>`}
      </div>
    </article>`).join('') || '<p class="soon">Ничего не нашлось</p>'}</div>
    <div class="tasks">${state.tasks.map(task => `<button class="chip" data-action="now">${esc(task.title)} <small>· ${task.percent != null ? `${task.percent} %` : esc(task.detail || '')}</small></button>`).join('')}</div>
    <div class="tray" id="tray">
      ${state.recent.map(file => `<button class="filechip" data-file="${esc(file.id)}">${esc(file.file.name)}<br><small>${Math.ceil(file.file.size / 1024)} КБ</small></button>`).join('')}
      <label class="filechip">Добавить<input id="files" type="file" multiple hidden></label>
      <label class="filechip">Папка<input id="folder" type="file" webkitdirectory multiple hidden></label>
    </div>`;
}

function control() {
  const computer = current();
  const media = computer?.media;
  return `<div class="control"><div class="top"><button class="back glass" data-action="home">←</button><b>${esc(computer?.name || '')}</b><span class="dot"></span></div>
    <div class="stage">
      ${preview(computer || {})}
      <div class="radar">
        <button class="sat glass tl" data-action="keyboard">${icon('keyboard')}<span>Клавиатура</span></button>
        <button class="sat glass tr" data-action="volume">${icon('volume')}<span>Громкость</span></button>
        <button class="sat glass bl" data-action="media">${icon('apps')}<span>Приложения</span></button>
        <button class="sat glass br" data-action="power">${icon('power')}<span>Питание</span></button>
        <button class="orb" data-action="trackpad">${icon('display')}Управлять</button>
      </div>
    </div>
    ${media ? `<div class="nowbar"><div class="art"></div><div class="t"><b>Громкость ${computer.volume ?? 0} % · ${esc(media.app || '')} ${media.playing ? 'играет' : 'пауза'}</b></div><button data-action="toggle">${media.playing ? '❚❚' : '▶'}</button></div>` : ''}</div>`;
}

function trackpad() {
  return `<div class="track"><div class="top"><button class="back glass" data-action="control">←</button><b>${esc(current()?.name || '')}</b></div>
    <div class="pad" id="pad"></div>
    <div class="mods">
      ${['Ctrl', 'Alt', 'Win', 'Tab', 'Esc'].map(key => `<button data-mod="${key}" class="${state.mods.has(key) ? 'on' : ''}">${key}</button>`).join('')}
      <button data-action="paste-remote">Буфер</button>
    </div></div>`;
}

function now() {
  return `<div class="list"><div class="top"><button class="back glass" data-action="home">←</button><div><b>Сейчас</b><div class="soon">${state.tasks.length} задачи</div></div></div>
    ${state.tasks.map(task => `<article class="row"><h3>${esc(task.title)}</h3><p>${esc(task.detail || '')}</p>${task.percent != null ? `<div class="progress"><i style="width:${task.percent}%"></i></div><button data-action="cancel">Отменить</button>` : ''}</article>`).join('') || '<p class="soon">Фоновых задач нет</p>'}
    ${state.computers.filter(computer => computer.asleep).map(computer => `<article class="row"><h3>${esc(computer.name)}</h3><p>Бэкап в ${esc(computer.backup || '03:00')} — разбудим сами</p><button class="wake" data-action="wake" data-id="${esc(computer.id)}">Разбудить</button></article>`).join('')}</div>`;
}

function media() {
  const computer = current();
  const item = computer?.media || { title: 'Ничего не играет', artist: '', playing: false, app: '' };
  const apps = computer?.apps || [];
  return `<div class="media"><div class="top"><button class="back glass" data-action="control">←</button></div>
    <div class="cover"></div>
    <h2>${esc(item.title)}</h2><p>${esc(item.artist)} ${item.app ? `· ${esc(item.app)}` : ''}</p>
    <div class="transport"><button data-action="prev">⏮</button><button class="play" data-action="toggle">${item.playing ? '❚❚' : '▶'}</button><button data-action="next">⏭</button></div>
    <h3>Открыть на ${esc(computer?.name || '')}</h3>
    <div class="apps">${apps.map(app => `<button data-action="launch" data-id="${esc(app.id)}"><div class="appico ${app.running ? 'run' : ''}">${esc(app.name.slice(0, 1))}</div>${esc(app.name)}</button>`).join('') || '<p class="soon">Список приложений появится с компьютера</p>'}</div></div>`;
}

function inbox() {
  return `<div class="list"><h2>Входящие</h2><p class="soon">буфер и уведомления со всех компьютеров</p>
    <div class="clip">${state.clipboard ? `<div class="soon">Буфер · ${esc(state.clipboard.from)} · ${esc(state.clipboard.age || '')}</div><div class="mono">${esc(state.clipboard.text)}</div><button class="big" data-action="paste-phone">Вставить на iPhone</button>` : '<p>Буфер пуст</p>'}</div>
    ${state.notes.map(note => `<div class="note"><span class="dot ${note.ok ? '' : 'amber'}"></span><div><b>${esc(note.title)}</b><div class="soon">${esc(note.body)}</div></div></div>`).join('')}</div>`;
}

function scenarios() {
  const caps = state.experiments;
  return `<div class="list"><h2>Сценарии</h2>
    <article class="row"><h3>Бэкап mac-mini</h3><p>Каждую ночь в 03:00 Пульт шлёт Wake-on-LAN.</p><button class="primary" data-action="schedule">Запомнить 03:00</button></article>
    <article class="row"><h3>Экран блокировки</h3><p>Живая карточка в приложении и то, что браузер реально умеет снаружи.</p><button class="primary" data-action="lock">Открыть</button><button class="primary" data-action="push">Включить уведомления</button></article>
    <ul class="caps">${Object.entries(caps).map(([key, value]) => `<li><b>${esc(key)}</b> — ${esc(value)}</li>`).join('')}</ul></div>`;
}

function lock() {
  const transfer = state.tasks.find(task => task.kind === 'flydrop');
  const media = state.computers.find(computer => computer.media)?.media;
  return `<div class="lock"><div class="status"><span></span><span>${media ? '♪' : ''}</span></div>
    <div>Воскресенье, 18 октября</div><div class="clock">21:27</div>
    <div class="widgets">${state.computers.slice(0, 3).map(computer => `<div>${esc(computer.name.split(' ')[0])}<b style="color:${computer.asleep ? 'var(--amber)' : 'var(--green)'}">${computer.battery ? `${computer.battery} %` : computer.asleep ? 'спит' : 'в сети'}</b></div>`).join('')}</div>
    ${transfer ? `<div class="la"><b>FlyDrop → ${esc(computerById(transfer.computerId)?.name || '')}</b><div class="progress"><i style="width:${transfer.percent || 0}%"></i></div><small>${transfer.percent || 0} %</small></div>` : ''}
    ${media ? `<div class="la"><div class="art"></div><b>${esc(media.title)}</b><small>${esc(media.artist)}</small><div><button data-action="prev">⏮</button><button data-action="toggle">${media.playing ? '❚❚' : '▶'}</button><button data-action="next">⏭</button></div></div>` : ''}
    <p class="soon">Настоящий Dynamic Island сайту недоступен. Полоска сверху — его изображение. Кнопка ниже просит систему показать медиакарточку и push.</p>
    <button class="primary" data-action="hold-lock">Держать на блокировке</button>
    <button class="back" data-action="scenarios">Закрыть</button></div>`;
}

function sheet() {
  if (state.sheet === 'power') {
    const computer = current();
    const transfer = state.tasks.find(task => task.kind === 'flydrop');
    return `<div class="sheet glass"><div class="handle"></div><h3>Питание · ${esc(computer?.name || '')}</h3>
      ${transfer ? `<p class="warn">FlyDrop ещё идёт: ${transfer.percent || 0} % — выключение подождёт</p>` : ''}
      ${state.warning ? `<p class="warn">${esc(state.warning)}</p>` : ''}
      <div class="grid3"><button data-action="sleep">Сон</button><button data-action="lock-pc">Блокировка</button><button data-action="restart">Перезагрузка</button></div>
      <button class="hold" id="hold" data-action="hold-down"><i style="width:${state.hold}%"></i>Удерживайте, чтобы выключить</button>
      ${state.computers.filter(item => item.asleep).map(item => `<div class="row"><b>${esc(item.name)}</b><p>спит · Wake-on-LAN</p><button class="wake" data-action="wake" data-id="${esc(item.id)}">Разбудить</button></div>`).join('')}</div>`;
  }
  if (state.sheet === 'keyboard') {
    const keys = ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ', 'ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э', 'я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', ' '];
    return `<div class="sheet glass"><div class="handle"></div><div class="mods">${keys.map(key => `<button class="key" data-key="${esc(key)}">${key === ' ' ? 'пробел' : esc(key)}</button>`).join('')}<button data-action="close-sheet">Закрыть</button></div></div>`;
  }
  if (state.sheet === 'volume') {
    const computer = current();
    return `<div class="sheet glass"><div class="handle"></div><h3>Громкость ${computer?.volume ?? 0} %</h3><input id="vol" type="range" min="0" max="100" value="${computer?.volume ?? 0}"><button data-action="close-sheet">Закрыть</button></div>`;
  }
  return '';
}

function pairing() {
  const digits = state.code.padEnd(6, ' ').slice(0, 6).split('');
  return `<div class="pair"><div class="status"><span>9:41</span></div><h1>Пульт</h1><p>Введите код с экрана компьютера. Без кода управление закрыто.</p>
    <div class="digits">${digits.map((digit, index) => `<input inputmode="numeric" maxlength="1" data-digit="${index}" value="${digit.trim()}">`).join('')}</div>
    <p class="err">${esc(state.error)}</p>
    <button class="big" data-action="submit-code">Подключить</button>
    <p><a href="/setup">Если Safari не доверяет сертификату</a></p></div>`;
}

function shell(body) {
  if (state.phase !== 'app') return pairing();
  const transfer = state.tasks.find(task => task.kind === 'flydrop');
  const island = transfer ? `<button class="island" data-action="lock"><b>${transfer.percent || 0}%</b><span>♪</span></button>` : '';
  const tabs = state.screen === 'home' && !state.sheet ? `<nav class="tabbar glass">
      <button class="${state.tab === 'computers' ? 'on' : ''}" data-tab="computers">${icon('display')}Компьютеры</button>
      <button class="${state.tab === 'inbox' ? 'on' : ''}" data-tab="inbox">${icon('inbox')}Входящие ${state.notes.length ? `<span class="badge">${state.notes.length}</span>` : ''}</button>
      <button class="${state.tab === 'scenarios' ? 'on' : ''}" data-tab="scenarios">${icon('bolt')}Сценарии</button>
    </nav>` : '';
  const blocked = state.computers.find(item => item.unavailable);
  const banner = blocked ? `<p class="warn banner">${esc(blocked.unavailable)}</p>` : '';
  return `<div class="status"><span>9:41</span><span></span></div>${island}
    ${state.screen === 'home' ? `<label class="search glass">${icon('search')}<input id="search" placeholder="Поиск или команда" value="${esc(state.search)}">${icon('mic')}</label>` : ''}
    ${banner}
    <div class="screen">${body}</div>${sheet()}${tabs}`;
}

function screenBody() {
  if (state.screen === 'control') return control();
  if (state.screen === 'trackpad') return trackpad();
  if (state.screen === 'now') return now();
  if (state.screen === 'media') return media();
  if (state.screen === 'lock') return lock();
  if (state.tab === 'inbox') return inbox();
  if (state.tab === 'scenarios') return scenarios();
  return home();
}

function render() {
  const search = document.querySelector('#search');
  const keep = search && document.activeElement === search ? search.value : null;
  root.innerHTML = shell(state.phase === 'app' ? screenBody() : '');
  if (keep != null) {
    const field = document.querySelector('#search');
    if (field) { field.value = keep; field.focus(); }
  }
  bindDrag();
  bindPad();
  bindHold();
  bindVolume();
  bindDigits();
  bindCards();
}

async function send(type, payload) {
  if (!session) return { ok: false, error: 'Нет связи' };
  const computer = current();
  if (computer && computer.id !== 'self' && ['input.move', 'input.click', 'input.key', 'input.text', 'volume.set', 'power.action', 'apps.launch', 'media.command'].includes(type)) {
    return demoLocal(type, payload, computer);
  }
  const result = await session.request(type, payload);
  if (!result.ok && type !== 'input.move' && type !== 'flydrop.progress' && result.error) {
    const live = computerById('self');
    if (live) live.unavailable = result.error;
  }
  return result;
}

function demoLocal(type, payload, computer) {
  if (type === 'media.command') {
    if (payload.action === 'toggle') computer.media.playing = !computer.media.playing;
    if (payload.action === 'pause') computer.media.playing = false;
    if (payload.action === 'play') computer.media.playing = true;
    if (payload.action === 'next') computer.media = { ...computer.media, title: 'Angel', position: 0 };
  }
  if (type === 'volume.set') computer.volume = payload.level;
  if (type === 'apps.launch') {
    const app = computer.apps.find(item => item.id === payload.id);
    if (app) app.running = true;
  }
  if (type === 'power.action' && payload.action === 'sleep') computer.asleep = true;
  render();
  return { ok: true, payload: {} };
}

async function pair(code) {
  state.error = '';
  const hello = await session.request('hello', { name: 'iPhone' });
  if (!hello.ok) throw new Error(hello.error);
  const paired = await session.request('pair', { code, name: 'iPhone' });
  if (!paired.ok) throw new Error(paired.error);
  state.token = paired.payload.token;
  localStorage.setItem('pult-token', state.token);
  await remember(state.token);
  state.info = paired.payload;
  enter(paired.payload);
}

function enter(info) {
  state.phase = 'app';
  state.info = info;
  if (info.demo) seedDemo(info);
  else singleComputer(info);
  const live = Math.max(0, state.computers.findIndex(computer => computer.live));
  if (shot === 'control' || shot === 'trackpad' || shot === 'power') state.index = live;
  if (shot === 'control') state.screen = 'control';
  if (shot === 'trackpad') state.screen = 'trackpad';
  if (shot === 'now') state.screen = 'now';
  if (shot === 'media') state.screen = 'media';
  if (shot === 'inbox') { state.tab = 'inbox'; }
  if (shot === 'power') { state.screen = 'control'; state.sheet = 'power'; }
  if (shot === 'drop') { state.hotId = 'self'; state.index = live; }
  if (shot === 'lock') state.screen = 'lock';
  render();
  if (shot === 'drop') root.querySelector('[data-id="self"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  void refresh();
  void session.request('screen.subscribe', { fps: 12 }).catch(() => {});
}

async function refresh() {
  const status = await session.request('status.get');
  const self = computerById('self');
  if (status.ok) applyStatus(status.payload);
  else if (self && status.error) self.unavailable = status.error;
  const apps = await session.request('apps.list');
  if (apps.ok && self) self.apps = apps.payload.apps || [];
  else if (self && !self.unavailable && apps.error) self.unavailable = apps.error;
  const clip = await session.request('clipboard.get');
  if (clip.ok && clip.payload.text) state.clipboard = { from: state.info?.name || 'Компьютер', age: 'сейчас', text: clip.payload.text };
  else if (self && !self.unavailable && clip.error) self.unavailable = clip.error;
  render();
  if (shot === 'drop') root.querySelector('[data-id="self"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  await syncOutside();
}

async function syncOutside() {
  const count = state.notes.length;
  await setBadge(count);
  const transfer = state.tasks.find(task => task.kind === 'flydrop');
  if (transfer) localNotice('FlyDrop', `${transfer.title} · ${transfer.percent || 0}%`, 'pult-flydrop');
  const media = state.computers.find(item => item.media?.playing)?.media;
  if (media) setPlaybackState(media.playing);
}

async function onAction(action, target) {
  const id = target.dataset.id;
  if (id && state.computers.some(computer => computer.id === id)) state.index = state.computers.findIndex(computer => computer.id === id);
  if (action === 'submit-code') {
    try { await pair(state.code); } catch (error) { state.error = error.message; render(); }
    return;
  }
  if (action === 'home') { state.screen = 'home'; state.sheet = null; await releaseWakeLock(); }
  if (action === 'control') { state.screen = 'control'; state.sheet = null; }
  if (action === 'trackpad') { state.screen = 'trackpad'; await requestWakeLock(); }
  if (action === 'now') state.screen = 'now';
  if (action === 'media') state.screen = 'media';
  if (action === 'keyboard') state.sheet = 'keyboard';
  if (action === 'volume') state.sheet = 'volume';
  if (action === 'power') { state.sheet = 'power'; state.warning = ''; }
  if (action === 'close-sheet') state.sheet = null;
  if (action === 'lock') state.screen = 'lock';
  if (action === 'scenarios') { state.screen = 'home'; state.tab = 'scenarios'; }
  if (action === 'toggle' || action === 'next' || action === 'prev') {
    const map = { toggle: 'toggle', next: 'next', prev: 'previous' };
    await send('media.command', { action: map[action] });
    await syncOutside();
  }
  if (action === 'launch') await send('apps.launch', { id });
  if (action === 'sleep') await send('power.action', { action: 'sleep' });
  if (action === 'lock-pc') await send('power.action', { action: 'lock' });
  if (action === 'restart') await send('power.action', { action: 'restart' });
  if (action === 'wake') {
    const computer = computerById(id);
    if (computer?.mac) await session.request('wol.wake', { mac: computer.mac });
    if (computer) { computer.asleep = false; computer.online = true; computer.subtitle = 'в сети'; }
  }
  if (action === 'schedule') {
    const mini = computerById('mini') || current();
    if (mini?.mac) await session.request('wol.schedule.put', { mac: mini.mac, label: 'Бэкап', hour: 3, minute: 0 });
  }
  if (action === 'paste-phone' && state.clipboard) {
    try { await navigator.clipboard.writeText(state.clipboard.text); } catch { state.error = 'Safari не дал записать буфер'; }
  }
  if (action === 'paste-remote' && state.clipboard) await send('clipboard.set', { text: state.clipboard.text });
  if (action === 'cancel') {
    state.tasks = state.tasks.filter(task => task.id !== 'fly');
    await session.request('flydrop.progress', { name: 'отмена', loaded: 0, total: 0, state: 'cancelled' }).catch(() => {});
  }
  if (action === 'push') state.experiments = await subscribePush();
  if (action === 'hold-lock') {
    const media = current()?.media || { title: 'Пульт', artist: 'передача', app: 'Пульт' };
    await holdLockScreen(true, { title: media.title, artist: media.artist, album: media.app }, {
      play: () => onAction('toggle', target),
      pause: () => onAction('toggle', target),
      nexttrack: () => onAction('next', target),
      previoustrack: () => onAction('prev', target),
    });
    state.experiments = experimentReport();
  }
  render();
}

root.addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; state.screen = 'home'; render(); return; }
  const mod = event.target.closest('[data-mod]');
  if (mod) {
    const key = mod.dataset.mod;
    if (state.mods.has(key)) state.mods.delete(key); else state.mods.add(key);
    const name = { Ctrl: 'ctrl', Alt: 'alt', Win: 'win', Tab: 'tab', Esc: 'escape' }[key];
    void send('input.key', { key: name, down: state.mods.has(key), modifiers: [...state.mods] });
    render();
    return;
  }
  const key = event.target.closest('[data-key]');
  if (key) { void send('input.text', { text: key.dataset.key }); return; }
  const action = event.target.closest('[data-action]');
  if (action) void onAction(action.dataset.action, action);
});

root.addEventListener('input', event => {
  if (event.target.id === 'search') {
    state.search = event.target.value;
    const command = state.search.trim().toLowerCase();
    if (command.startsWith('разбудить')) {
      const asleep = state.computers.find(computer => computer.asleep);
      if (asleep) void onAction('wake', { dataset: { id: asleep.id } });
    }
    render();
  }
  const digit = event.target.dataset.digit;
  if (digit != null) {
    const chars = state.code.split('');
    chars[Number(digit)] = event.target.value.replace(/\D/g, '').slice(-1);
    state.code = chars.join('').replace(/\s/g, '').slice(0, 6);
    const next = root.querySelector(`[data-digit="${Number(digit) + 1}"]`);
    if (next && event.target.value) next.focus();
    if (state.code.length === 6) void onAction('submit-code', event.target);
  }
});

root.addEventListener('change', async event => {
  if (event.target.id === 'files') addRecent([...event.target.files]);
  if (event.target.id === 'folder') {
    try { addRecent([await zipFiles([...event.target.files])]); }
    catch (error) { state.notes.unshift({ id: crypto.randomUUID(), title: 'Папка не отправлена', body: error.message, ok: false }); }
  }
  render();
});

function addRecent(files) {
  for (const file of files) state.recent.unshift({ id: crypto.randomUUID(), file });
  state.recent = state.recent.slice(0, 8);
}

function bindDrag() {
  for (const chip of root.querySelectorAll('[data-file]')) {
    chip.addEventListener('pointerdown', event => {
      state.dragId = chip.dataset.file;
      chip.setPointerCapture(event.pointerId);
    });
    chip.addEventListener('pointermove', event => {
      if (!state.dragId) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('.card');
      state.hotId = hit?.dataset.id || null;
      for (const card of root.querySelectorAll('.card')) card.classList.toggle('hot', card.dataset.id === state.hotId);
    });
    chip.addEventListener('pointerup', async () => {
      const file = state.recent.find(item => item.id === state.dragId);
      const target = state.hotId;
      state.dragId = null;
      state.hotId = null;
      if (file && target) await sendFile(file.file, target);
      render();
    });
  }
}

async function sendFile(file, computerId) {
  const computer = computerById(computerId);
  if (computer?.flydropSoon) {
    state.notes.unshift({ id: crypto.randomUUID(), title: 'FlyDrop для Mac — скоро', body: file.name, ok: false });
    return;
  }
  state.tasks = [{ id: 'fly', computerId: 'self', kind: 'flydrop', title: file.name, detail: `FlyDrop → ${computer?.name || ''}`, percent: 0, total: file.size, loaded: 0 }, ...state.tasks.filter(task => task.id !== 'fly')];
  render();
  try {
    await upload(file, async (loaded, total) => {
      const percent = Math.round(loaded / total * 100);
      upsertTransfer({ name: file.name, loaded, total, percent, state: 'uploading', active: true });
      await session.request('flydrop.progress', { name: file.name, loaded, total, state: 'uploading' }).catch(() => {});
      const bar = root.querySelector('.progress i');
      if (bar) bar.style.width = `${percent}%`;
    });
    upsertTransfer({ name: file.name, loaded: file.size, total: file.size, state: 'done', active: false });
  } catch (error) {
    state.notes.unshift({ id: crypto.randomUUID(), title: 'Передача не удалась', body: error.message, ok: false });
    state.tasks = state.tasks.filter(task => task.id !== 'fly');
  }
  await syncOutside();
  render();
}

function bindPad() {
  const pad = root.querySelector('#pad');
  if (!pad) return;
  pad.addEventListener('pointerdown', event => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, t: Date.now() });
    pad.setPointerCapture(event.pointerId);
  });
  pad.addEventListener('pointermove', event => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    const dx = event.clientX - prev.x;
    const dy = event.clientY - prev.y;
    prev.x = event.clientX; prev.y = event.clientY;
    if (dx || dy) void send('input.move', { dx, dy });
  });
  pad.addEventListener('pointerup', event => {
    const prev = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (prev && Date.now() - prev.t < 220) void send('input.click', { button: 'left', count: 1 });
  });
}

function bindHold() {
  const hold = root.querySelector('#hold');
  if (!hold) return;
  let timer;
  const start = event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const began = Date.now();
    timer = setInterval(() => {
      state.hold = Math.min(100, (Date.now() - began) / 9);
      const fill = hold.querySelector('i');
      if (fill) fill.style.width = `${state.hold}%`;
      if (state.hold >= 100) {
        clearInterval(timer);
        void shutdown();
      }
    }, 30);
  };
  const stop = () => { clearInterval(timer); state.hold = 0; const fill = hold.querySelector('i'); if (fill) fill.style.width = '0%'; };
  hold.addEventListener('pointerdown', start);
  hold.addEventListener('pointerup', stop);
  hold.addEventListener('pointerleave', stop);
}

async function shutdown() {
  const force = Boolean(state.warning);
  const result = await send('power.action', { action: 'shutdown', hold: true, force });
  if (result.ok && result.payload?.performed === false) state.warning = result.payload.warning;
  else state.sheet = null;
  render();
}

function bindVolume() {
  const slider = root.querySelector('#vol');
  if (!slider) return;
  slider.addEventListener('change', () => { void send('volume.set', { level: Number(slider.value) }); });
}

function bindCards() {
  const scroller = root.querySelector('#cards');
  if (!scroller) return;
  scroller.addEventListener('scroll', () => {
    const card = scroller.querySelector('.card');
    if (!card) return;
    const step = card.getBoundingClientRect().width + 12;
    const next = Math.max(0, Math.min(state.computers.length - 1, Math.round(scroller.scrollLeft / step)));
    if (next !== state.index) state.index = next;
  }, { passive: true });
}

function bindDigits() {
  const first = root.querySelector('[data-digit="0"]');
  if (first && !state.code) first.focus();
}

async function main() {
  state.experiments = await bootExperiments();
  try {
    session = await connect();
    session.onEvent(message => {
      if (message.type === 'event.notification') state.notes.unshift({ id: crypto.randomUUID(), title: message.payload.title, body: message.payload.body, ok: true });
      if (message.type === 'event.clipboard') state.clipboard = { from: state.info?.name || 'Компьютер', age: 'сейчас', text: message.payload.text };
      if (message.type === 'event.flydrop') upsertTransfer(message.payload);
      if (message.type === 'event.media' || message.type === 'status.get') applyStatus(message.payload);
      if (message.type === 'event.screen' && message.payload?.error) {
        const live = computerById('self');
        if (live) live.unavailable = message.payload.error;
      }
      render();
      void syncOutside();
    });
    session.onFrame((_meta, jpeg) => {
      if (state.frameUrl) URL.revokeObjectURL(state.frameUrl);
      state.frameUrl = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
      const image = root.querySelector('.preview img');
      if (image) image.src = state.frameUrl;
    });
    if (state.token) {
      const hello = await session.request('hello', { name: 'iPhone', token: state.token });
      if (hello.ok && hello.payload.paired) {
        await remember(state.token);
        enter(hello.payload);
        return;
      }
      localStorage.removeItem('pult-token');
    }
    state.phase = 'pair';
    render();
  } catch (error) {
    state.phase = 'pair';
    state.error = error.message;
    render();
  }
}

void main();
