export const CHUNK = 16 * 1024 * 1024;
export const MAX_UNLOAD = 64 * 1024 ** 3;

export function planChunks(size, chunkSize = CHUNK) {
  if (!Number.isSafeInteger(size) || size < 0) {
    const error = new Error('Неизвестен размер файла');
    error.status = 411;
    throw error;
  }
  if (size > MAX_UNLOAD) {
    const error = new Error('Файл больше 64 ГБ');
    error.status = 413;
    throw error;
  }
  const count = size === 0 ? 1 : Math.ceil(size / chunkSize);
  return { size, chunkSize, count };
}

export function chunkBounds(size, index, chunkSize = CHUNK) {
  const { count } = planChunks(size, chunkSize);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    const error = new Error('Нет такой части');
    error.status = 400;
    throw error;
  }
  const start = index * chunkSize;
  const end = Math.min(size, start + chunkSize);
  return { start, end, length: Math.max(0, end - start) };
}

export function createTransfer({ size, chunkSize = CHUNK, received = [] } = {}) {
  const { count } = planChunks(size, chunkSize);
  const got = new Set(received.filter(index => Number.isInteger(index) && index >= 0 && index < count));
  function missing() {
    const holes = [];
    for (let index = 0; index < count; index++) if (!got.has(index)) holes.push(index);
    return holes;
  }
  return {
    count,
    chunkSize,
    size,
    received: () => [...got].sort((a, b) => a - b),
    missing,
    complete: () => got.size === count,
    accept(index, length) {
      const bounds = chunkBounds(size, index, chunkSize);
      if (length !== bounds.length) {
        const error = new Error('Размер части не совпал');
        error.status = 400;
        throw error;
      }
      const fresh = !got.has(index);
      got.add(index);
      return { fresh, done: got.size === count, missing: missing(), bounds };
    },
  };
}
