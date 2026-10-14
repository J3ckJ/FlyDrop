const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, clipboard, Notification, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { saveIncoming } = require('./files.cjs');
const { createClipboardActions, readClipboard } = require('./clipboard.cjs');
const { zipDirectory } = require('./zip.cjs');
const smoke = process.argv.includes('--smoke-test');
const smokeProfile = smoke ? require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'flydrop-smoke-profile-')) : null;
if (smokeProfile) app.setPath('userData', smokeProfile);
let window, tray, service, quitting = false, shortcuts = false, stagedFiles = [], transferActive = false, transferCancel = () => {}, uiLang = 'ru', presence = { names: [], uploading: false };
let origin;
function post(channel, ...args) { if (window && !window.isDestroyed()) window.webContents.send(channel, ...args); }
function stageFiles(files) {
  if (transferActive) return false;
  stagedFiles = files.map(file => ({ id: randomUUID(), path: file.path, name: file.name, size: file.size }));
  post('flydrop:clipboard-files', stagedFiles.map(({ id, name, size }) => ({ id, name, size })));
  return true;
}
async function clipboardItems() {
  const items = await clipboard.read();
  const result = [];
  for (const item of items) {
    const entry = { types: [...item.types] };
    if (item.types.includes('text/uri-list')) { const blob = await item.getType('text/uri-list'); entry.text = () => blob.text(); }
    if (item.types.includes('image/png') || item.types.includes('image/jpeg')) entry.bytes = async type => Buffer.from(await (await item.getType(type)).arrayBuffer());
    if (entry.text || entry.bytes) result.push(entry);
  }
  return result;
}
async function clipboardDir() {
  const dir = path.join(service.directory, 'clipboard');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
async function writeUnique(dir, name, bytes) {
  const ext = path.extname(name), stem = path.basename(name, ext);
  for (let index = 0; index < 50; index++) {
    const filename = index ? `${stem} (${index})${ext}` : name, filePath = path.join(dir, filename);
    try { await fs.writeFile(filePath, bytes, { mode: 0o600, flag: 'wx' }); return { path: filePath, name: filename, size: bytes.length }; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Не удалось прочитать файл из буфера. Скопируйте его ещё раз');
}
async function packFolder(folder) {
  const dir = await clipboardDir();
  const base = path.basename(folder).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '') || 'folder';
  for (let index = 0; index < 50; index++) {
    const filename = index ? `${base} (${index}).zip` : `${base}.zip`;
    try {
      const packed = await zipDirectory(folder, path.join(dir, filename));
      if (packed.size > 1024 ** 3) { await fs.rm(packed.path, { force: true }); const error = new Error('Папка больше 1 ГБ. Она не отправлена'); error.code = 'LIMIT_BYTES'; throw error; }
      return packed;
    }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Не удалось упаковать папку из буфера');
}
async function materializeClipboard(value) {
  if (value?.kind !== 'image') return value;
  const stamp = new Date(), pad = n => String(n).padStart(2, '0');
  const ext = value.type === 'image/jpeg' ? 'jpg' : 'png';
  const name = `FlyDrop-screenshot-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.${ext}`;
  const file = await writeUnique(await clipboardDir(), name, value.bytes);
  return { kind: 'files', files: [file], folders: 0, oversized: 0, zipped: 0 };
}
app.enableSandbox();
app.setAppUserModelId('local.flydrop.windows');
if (!smoke && !app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => show());
  app.whenReady().then(start).catch(error => {
    if (smoke) { console.error(error.message); app.exit(1); }
    else { dialog.showErrorBox('FlyDrop не удалось запустить', `${error.message}\nЕсли открыт старый сервер FlyDrop, завершите его и повторите запуск.`); app.exit(1); }
  });
}
function show() { if (!window) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
function message(text) { if (window && !window.isDestroyed()) window.webContents.send('flydrop:message', text); }
function notify(title, body) {
  if (!service?.vault.settings.notifications || smoke || !Notification.isSupported()) return;
  const notification = new Notification({ title, body, icon: path.join(app.getAppPath(), 'build', 'tray.png') }); notification.on('click', show); notification.show();
}
const { compose, quickSend } = createClipboardActions({
  read: async () => materializeClipboard(await readClipboard({ readItems: clipboardItems, readText: () => clipboard.readText(), zipFolder: packFolder })),
  show, message, notify, language: () => uiLang,
  fillText: text => { if (transferActive) return false; stagedFiles = []; post('flydrop:clipboard', text); return true; },
  stageFiles,
  sendText: text => service.sendClipboard(text),
  sendFiles: async files => {
    if (transferActive) throw new Error('Передача уже идёт');
    transferActive = true;
    const controller = new AbortController();
    transferCancel = () => controller.abort();
    post('flydrop:transfer-lock', true);
    try { return await service.sendLocalFiles(service.vault.settings.lastRecipient, files.map(file => file.path), progress => post('flydrop:progress', progress), controller.signal); }
    finally { transferActive = false; transferCancel = () => {}; post('flydrop:transfer-lock', false); }
  },
});
async function saveReceived(item) {
  try {
    const file = await service.incomingFile(item.id);
    const saved = await saveIncoming(file.path, file.name, service.vault.settings.downloadsFolder);
    message(uiLang === 'en' ? `Saved: ${saved.name}` : `Сохранено: ${saved.name}`);
  } catch { message(uiLang === 'en' ? 'Could not save the incoming file' : 'Не удалось сохранить входящий файл'); }
}
function trayTip() {
  const en = uiLang === 'en';
  if (transferActive || presence.uploading) return en ? 'FlyDrop — sending…' : 'FlyDrop — передача…';
  if (!presence.names.length) return en ? 'FlyDrop — waiting for a device' : 'FlyDrop — ждём устройство';
  return `FlyDrop — ${presence.names.join(', ')} ${en ? 'connected' : 'на связи'}`.slice(0, 120);
}
function refreshTray() {
  if (!tray) return;
  const en = uiLang === 'en';
  tray.setToolTip(trayTip());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: en ? 'Open FlyDrop' : 'Открыть FlyDrop', click: show },
    { label: en ? 'Open in browser' : 'Открыть в браузере', click: () => shell.openExternal(service.browserLink()) },
    { label: en ? 'From clipboard — Ctrl+Shift+Space' : 'Из буфера — Ctrl+Shift+Space', click: compose },
    { label: en ? 'Send clipboard to the selected recipient' : 'Отправить буфер выбранному получателю', click: quickSend },
    { type: 'separator' },
    { label: en ? 'Quit' : 'Выход', click: () => app.quit() },
  ]));
}
function externalPage(url) {
  if (url === `${origin}/setup`) return url;
  try {
    const target = new URL(url);
    if (target.protocol === 'https:' && ['www.threads.net', 'threads.net', 't.me', 'github.com'].includes(target.hostname)) return target.href;
  } catch { /* Keep navigation inside the app. */ }
  return '';
}
function authorized(event) {
  const url = new URL(event.senderFrame.url);
  if (!window || event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame || url.origin !== origin || url.pathname !== '/' || url.search) throw new Error('Недопустимый запрос');
}
function handle(channel, operation) { ipcMain.handle(channel, async (event, ...args) => { authorized(event); return operation(...args); }); }
async function start() {
  const { createApp } = await import(pathToFileURL(path.join(app.getAppPath(), 'server.js')).href);
  const { openVault } = await import(pathToFileURL(path.join(app.getAppPath(), 'security.js')).href);
  let smokeDirectory;
  if (smoke) smokeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'flydrop-desktop-smoke-'));
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Недоступна защита ключей Windows. FlyDrop не будет сохранять их открытым текстом');
  const encryption = { encrypt: value => safeStorage.encryptString(Buffer.from(value).toString('utf8')), decrypt: value => Buffer.from(safeStorage.decryptString(Buffer.from(value)), 'utf8') };
  const storeDirectory = smokeDirectory || path.join(process.env.APPDATA || app.getPath('userData'), 'FlyDrop', 'security');
  const store = await openVault(storeDirectory, encryption);
  service = await createApp({ port: smoke ? 0 : 4317, securePort: smoke ? 0 : 4318, vaultStore: store,
    onReceived: item => { notify(uiLang === 'en' ? 'New in FlyDrop' : 'Новое в FlyDrop', item.kind === 'file' ? (uiLang === 'en' ? `File from ${item.from}` : `Файл от ${item.from}`) : (uiLang === 'en' ? `Text from ${item.from}` : `Текст от ${item.from}`)); if (item.kind === 'file' && service.vault.settings.autoSave === true) void saveReceived(item); },
    onPresence: next => { presence = next || presence; if (tray) tray.setToolTip(trayTip()); },
    onPairing: request => { notify('Запрос подключения', `${request.name}. Сверьте код в FlyDrop`); if (!smoke) show(); },
  });
  origin = `http://127.0.0.1:${service.port}`;
  if (!service.vault.settings.downloadsFolder) { service.vault.settings.downloadsFolder = path.join(app.getPath('downloads'), 'FlyDrop'); await store.save(); }
  window = new BrowserWindow({ width: 1280, height: 920, minWidth: 820, minHeight: 640, show: false, title: 'FlyDrop', icon: path.join(app.getAppPath(), 'build', 'icon.ico'), autoHideMenuBar: true, backgroundColor: '#f7f8f5', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, ...(smoke ? { partition: 'flydrop-smoke' } : {}) } });
  window.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => callback(details.requestingUrl?.startsWith(`${origin}/`) && ['clipboard-read', 'clipboard-sanitized-write'].includes(permission)));
  window.webContents.session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => requestingOrigin === origin && ['clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  window.webContents.session.webRequest.onBeforeSendHeaders({ urls: [`${origin}/api/connect`] }, (details, callback) => {
    const headers = { ...details.requestHeaders };
    if (details.webContentsId === window.webContents.id) headers['X-FlyDrop-Desktop'] = service.desktopKey;
    callback({ requestHeaders: headers });
  });
  window.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== `${origin}/`) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({ url }) => { const page = externalPage(url); if (page) void shell.openExternal(page); return { action: 'deny' }; });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => { if (!quitting && !smoke) { event.preventDefault(); window.hide(); } });
  const startupPath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  handle('flydrop:settings', () => ({ downloadsFolder: service.vault.settings.downloadsFolder, launchAtLogin: app.isPackaged && app.getLoginItemSettings({ path: startupPath, args: ['--hidden'] }).openAtLogin, shortcuts }));
  handle('flydrop:choose-folder', async () => {
    const selection = await dialog.showOpenDialog(window, { title: 'Папка для входящих FlyDrop', defaultPath: service.vault.settings.downloadsFolder, properties: ['openDirectory', 'createDirectory'] });
    if (!selection.canceled && selection.filePaths[0]) { service.vault.settings.downloadsFolder = path.resolve(selection.filePaths[0]); await store.save(); }
    return { downloadsFolder: service.vault.settings.downloadsFolder };
  });
  handle('flydrop:autostart', async enabled => {
    if (typeof enabled !== 'boolean') throw new Error('Некорректная настройка');
    if (!app.isPackaged) throw new Error('Автозапуск доступен в собранном .exe');
    const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({ openAtLogin: enabled, path: executable, args: ['--hidden'] });
    service.vault.settings.launchAtLogin = enabled; await store.save(); return enabled;
  });
  handle('flydrop:save-file', async id => { if (typeof id !== 'string' || !/^[\da-f-]{36}$/.test(id)) throw new Error('Некорректный файл'); const file = await service.incomingFile(id); return saveIncoming(file.path, file.name, service.vault.settings.downloadsFolder); });
  handle('flydrop:send-staged', async (recipient, id) => {
    if (typeof recipient !== 'string' || typeof id !== 'string' || !/^[\da-f-]{36}$/.test(id)) throw new Error('Некорректный файл');
    const file = stagedFiles.find(item => item.id === id);
    if (!file) throw new Error('Файл из буфера устарел. Скопируйте его ещё раз');
    if (transferActive) throw new Error('Передача уже идёт');
    transferActive = true;
    const controller = new AbortController();
    transferCancel = () => controller.abort();
    try {
      const [item] = await service.sendLocalFiles(recipient, [file.path], progress => post('flydrop:progress', progress), controller.signal);
      stagedFiles = stagedFiles.filter(item => item.id !== id);
      return item;
    } finally { transferActive = false; transferCancel = () => {}; }
  });
  handle('flydrop:cancel-transfer', () => { transferCancel(); });
  handle('flydrop:language', lang => { uiLang = lang === 'en' ? 'en' : 'ru'; refreshTray(); return uiLang; });
  if (!smoke) {
    const composeRegistered = globalShortcut.register('CommandOrControl+Shift+Space', compose), sendRegistered = globalShortcut.register('CommandOrControl+Shift+Enter', quickSend); shortcuts = composeRegistered && sendRegistered;
  }
  await window.loadURL(`${origin}/`);
  if (smoke) {
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{if(!document.getElementById('app').hidden && document.getElementById('loading').hidden){clearInterval(t);resolve(true)}else if(++n>100){clearInterval(t);reject(new Error('UI did not authenticate'))}},100)})`);
    const assertions = await window.webContents.executeJavaScript(`({nodeAbsent:typeof require==='undefined',nativeBridge:typeof window.flydropDesktop.saveFile==='function',noSelfRecipient:[...document.querySelectorAll('#recipient option')].every(o=>!o.textContent.includes('Windows')),csp:!document.querySelector('script:not([src])')})`);
    if (!Object.values(assertions).every(Boolean)) throw new Error(`Desktop security check failed: ${JSON.stringify(assertions)}`);
    await window.webContents.executeJavaScript(`window.flydropDesktop.settings()`);
    await window.webContents.executeJavaScript(`location.hash='security'; true`);
    await window.webContents.executeJavaScript(`window.flydropDesktop.settings()`);
    assertions.ipcAfterFragment = true;
    assertions.nativeClipboardApi = typeof (await clipboard.readText()) === 'string';
    const clipboardMessages = [];
    const clipboardProbe = createClipboardActions({
      read: async () => ({ kind: 'text', text: 'FlyDrop clipboard smoke' }), show: () => {},
      fillText: text => window.webContents.send('flydrop:clipboard', text), stageFiles: () => {},
      sendText: text => service.sendClipboard(text), sendFiles: async () => { throw new Error('В smoke-проверке нет файла для отправки'); },
      message: text => clipboardMessages.push(text),
      notify: () => { throw new Error('Clipboard must not report a delivery without a recipient'); },
    });
    await clipboardProbe.compose();
    assertions.clipboardCompose = await window.webContents.executeJavaScript(`new Promise(resolve=>{let n=0;const t=setInterval(()=>{if(document.getElementById('text-input').value==='FlyDrop clipboard smoke' && !document.getElementById('text-panel').hidden){clearInterval(t);resolve(true)}else if(++n>50){clearInterval(t);resolve(false)}},100)})`);
    await clipboardProbe.quickSend();
    assertions.clipboardQuickSend = clipboardMessages.length === 1 && !clipboardMessages[0].startsWith('Буфер отправлен:');
    if (!assertions.nativeClipboardApi || !assertions.clipboardCompose || !assertions.clipboardQuickSend) throw new Error('Clipboard shortcuts verification failed');
    const clipFile = path.join(smokeDirectory, 'from-clipboard.txt');
    await fs.writeFile(clipFile, 'from-clipboard');
    if (stageFiles([{ path: clipFile, name: 'from-clipboard.txt', size: 14 }]) !== true) throw new Error('Clipboard file was not staged');
    assertions.clipboardFileStaged = await window.webContents.executeJavaScript(`new Promise(resolve=>{let n=0;const t=setInterval(()=>{const name=document.querySelector('#selected-files strong'); if(name && name.textContent==='from-clipboard.txt' && !document.getElementById('file-panel').hidden){clearInterval(t);resolve(true)} else if(++n>50){clearInterval(t);resolve(false)}},100)})`);
    assertions.clipboardFileNeedsRecipient = await window.webContents.executeJavaScript(`window.flydropDesktop.sendStagedFile('', ${JSON.stringify(stagedFiles[0].id)}).then(()=>false, error => /получател/i.test(error.message))`);
    if (!assertions.clipboardFileStaged || !assertions.clipboardFileNeedsRecipient) throw new Error('Clipboard file shortcuts verification failed');
    assertions.ipcRejectsBadFile = await window.webContents.executeJavaScript(`window.flydropDesktop.saveFile('../../outside').then(()=>false,()=>true)`);
    const encrypted = await fs.readFile(path.join(storeDirectory, 'vault.safe'));
    assertions.encryptedVault = !encrypted.includes(Buffer.from('PRIVATE KEY')) && !encrypted.includes(Buffer.from(service.vault.issuer.key));
    assertions.vaultRoundtrip = (await openVault(storeDirectory, encryption)).value.hostId === service.vault.hostId;
    if (!assertions.encryptedVault || !assertions.vaultRoundtrip || !assertions.ipcRejectsBadFile) throw new Error('Native verification failed');
    await window.webContents.executeJavaScript(`Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('PWA worker did not install')),8000))])`);
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{if(navigator.serviceWorker.controller){clearInterval(t);resolve(true)}else if(++n>50){clearInterval(t);reject(new Error('PWA worker did not activate'))}},100)})`);
    assertions.noPrivateCache = await window.webContents.executeJavaScript(`(async()=>{const names=await caches.keys();for(const name of names){const cache=await caches.open(name);for(const request of await cache.keys()){const p=new URL(request.url).pathname;if(p.startsWith('/api/')||p.includes('certificate')||p.includes('ca.cer'))return false}}return names.some(n=>n.startsWith('flydrop-shell-'))})()`);
    await service.close();
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{if(!document.getElementById('gate').hidden){clearInterval(t);resolve(true)}else if(++n>50){clearInterval(t);reject(new Error('Offline PWA did not load'))}},100)})`);
    assertions.offlineShell = await window.webContents.executeJavaScript(`document.getElementById('gate-message').textContent.includes('Нет связи')`);
    if (!assertions.noPrivateCache || !assertions.offlineShell) throw new Error('PWA verification failed');
    if (!app.isPackaged) await fs.writeFile(path.join(app.getAppPath(), 'artifacts', 'desktop-smoke.json'), JSON.stringify(assertions, null, 2));
    console.log('Desktop smoke passed:', JSON.stringify(assertions));
    quitting = true; window.destroy(); await service.close(); await fs.rm(smokeDirectory, { recursive: true, force: true }); app.exit(0); return;
  }
  tray = new Tray(nativeImage.createFromPath(path.join(app.getAppPath(), 'build', 'tray.png'))); refreshTray(); tray.on('double-click', show);
  if (!process.argv.includes('--hidden')) show();
  const capture = process.argv.find(arg => arg.startsWith('--capture-preview='))?.slice('--capture-preview='.length);
  if (capture) {
    await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{if(!document.getElementById('app').hidden && document.getElementById('loading').hidden){clearInterval(t);requestAnimationFrame(()=>requestAnimationFrame(resolve))}else if(++n>100){clearInterval(t);reject(new Error('Preview did not load'))}},100)})`);
    await fs.writeFile(path.resolve(capture), (await window.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 780 })).toPNG());
  }
}
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (quitting || !service) return; event.preventDefault(); quitting = true; globalShortcut.unregisterAll(); tray?.destroy();
  void service.close().then(() => app.exit(0)).catch(() => app.exit(1));
});
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
