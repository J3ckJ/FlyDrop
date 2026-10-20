const preview = document.getElementById('preview');
const detail = document.getElementById('detail');
const presence = document.getElementById('presence');
window.flydropTray?.onPreview(data => {
  preview.firstChild.textContent = data.preview || 'Буфер пуст';
  detail.textContent = data.detail || '';
  presence.textContent = data.online ? '● iPhone на связи' : '● ждём iPhone';
  presence.style.color = data.online ? '#30d158' : '#ff9f0a';
});
document.getElementById('send').addEventListener('click', () => window.flydropTray?.send());
document.getElementById('open').addEventListener('click', () => window.flydropTray?.open());
document.getElementById('browser').addEventListener('click', () => window.flydropTray?.browser());
document.getElementById('quit').addEventListener('click', () => window.flydropTray?.quit());
