import { randomUUID } from 'node:crypto';
import { classifyText, maskText } from './sensitive.js';
import { seal, open } from './box.js';

const HOUR = 3600000;

function fault(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function createHistory({ now = () => Date.now(), ttl = HOUR, sensitiveTtl = 60000, hideSensitive = () => true } = {}) {
  const items = new Map();
  function present(item, at = now()) {
    const hidden = item.sensitive && hideSensitive();
    const left = item.deleteAt ? Math.max(0, item.deleteAt - at) : 0;
    return {
      id: item.id,
      kind: item.kind,
      sensitive: hidden,
      sensitiveKind: hidden ? item.sensitiveKind : '',
      pinned: item.pinned,
      status: item.status,
      direction: item.direction,
      source: item.source,
      name: item.name || '',
      mime: item.mime || '',
      size: item.size || 0,
      title: hidden ? maskText(item.text || item.name, item.sensitiveKind) : (item.kind === 'image' ? item.name : item.text),
      from: item.from || '',
      to: item.to || '',
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      deleteAt: hidden ? item.deleteAt : 0,
      remainingMs: hidden ? left : 0,
      hasPreview: item.kind === 'image' && !hidden,
    };
  }
  function sweep(at = now()) {
    const removed = [];
    for (const [id, item] of items) {
      const masking = item.sensitive && hideSensitive();
      const expiredSensitive = masking && !item.pinned && item.deleteAt && item.deleteAt <= at;
      const expiredPlain = !item.pinned && !masking && item.expiresAt <= at;
      if (expiredSensitive || expiredPlain) { items.delete(id); removed.push(id); }
    }
    return removed;
  }
  return {
    sweep,
    get(id) { return items.get(id) || null; },
    list(at = now()) {
      sweep(at);
      return [...items.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt).map(item => present(item, at));
    },
    raw(id) { return items.get(id) || null; },
    add(input, at = now()) {
      const text = typeof input.text === 'string' ? input.text : '';
      const kind = input.kind === 'image' ? 'image' : classifyText(text).kind === 'link' ? 'link' : (input.kind || 'text');
      const sensed = kind === 'image' || !hideSensitive() ? { sensitive: false, kind: kind === 'link' ? 'link' : 'text' } : classifyText(text);
      if (kind !== 'image' && !text.trim()) throw fault(400, 'В буфере пусто');
      if (text.length > 50000) throw fault(413, 'Текст должен быть короче 50 000 символов');
      const item = {
        id: randomUUID(),
        kind: sensed.kind === 'link' ? 'link' : kind,
        text,
        name: input.name || '',
        mime: input.mime || '',
        size: input.size || Buffer.byteLength(text),
        sensitive: sensed.sensitive,
        sensitiveKind: sensed.kind === 'otp' || sensed.kind === 'password' ? sensed.kind : '',
        pinned: false,
        status: input.status || 'delivered',
        direction: input.direction || 'from-phone',
        source: input.source || 'share',
        from: input.from || '',
        to: input.to || '',
        createdAt: at,
        expiresAt: at + ttl,
        deleteAt: sensed.sensitive ? at + sensitiveTtl : 0,
      };
      items.set(item.id, item);
      return present(item, at);
    },
    pin(id, pinned, at = now()) {
      const item = items.get(id);
      if (!item) throw fault(404, 'Элемент буфера уже исчез');
      item.pinned = Boolean(pinned);
      if (item.pinned) item.deleteAt = 0;
      else if (item.sensitive && hideSensitive()) item.deleteAt = at + sensitiveTtl;
      return present(item, at);
    },
    setStatus(id, status) {
      const item = items.get(id);
      if (!item) throw fault(404, 'Элемент буфера уже исчез');
      item.status = status;
      return present(item);
    },
    reveal(id, at = now()) {
      sweep(at);
      const item = items.get(id);
      if (!item) throw fault(404, 'Элемент уже удалён');
      if (item.kind === 'image') return { mime: item.mime, name: item.name };
      return { text: item.text };
    },
    remove(id) { items.delete(id); },
    exportPersisted(key, at = now()) {
      sweep(at);
      return [...items.values()].filter(item => item.pinned || !item.sensitive).map(item => {
        if (!item.sensitive) return { ...item };
        const copy = { ...item, text: '' };
        copy.sealed = seal(key, item.text);
        return copy;
      });
    },
    importPersisted(rows, key) {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (!row || typeof row.id !== 'string') continue;
        const item = { ...row };
        if (item.sealed) {
          try { item.text = open(key, item.sealed).toString('utf8'); } catch { continue; }
          delete item.sealed;
          item.sensitive = true;
        }
        if (item.sensitive && !item.pinned) continue;
        items.set(item.id, item);
      }
    },
  };
}
