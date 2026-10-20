import path from 'node:path';

const GAP = 3 * 60 * 60 * 1000;
const DISTANCE = 500;

export function safeSegment(value, fallback = 'файл') {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return Array.from(cleaned).slice(0, 80).join('') || fallback;
}

export function calendarDay(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return calendarDay(Date.now());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

function haversine(a, b) {
  if (![a?.lat, a?.lon, b?.lat, b?.lon].every(Number.isFinite)) return 0;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function clusterEvents(files, { gap = GAP, distance = DISTANCE } = {}) {
  const sorted = [...files].sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0) || String(a.name).localeCompare(String(b.name)));
  const groups = [];
  for (const file of sorted) {
    const group = groups.at(-1);
    const prev = group?.files.at(-1);
    const split = !prev || (file.takenAt || 0) - (prev.takenAt || 0) > gap || haversine(prev, file) > distance;
    if (split) groups.push({ name: file.eventName || '', files: [file] });
    else {
      group.files.push(file);
      if (!group.name && file.eventName) group.name = file.eventName;
    }
  }
  return groups;
}

const BUCKETS = { original: 'Оригиналы', jpg: 'JPG', proxy: 'Proxy' };

export function destination({ root, takenAt, calendar, eventName, bucket = 'original', filename }) {
  const day = calendarDay(calendar || takenAt);
  const year = day.slice(0, 4);
  const title = safeSegment(eventName || '', '');
  const folder = title ? `${day} ${title}` : day;
  const leaf = safeSegment(filename);
  const parts = [year, folder, BUCKETS[bucket] || BUCKETS.original, leaf];
  return { year, folder, bucket: BUCKETS[bucket] || BUCKETS.original, parts, absolute: path.join(root, ...parts), relative: parts.join(path.sep) };
}

export function insideRoot(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}
