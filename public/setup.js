import { detectLanguage, translate, applyDocument } from './i18n.js';

let lang = detectLanguage();
const button = document.getElementById('language-toggle');
function paint() {
  applyDocument(lang);
  document.title = translate(lang, 'setup.title');
  if (!button) return;
  button.textContent = lang === 'en' ? 'RU' : 'EN';
  const label = translate(lang, 'lang.switch');
  button.title = label;
  button.setAttribute('aria-label', label);
  const apple = document.getElementById('apple-help');
  if (apple) apple.href = lang === 'en' ? 'https://support.apple.com/en-us/102390' : 'https://support.apple.com/ru-ru/102390';
}
button?.addEventListener('click', () => {
  lang = lang === 'en' ? 'ru' : 'en';
  try { localStorage.setItem('flydrop-lang', lang); } catch { /* Preference stays for this visit. */ }
  paint();
});
paint();
