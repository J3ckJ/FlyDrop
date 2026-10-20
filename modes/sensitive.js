const OTP_LINE = /(?:^|[\s:(])(?:код|code|otp|pin|2fa|пароль подтверждения)(?:\s+(?:из\s+смс|из\s+sms|подтверждения|verification))?[\s:：-]*(\d{4,8})\b/i;
const OTP_CONTEXT = /(?:одноразов|one[- ]time|verification code|код подтверждения|код из смс|код из sms|ваш код|your code|\botp\b|\b2fa\b)/i;
const PASSWORD_LINE = /(?:^|\n)\s*(?:password|passphrase|passwd|pwd|пароль|secret|секрет)\s*[:=]\s*(\S+)/i;
const ONLY_CODE = /^\d{4,8}$/;

export function classifyText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { sensitive: false, kind: 'text', reason: '' };
  if (/^https?:\/\/\S+$/i.test(text)) return { sensitive: false, kind: 'link', reason: '' };
  if (ONLY_CODE.test(text) || OTP_LINE.test(text) || (OTP_CONTEXT.test(text) && /\b\d{4,8}\b/.test(text))) {
    return { sensitive: true, kind: 'otp', reason: 'otp' };
  }
  if (PASSWORD_LINE.test(text)) return { sensitive: true, kind: 'password', reason: 'password' };
  if (!/\s/.test(text) && text.length >= 12 && /[A-Za-z]/.test(text) && /\d/.test(text) && /[^A-Za-z0-9]/.test(text)) {
    return { sensitive: true, kind: 'password', reason: 'token' };
  }
  return { sensitive: false, kind: /https?:\/\//i.test(text) ? 'text' : 'text', reason: '' };
}

export function maskText(text, kind) {
  if (kind === 'otp') return '•••  •••';
  const length = Math.min(12, Math.max(8, String(text || '').trim().length));
  return '•'.repeat(length);
}
