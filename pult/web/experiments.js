const results = {
  serviceWorker: 'не проверялось',
  push: 'не поддерживается',
  badge: 'не поддерживается',
  wakeLock: 'не поддерживается',
  mediaSession: 'не поддерживается',
  backgroundSync: 'не поддерживается в этом браузере',
  localNotification: 'не проверялось',
  shareTarget: 'только если система отдаёт файлы установленному приложению',
  fileInput: 'есть',
};

let audioUrl;
let wakeLock;
let mediaBound = false;

function wavSilence() {
  const samples = 8000;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + samples, true);
  bytes.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

export function experimentReport() {
  return { ...results, standalone: window.matchMedia('(display-mode: standalone)').matches };
}

export async function bootExperiments() {
  results.badge = 'setAppBadge' in navigator ? 'API есть' : 'нет в этом браузере';
  results.wakeLock = 'wakeLock' in navigator ? 'API есть, только пока экран открыт' : 'нет в этом браузере';
  results.mediaSession = 'mediaSession' in navigator ? 'API есть, нужен звук' : 'нет в этом браузере';
  results.backgroundSync = 'serviceWorker' in navigator && 'SyncManager' in window ? 'API есть' : 'нет в WebKit';
  results.push = 'PushManager' in window ? 'API есть, на iPhone только с экрана Домой' : 'нет в этом браузере';
  if (!('serviceWorker' in navigator)) {
    results.serviceWorker = 'нет';
    return results;
  }
  try {
    await navigator.serviceWorker.register('/sw.js');
    results.serviceWorker = 'зарегистрирован';
  } catch (error) {
    results.serviceWorker = error.message;
  }
  return results;
}

export async function subscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    results.push = 'нет в этом браузере';
    return results;
  }
  const registration = await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    results.push = 'разрешение не дано';
    return results;
  }
  const keyResponse = await fetch('/api/push/key');
  const { publicKey } = await keyResponse.json();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBuffer(publicKey),
  });
  const saved = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription),
  });
  results.push = saved.ok ? 'подписка сохранена' : 'сервер не принял подписку';
  try {
    await registration.sync.register('pult-flush');
    results.backgroundSync = 'регистрация принята';
  } catch {
    results.backgroundSync = 'браузер не принял background sync';
  }
  return results;
}

export async function setBadge(count) {
  if (!('setAppBadge' in navigator)) return;
  try {
    if (count > 0) await navigator.setAppBadge(count);
    else await navigator.clearAppBadge();
    results.badge = count > 0 ? `значок ${count}` : 'значок снят';
  } catch (error) {
    results.badge = error.message;
  }
}

export function localNotice(title, body, topic) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    results.localNotification = 'нет разрешения или API';
    return false;
  }
  try {
    const note = new Notification(title, { body, tag: topic, renotify: true });
    results.localNotification = 'показано';
    note.onerror = () => { results.localNotification = 'система отклонила'; };
    return true;
  } catch (error) {
    results.localNotification = error.message;
    return false;
  }
}

export async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    results.wakeLock = 'экран не гаснет, пока Пульт открыт';
  } catch (error) {
    results.wakeLock = error.message;
  }
}

export async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}

export async function holdLockScreen(active, meta, handlers) {
  if (!('mediaSession' in navigator)) return;
  if (!audioUrl) audioUrl = wavSilence();
  let audio = document.querySelector('audio[data-pult]');
  if (!audio) {
    audio = document.createElement('audio');
    audio.dataset.pult = '1';
    audio.loop = true;
    audio.src = audioUrl;
    document.body.append(audio);
  }
  navigator.mediaSession.metadata = new MediaMetadata({ title: meta.title, artist: meta.artist, album: meta.album });
  if (active) {
    try {
      await audio.play();
      results.mediaSession = 'играет тишина, карточка может быть на блокировке';
    } catch (error) {
      results.mediaSession = `метаданные заданы, звук не стартовал: ${error.message}`;
    }
  } else {
    audio.pause();
    results.mediaSession = 'карточка снята';
  }
  if (mediaBound) return;
  mediaBound = true;
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, () => fn()); } catch { /* действие не поддерживается */ }
  }
}

export function setPlaybackState(playing) {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

function urlBase64ToBuffer(value) {
  const padded = value + '='.repeat((4 - value.length % 4) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
