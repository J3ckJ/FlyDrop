const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const root = path.join(__dirname, '..');
function polygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function icon(size) {
  const png = new PNG({ width: size, height: size });
  const points = [[.22,.49],[.79,.22],[.59,.79],[.46,.57]];
  const stripe = [[.455,.57],[.665,.37],[.69,.395],[.48,.602]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let white = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
      const px = (x + (sx + .5) / 3) / size, py = (y + (sy + .5) / 3) / size;
      if (polygon(px, py, points) && !polygon(px, py, stripe)) white++;
    }
    const ratio = white / 9, index = (y * size + x) * 4;
    [36,100,73].forEach((v, channel) => { png.data[index + channel] = Math.round(v + (255 - v) * ratio); }); png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}
fs.mkdirSync(path.join(root, 'public', 'icons'), { recursive: true });
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
for (const [name, size] of [['icon-192',192],['icon-512',512],['apple-touch-icon',180]]) fs.writeFileSync(path.join(root,'public','icons',`${name}.png`), icon(size));
const image = icon(256), header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(image.length, 14); header.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(root,'build','icon.ico'), Buffer.concat([header,image]));
fs.writeFileSync(path.join(root,'build','tray.png'), icon(64));
console.log('PWA and Windows icons generated');
