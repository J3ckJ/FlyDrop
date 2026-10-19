export function plainIP(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function isLoopback(ip) {
  const plain = plainIP(ip);
  if (ip === '::1' || plain === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain);
}

export function isPrivateIPv4(ip) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(plainIP(ip));
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some(part => part > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

// Remote control stays on the local network. Loopback is for the same computer and tests.
// Carrier-grade NAT (100.64/10) and public addresses are rejected so a tunnel is not enough.
export function isAllowedPeer(ip, { allowLoopback = true } = {}) {
  if (isPrivateIPv4(ip)) return true;
  if (allowLoopback && isLoopback(ip)) return true;
  return false;
}
