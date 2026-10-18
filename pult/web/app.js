import { connect, remember, upload } from './net.js';
import { bootExperiments, experimentReport, holdLockScreen, localNotice, releaseWakeLock, requestWakeLock, setBadge, setPlaybackState, subscribePush } from './experiments.js';
import { zipFiles } from './zip.js';

const root = document.querySelector('#app');
const shot = new URLSearchParams(location.search).get('shot');
const SHOTS = {
  '01': 'home', home: 'home',
  '02': 'control', control: 'control',
  '03': 'trackpad', trackpad: 'trackpad',
  '04': 'drop', drop: 'drop',
  '05': 'now', now: 'now',
  '06': 'media', media: 'media',
  '07': 'inbox', inbox: 'inbox',
  '08': 'power', power: 'power',
  '09': 'lock', lock: 'lock',
};
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
  state.demo = true;
  state.computers = [
    { id: 'macbook', name: 'MacBook Pro', os: 'macos', online: true, battery: 82, host: '192.168.1.24', subtitle: 'Spotify, Xcode · батарея 82 %\nWi-Fi «Home» · 192.168.1.24', flydropSoon: true, volume: 40, media: { title: 'Teardrop', artist: 'Massive Attack', app: 'Spotify', playing: true, position: 134, duration: 330 }, apps: [
      { id: 'Spotify', name: 'Spotify', running: true, glyph: 'note' },
      { id: 'Safari', name: 'Safari', running: true, glyph: 'search' },
      { id: 'Terminal', name: 'Терминал', running: false, glyph: 'term' },
      { id: 'Xcode', name: 'Xcode', running: false, glyph: 'screen' },
      { id: 'more', name: 'Ещё', running: false, glyph: 'plus' },
    ] },
    { id: 'self', name: info.name || 'Windows ПК', os: 'windows', online: true, live: true, host: 'desktop-eugene', subtitle: 'в сети · desktop-eugene', volume: 40, media: null, apps: [] },
    { id: 'mini', name: 'mac-mini', os: 'macos', online: false, asleep: true, host: 'mac-mini', subtitle: 'спит 3 ч', mac: 'B8:27:EB:00:00:01', backup: '03:00' },
  ];
  state.tasks = [
    { id: 'music', computerId: 'macbook', kind: 'media', title: 'Teardrop', detail: 'Massive Attack · Spotify · 2:14' },
    { id: 'fly', computerId: 'self', kind: 'flydrop', title: 'FlyDrop · IMG_2041.jpg', detail: '2,0 из 3,1 МБ · ≈ 2 с', percent: 64, loaded: 2, total: 3.1 },
  ];
  state.clipboard = { from: 'MacBook Pro', age: '10 с назад', text: 'ssh://git@mac-mini.local:2222/eugene/el-workspace.git' };
  state.notes = [
    { id: 'n1', title: 'FlyDrop: фото получено', body: 'Windows ПК · хранится ещё 59 мин', time: 'сейчас', tone: 'blue' },
    { id: 'n2', title: 'Xcode: сборка успешна', body: 'MacBook Pro · EL Workspace · 48 с', time: '2 мин', tone: 'green' },
    { id: 'n3', title: 'Windows: нужна перезагрузка', body: 'Windows ПК · сделать ночью?', time: '1 ч', tone: 'muted' },
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

const ICONS = {
  power: '<path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  kbd: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h1M9.5 10h1M13 10h1M16.5 10h1M7 14h10"/>',
  pad: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M4 15h16M12 15v6"/>',
  play: '<path d="M7 5l12 7-12 7z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  vol: '<path d="M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.500 8.500 0 0 1 0 12"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  clip: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  wake: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3.5"/>',
  next: '<path d="M6 6l9 6-9 6zM18 6v12"/>',
  prev: '<path d="M18 6l-9 6 9 6zM6 6v12"/>',
  apps: '<circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="7" r="2.5"/><circle cx="7" cy="17" r="2.5"/><circle cx="17" cy="17" r="2.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  mac: '<rect x="4" y="5" width="16" height="10.500" rx="1.500"/><path d="M2 18h20"/>',
  pc: '<rect x="3" y="4" width="13" height="10" rx="1.500"/><path d="M7 18h5M9.500 14v4M19 5v14"/>',
  mini: '<rect x="3.500" y="9" width="17" height="6" rx="2"/><path d="M7 12h1"/>',
  note: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  restart: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/>',
  tray: '<path d="M4 13l2.5-8h11l2.5 8v6H4zM4 13h5l1 2h4l1-2h5"/>',
};

function ic(name, size = 20, weight = 1.9, extra = '') {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${weight}" stroke-linecap="round" stroke-linejoin="round" style="${extra}">${ICONS[name] || ''}</svg>`;
}

function bars(width, height, gap) {
  const bar = `width:${width}px;height:${height}px;background:#0b0c0e;border-radius:2px`;
  return `<span style="display:flex;gap:${gap}px"><i style="${bar}"></i><i style="${bar}"></i></span>`;
}

function kindOf(computer) {
  if (computer?.asleep) return 'sleep';
  if (computer?.os === 'windows') return 'pc';
  return 'mac';
}

function pv(kind, live = '', frame = '') {
  if (frame) return `<div class="pv" style="background:#000"><img alt="" src="${frame}">${live}</div>`;
  if (kind === 'mac') {
    return `<div class="pv"><div class="w" style="left:30px;top:40px;width:160px;height:108px"><i></i></div><div class="w" style="left:140px;top:84px;width:170px;height:112px;background:rgba(255,255,255,.12)"><i></i></div><div class="dk"><b></b><b></b><b></b><b></b><b></b><b></b></div>${live}</div>`;
  }
  if (kind === 'pc') {
    return `<div class="pv" style="background:linear-gradient(170deg,#1d3346,#121820)"><div class="w" style="left:34px;top:30px;width:190px;height:120px"><i></i></div><div class="w" style="left:150px;top:70px;width:180px;height:116px;background:rgba(255,255,255,.12)"><i></i></div><div class="tb"><b></b><b></b><b></b><b></b><b></b></div>${live}</div>`;
  }
  return `<div class="pv" style="background:#101114;display:grid;place-items:center;color:rgba(255,159,10,.55)">${ic('moon', 44, 1.6)}</div>`;
}

function tab(active) {
  const items = [['computers', 'mac', 'Компьютеры'], ['inbox', 'tray', 'Входящие'], ['scenarios', 'bolt', 'Сценарии']];
  return `<nav class="tab glass">${items.map(([id, icon, label]) => {
    const on = id === active ? 'background:rgba(255,255,255,.18)' : '';
    const count = id === 'inbox' && state.notes.length ? ` class="bd" data-count="${state.notes.length}"` : '';
    return `<button data-tab="${id}" style="${on}"${count}>${ic(icon, 24)}${label}</button>`;
  }).join('')}</nav>`;
}

function dots(active) {
  return `<div class="dots">${[0, 1, 2].map(index => `<i class="${index === active ? 'a' : ''}"></i>`).join('')}</div>`;
}

function taskChips() {
  return `<div class="tasks"><button class="chip" data-action="now">${ic('note', 16, 2.2, 'color:#30d158')}Teardrop <small>· Mac</small></button><button class="chip" data-action="now" style="border-color:rgba(10,132,255,.45)">${ic('send', 17, 2.6, 'color:#0a84ff')}→ ПК <small>· 64 %</small></button></div>`;
}

function searchBar() {
  return `<label class="srch glass ${state.search ? 'has' : ''}">${ic('search', 18, 2.2)}<span class="q">${state.search ? esc(state.search) : 'Поиск или команда'}</span><input id="search" placeholder="Поиск или команда" value="${esc(state.search)}" autocomplete="off"><span class="mc">${ic('mic', 18, 2)}</span></label>`;
}

function fileTray() {
  return `<div class="offtray" id="tray">${state.recent.map(file => `<button data-file="${esc(file.id)}">${esc(file.file.name)}</button>`).join('')}<input id="files" type="file" multiple hidden><input id="folder" type="file" webkitdirectory multiple hidden></div>`;
}

function homeCard(computer, index) {
  const left = 14 + (index - state.index) * 350;
  const active = index === state.index;
  const peek = index === state.index + 1;
  const hot = state.hotId === computer.id;
  const frame = !state.demo && computer.live && state.frameUrl ? state.frameUrl : '';
  let inner = pv(kindOf(computer), '', frame);
  if (active) {
    const status = computer.asleep
      ? '<div class="st sl"><i></i>Спит</div>'
      : '<div class="st on"><i></i>В сети · рядом</div>';
    const meta = computer.id === 'macbook'
      ? `Spotify, Xcode · батарея <span>${computer.battery ?? 82} %</span><br>Wi-Fi «Home» · <span class="mono" style="font-size:12.5px">${esc(computer.host || '192.168.1.24')}</span>`
      : esc(computer.subtitle || '').replace(/\n/g, '<br>');
    inner += `<div class="tx">${status}<h2>${esc(computer.name)}</h2><div class="m">${meta}</div></div><button class="big" data-action="control" data-id="${esc(computer.id)}">${ic('pad', 22, 2.2)}Управлять</button>`;
  }
  const glow = peek && !hot ? 'border-color:rgba(10,132,255,.5);box-shadow:0 0 24px rgba(10,132,255,.25)' : '';
  return `<article class="card${hot ? ' hot' : ''}" data-id="${esc(computer.id)}" data-presence="${computer.asleep ? 'asleep' : 'online'}" data-action="select" style="left:${left}px;${glow}">${inner}</article>`;
}

function home() {
  const cards = filtered();
  return `<div class="bk"></div>${searchBar()}<div id="deck">${cards.map((computer, index) => homeCard(computer, state.computers.indexOf(computer) === -1 ? index : state.computers.indexOf(computer))).join('') || ''}</div>${dots(Math.max(0, state.index))}${state.demo ? taskChips() : `<div class="tasks">${state.tasks.map(task => `<button class="chip" data-action="now">${esc(task.title)} <small>· ${task.percent != null ? `${task.percent} %` : ''}</small></button>`).join('')}</div>`}${fileTray()}${tab('computers')}`;
}

function header(computer) {
  const asleep = Boolean(computer?.asleep);
  return `<div class="hd"><button class="bb glass gbtn" data-action="home">${ic('back', 20, 2.4)}</button><div><b>${esc(computer?.name || '')}</b><small class="${asleep ? 'sl' : ''}"><i></i>${asleep ? 'спит' : 'в сети'} · <em>${esc(computer?.host || '')}</em></small></div><div class="glass gbtn" style="width:44px;height:44px;margin-left:auto">${ic('search', 18, 2.2)}</div></div>`;
}

function nowBar(hidden) {
  const media = state.computers.find(item => item.media)?.media;
  const playing = state.demo ? media?.playing !== false : Boolean(media?.playing);
  const volume = state.demo ? 40 : (current()?.volume ?? 0);
  const app = state.demo ? 'Spotify' : (media?.app || 'музыка');
  return `<div class="np"${hidden ? ' style="display:none"' : ''}><div class="art"></div><div class="t"><b>Громкость ${volume} % · ${esc(app)} ${playing ? 'играет' : 'пауза'}</b><div class="sl"><i style="width:${volume}%"></i></div></div><button class="pp" data-action="toggle">${bars(4.5, 16, 4)}</button></div>`;
}

function satellites() {
  return `<button class="orb" data-action="trackpad">${ic('pad', 36, 1.9)}Управлять</button>
    <button class="sat glass" style="left:56px;top:440px" data-action="keyboard">${ic('kbd', 24)}<span>Клавиатура</span></button>
    <button class="sat glass" style="left:337px;top:440px" data-action="volume">${ic('vol', 24)}<span>Громкость</span></button>
    <button class="sat glass" style="left:56px;top:628px" data-action="media">${ic('apps', 22)}<span>Приложения</span></button>
    <button class="sat glass" style="left:337px;top:628px" data-action="power">${ic('power', 24)}<span>Питание</span></button>`;
}

function control() {
  const computer = current() || {};
  const live = `<div class="live"><i></i>экран · 12 кадр/с</div>`;
  const frame = !state.demo && computer.live && state.frameUrl ? state.frameUrl : '';
  return `<div class="bk"></div>${header(computer)}<div class="prev">${pv(kindOf(computer) === 'sleep' ? 'pc' : kindOf(computer), live, frame)}</div>${satellites()}${nowBar(state.sheet === 'power')}${sheet()}`;
}

function trackpad() {
  const computer = current();
  const dot = computer?.asleep ? '#ff9f0a' : '#30d158';
  return `<div class="pad" id="pad"></div>
    <div class="trail" style="left:120px;top:384px;width:80px;transform:rotate(-24deg)"></div>
    <div class="trail" style="left:158px;top:426px;width:80px;transform:rotate(-24deg)"></div>
    <div class="tp" style="left:196px;top:320px"></div><div class="tp" style="left:236px;top:364px"></div>
    <button class="topg glass" data-action="control">${ic(computer?.os === 'windows' ? 'pc' : 'mac', 18)}${esc(computer?.name || '')}<span style="color:${dot};font-size:12px">●</span>${ic('chev', 14, 2.4, 'transform:rotate(90deg);opacity:.6')}</button>
    <div class="hint" style="bottom:170px">Два пальца — прокрутка · Три вверх — Win+Tab<br>Свайп по краю — следующий компьютер</div>
    <div class="keys">${['Ctrl', 'Alt', 'Win', 'Tab', 'Esc'].map(key => `<button data-mod="${key}" class="${state.mods.has(key) ? 'on' : ''}">${key}</button>`).join('')}</div>
    <div class="tool glass"><button class="on" data-action="trackpad">${ic('pad', 24)}</button><button data-action="keyboard">${ic('kbd', 24)}</button><button data-action="paste-remote">${ic('clip', 22)}</button><button data-action="media">${ic('apps', 22)}</button><button data-action="power">${ic('power', 23)}</button></div>${state.sheet ? sheet() : ''}`;
}

function drop() {
  return `<div class="bk"></div>
    <div class="hint" style="top:70px;font-size:14px;color:rgba(255,255,255,.6)">Тяните на компьютер — FlyDrop отправит сам<br><span style="font-size:12.5px;color:rgba(255,255,255,.4)">← MacBook Pro: FlyDrop для Mac — скоро</span></div>
    <div class="card dim" style="left:-300px"></div>
    <div class="card drop" data-id="self" style="left:28px;width:337px">${pv('pc')}<div class="dropmsg"><b>Отпустите —<br>на Windows ПК</b><small>FlyDrop · по Wi-Fi, без облака<br>до 1 ГБ · папка уйдёт zip</small></div></div>
    <div class="card dim" style="left:378px"></div>
    <div class="ghost" style="left:205px;top:520px"><span>${ic('send', 15, 2.8)}</span></div>
    <div class="hint" style="top:648px;left:180px;right:auto;font-size:12.5px;color:#fff">IMG_2041.jpg · 3,1 МБ</div>
    <div class="trayt glass"><div class="l"><span>Недавние на iPhone</span><span>Фото · Файлы · Буфер</span></div><div class="r">
      <label style="border:2px dashed rgba(255,255,255,.35);background:transparent"><input id="files" type="file" multiple hidden></label>
      <div style="background:#f2f2f4">PDF</div>
      <div style="background:linear-gradient(135deg,#7a9aa6,#2c3a40)"></div>
      <div style="background:#f2f2f4">ZIP</div>
      <div style="background:#26292e;color:#c7c9ce;font-size:20px">Aa</div>
    </div></div>`;
}

function now() {
  const music = state.computers.find(item => item.media);
  const fly = state.tasks.find(task => task.kind === 'flydrop');
  const mini = state.computers.find(item => item.asleep) || state.computers.find(item => item.id === 'mini');
  const flyWidth = fly?.percent ?? 64;
  return `<div class="bk"></div>
    <div class="ttl"><b>Сейчас</b><small>${state.tasks.length} задачи идут параллельно</small></div>
    <div class="trow" style="top:150px"><div class="h">${ic('mac', 18)}${esc(music?.name || 'MacBook Pro')}<span class="s" style="color:#30d158"><i></i>в сети</span></div>
      <div class="b"><div class="art" style="width:52px;height:52px"></div><div class="t"><b>${esc(music?.media?.title || 'Teardrop')}</b><small>${esc(state.tasks.find(task => task.kind === 'media')?.detail || 'Massive Attack · Spotify · 2:14')}</small></div><div class="np" style="position:static;width:44px;height:44px;padding:0;border:0;background:none"><button class="pp" data-action="toggle">${ic('pause', 18, 3)}</button></div></div></div>
    ${fly ? `<div class="trow" style="top:300px;border-color:rgba(10,132,255,.45);box-shadow:0 0 22px rgba(10,132,255,.18)"><div class="h">${ic('pc', 18)}Windows ПК<span class="s" style="color:#30d158"><i></i>в сети</span></div>
      <div class="b"><div style="width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,#c9b79a,#5d7a85);flex:none"></div><div class="t"><b>${esc(fly.title)}</b><small>${esc(fly.detail || '')}</small><div class="pbar"><i style="width:${flyWidth}%;background:#0a84ff;box-shadow:0 0 10px rgba(10,132,255,.8)"></i></div></div><button class="rb" data-action="cancel">${ic('x', 16, 2.6)}</button></div></div>` : ''}
    ${mini ? `<div class="trow" style="top:466px"><div class="h">${ic('mini', 18)}${esc(mini.name)}<span class="s" style="color:#ff9f0a"><i></i>${mini.asleep ? 'спит 3 ч' : 'в сети'}</span></div>
      <div class="b"><div class="t"><b>Бэкап в ${esc(mini.backup || '03:00')}</b><small>разбудим по Wake-on-LAN сами</small></div><button class="rb" style="background:#ff9f0a;color:#0b0c0e" data-action="wake" data-id="${esc(mini.id)}">${ic('wake', 16, 2.4)}&nbsp;Разбудить</button></div></div>` : ''}
    <div class="hint" style="top:610px">Сведите пальцы на главной, чтобы попасть сюда</div>
    ${tab('computers')}`;
}

function media() {
  const computer = current() || {};
  const item = computer.media || { title: 'Teardrop', artist: 'Massive Attack', app: 'Spotify', playing: true };
  const apps = computer.apps?.length ? computer.apps : [
    { id: 'Spotify', name: 'Spotify', running: true, glyph: 'note' },
    { id: 'Safari', name: 'Safari', running: true, glyph: 'search' },
    { id: 'Terminal', name: 'Терминал', running: false, glyph: 'term' },
    { id: 'Xcode', name: 'Xcode', running: false, glyph: 'screen' },
    { id: 'more', name: 'Ещё', running: false, glyph: 'plus' },
  ];
  const dot = computer.asleep ? '#ff9f0a' : '#30d158';
  const iconFor = app => {
    if (app.glyph === 'term') return '<i style="font-size:15px" class="mono">&gt;_</i>';
    if (app.glyph === 'screen') return `<i>${ic('screen', 24, 2)}</i>`;
    if (app.glyph === 'plus') return `<i>${ic('plus', 22, 2)}</i>`;
    if (app.glyph === 'search') return `<i class="${app.running ? 'run' : ''}">${ic('search', 24, 2)}</i>`;
    return `<i class="${app.running ? 'run' : ''}">${ic(app.glyph || 'note', 24, 2)}</i>`;
  };
  return `<div class="bk"></div>
    <button class="topg glass" data-action="control">${ic('mac', 18)}${esc(computer.name || 'MacBook Pro')}<span style="color:${dot};font-size:12px">●</span>${ic('chev', 14, 2.4, 'transform:rotate(90deg);opacity:.6')}</button>
    <div class="cover"></div>
    <div class="trk"><b>${esc(item.title)}</b><small>${esc(item.artist)} · ${esc(item.app || 'Spotify')} на ${esc(computer.name || 'MacBook Pro')}</small></div>
    <div class="pos"><i></i><span style="left:0">2:14</span><span style="right:0">5:30</span></div>
    <div class="ctl"><button data-action="prev">${ic('prev', 30, 2)}</button><button class="pl" data-action="toggle">${bars(7, 26, 6)}</button><button data-action="next">${ic('next', 30, 2)}</button></div>
    <div class="apl"><div class="l">Открыть на ${esc(computer.name || 'MacBook')}</div><div class="r">${apps.map(app => `<button ${app.id === 'more' ? '' : `data-action="launch" data-id="${esc(app.id)}"`}>${iconFor(app)}${esc(app.name)}</button>`).join('')}</div></div>`;
}

function inbox() {
  const tones = { blue: '#0a84ff', green: '#30d158', muted: '#c7c9ce' };
  const icons = { blue: 'send', green: 'check', muted: 'restart' };
  return `<div class="bk"></div>
    <div class="ttl"><b>Входящие</b><small>буфер и уведомления со всех компьютеров</small></div>
    <div class="clipc">${state.clipboard ? `<div class="h">${ic('clip', 18)}Буфер · ${esc(state.clipboard.from)} · ${esc(state.clipboard.age || '')}</div><div class="v mono">${esc(state.clipboard.text)}</div><button class="big" data-action="paste-phone">${ic('check', 20, 2.6)}Вставить на iPhone</button>` : '<div class="h">Буфер пуст</div>'}</div>
    <div class="sub">Уведомления</div>
    ${state.notes.slice(0, 3).map((note, index) => {
      const tone = note.tone || (note.ok ? 'green' : 'muted');
      return `<div class="nt" style="top:${446 + index * 84}px"><div class="ico" style="color:${tones[tone] || tones.muted}">${ic(icons[tone] || 'restart', 20, tone === 'green' ? 2.4 : 2.2)}</div><div class="t"><b>${esc(note.title)}</b><small>${esc(note.body)}</small></div><span class="w">${esc(note.time || '')}</span></div>`;
    }).join('')}
    ${tab('inbox')}`;
}

function lockClock() {
  if (state.demo || shot) return { date: 'Воскресенье, 18 октября', time: '21:27' };
  const now = new Date();
  const date = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(now);
  return { date: date.charAt(0).toUpperCase() + date.slice(1), time };
}

function lock() {
  const clock = lockClock();
  const transfer = state.tasks.find(task => task.kind === 'flydrop');
  const mediaComputer = state.computers.find(computer => computer.media);
  const media = mediaComputer?.media;
  const widgets = state.demo
    ? [['MacBook', '82 %', '#30d158'], ['ПК', 'в сети', '#30d158'], ['mac-mini', 'спит', '#ff9f0a']]
    : state.computers.slice(0, 3).map(computer => [computer.name.split(' ')[0], computer.battery ? `${computer.battery} %` : computer.asleep ? 'спит' : 'в сети', computer.asleep ? '#ff9f0a' : '#30d158']);
  return `<div class="lk"></div>
    <div class="clock"><div>${esc(clock.date)}</div><b>${esc(clock.time)}</b></div>
    <div class="wd">${widgets.map(([label, value, color]) => `<div>${esc(label)}<b style="color:${color}">${esc(value)}</b></div>`).join('')}</div>
    ${transfer ? `<div class="la" style="bottom:252px"><div class="t"><div class="lg" style="background:#0a84ff">${ic('send', 22, 2.4)}</div><div><b>FlyDrop → ${esc(computerById(transfer.computerId)?.name || 'Windows ПК')}</b><small>${esc(transfer.title.includes('IMG') ? 'IMG_2041.jpg' : transfer.title)}</small></div><span class="pc">${transfer.percent || 0}%</span></div><div class="bar"><i style="width:${transfer.percent || 0}%"></i></div><div class="ft"><span>${esc(transfer.detail?.split(' · ')[0] || '')}</span><span>${esc(transfer.detail?.split(' · ')[1] || '')}</span></div></div>` : ''}
    ${media ? `<div class="la" style="bottom:118px"><div class="t"><div class="art" style="width:42px;height:42px;border-radius:12px"></div><div><b>${esc(media.title)}</b><small>на ${esc(mediaComputer.name)}</small></div><div class="mc"><button data-action="prev">${ic('prev', 22, 2)}</button><span style="display:flex;gap:4px"><i style="width:5px;height:20px;background:#fff;border-radius:2px"></i><i style="width:5px;height:20px;background:#fff;border-radius:2px"></i></span><button data-action="next">${ic('next', 22, 2)}</button></div></div></div>` : ''}
    <div class="lkb"><button class="glass gbtn" data-action="hold-lock">${ic('bolt', 22)}</button><button class="glass gbtn" data-action="trackpad">${ic('pad', 22)}</button></div>`;
}

function scenarios() {
  const caps = state.experiments;
  return `<div class="bk"></div>
    <div class="ttl"><b>Сценарии</b><small>Wake-on-LAN и то, что браузер умеет снаружи</small></div>
    <div class="trow" style="top:160px"><div class="h">${ic('mini', 18)}mac-mini</div><div class="b"><div class="t"><b>Бэкап в 03:00</b><small>Каждую ночь Пульт шлёт Wake-on-LAN.</small></div><button class="rb" style="background:#ff9f0a;color:#0b0c0e" data-action="schedule">Запомнить</button></div></div>
    <div class="trow" style="top:300px"><div class="b"><div class="t"><b>Экран блокировки</b><small>Живые карточки показывает система, не страница.</small></div><button class="rb" data-action="lock">Открыть</button></div><div class="b"><button class="rb" data-action="push">Уведомления</button></div></div>
    <ul class="caps">${Object.entries(caps).map(([key, value]) => `<li><b>${esc(key)}</b> — ${esc(value)}</li>`).join('')}</ul>
    ${tab('scenarios')}`;
}

function sheet() {
  if (state.sheet === 'power') {
    const computer = current();
    const transfer = state.tasks.find(task => task.kind === 'flydrop');
    const asleep = state.computers.find(item => item.asleep);
    return `<div class="shade" data-action="close-sheet"></div>
      <div class="sheetg glass" style="background:rgba(40,42,46,.72)"><div class="gr"></div><h3>Питание · ${esc(computer?.name || '')}</h3>${transfer ? `<p>FlyDrop ещё идёт: ${transfer.percent || 0} % — выключение подождёт</p>` : '<p>Сон, блокировка или выключение</p>'}
      ${state.warning ? `<p class="pnote"><i></i>${esc(state.warning)}</p>` : ''}
      <div class="pw"><button data-action="sleep">${ic('moon', 24)}Сон</button><button data-action="lock-pc">${ic('lock', 24)}Блокировка</button><button data-action="restart">${ic('restart', 24)}Перезагрузка</button></div>
      <button class="hold" id="hold"><i style="width:${state.hold}%"></i><span>${ic('power', 22, 2.2)}Удерживайте, чтобы выключить</span></button>
      ${asleep ? `<div class="wol">${ic('mini', 22)}<div>${esc(asleep.name)}<br><small>спит · Wake-on-LAN</small></div><button class="rb" data-action="wake" data-id="${esc(asleep.id)}">Разбудить</button></div>` : ''}</div>`;
  }
  if (state.sheet === 'keyboard') {
    const keys = ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ', 'ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э', 'я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', ' '];
    return `<div class="shade" data-action="close-sheet"></div><div class="sheetg glass" style="background:rgba(40,42,46,.72)"><div class="gr"></div><h3>Клавиатура</h3><p>Символ сразу уходит на компьютер</p><div class="board">${keys.map(key => `<button data-key="${esc(key)}">${key === ' ' ? 'пробел' : esc(key)}</button>`).join('')}</div><button class="pairgo" style="position:static;width:100%;margin-top:16px" data-action="close-sheet">Закрыть</button></div>`;
  }
  if (state.sheet === 'volume') {
    const computer = current();
    return `<div class="shade" data-action="close-sheet"></div><div class="sheetg glass" style="background:rgba(40,42,46,.72)"><div class="gr"></div><h3>Громкость</h3><p>${computer?.volume ?? 0} %</p><input class="voline" id="vol" type="range" min="0" max="100" value="${computer?.volume ?? 0}"><button class="pairgo" style="position:static;width:100%;margin-top:24px" data-action="close-sheet">Закрыть</button></div>`;
  }
  return '';
}

function pairing() {
  const digits = state.code.padEnd(6, ' ').slice(0, 6).split('');
  return `<div class="bk"></div><div class="ttl"><b>Пульт</b><small>Введите код с экрана компьютера. Без кода управление закрыто.</small></div>
    <div class="digits">${digits.map((digit, index) => `<input inputmode="numeric" maxlength="1" data-digit="${index}" value="${digit.trim()}">`).join('')}</div>
    ${state.error ? `<div class="notice" style="top:376px"><i></i><div><b>Не вышло подключить</b><small>${esc(state.error)}</small></div></div>` : '<p class="err"></p>'}
    <button class="pairgo" data-action="submit-code">Подключить</button>
    <p class="setuplink"><a href="/setup">Если Safari не доверяет сертификату</a></p>`;
}

function notice() {
  if (shot) return '';
  const blocked = state.computers.find(item => item.unavailable);
  if (!blocked?.unavailable) return '';
  return `<div class="notice" role="status"><i></i><div><b>Управление недоступно</b><small>${esc(blocked.unavailable)}</small></div></div>`;
}

function shell(body) {
  return `<div class="stage">${body}${notice()}</div>`;
}

function screenBody() {
  if (state.phase !== 'app') return pairing();
  if (state.screen === 'control') return control();
  if (state.screen === 'trackpad') return trackpad();
  if (state.screen === 'drop') return drop();
  if (state.screen === 'now') return now();
  if (state.screen === 'media') return media();
  if (state.screen === 'lock') return lock();
  if (state.tab === 'inbox') return inbox();
  if (state.tab === 'scenarios') return scenarios();
  return home();
}

function applyShot(id) {
  state.screen = 'home';
  state.tab = 'computers';
  state.sheet = null;
  state.index = 0;
  if (id === 'control' || id === 'trackpad' || id === 'power' || id === 'drop') {
    state.index = Math.max(0, state.computers.findIndex(computer => computer.id === 'self'));
  }
  if (id === 'control' || id === 'power') state.screen = 'control';
  if (id === 'trackpad') { state.screen = 'trackpad'; state.mods.add('Ctrl'); }
  if (id === 'now') state.screen = 'now';
  if (id === 'media') state.screen = 'media';
  if (id === 'inbox') state.tab = 'inbox';
  if (id === 'power') { state.sheet = 'power'; state.hold = 38; }
  if (id === 'drop') state.screen = 'drop';
  if (id === 'lock') state.screen = 'lock';
}

function render() {
  const search = document.querySelector('#search');
  const keep = search && document.activeElement === search ? search.value : null;
  const mini = state.computers.find(computer => computer.id === 'mini');
  root.dataset.mini = mini ? (mini.asleep ? 'asleep' : 'online') : '';
  root.innerHTML = shell(screenBody());
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
  document.body.dataset.ready = '1';
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
  if (shot && SHOTS[shot]) {
    document.documentElement.classList.add('shot');
    seedDemo({ name: 'Windows ПК' });
    applyShot(SHOTS[shot]);
    state.phase = 'app';
    render();
    return;
  }
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
