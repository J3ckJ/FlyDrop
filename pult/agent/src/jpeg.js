// Baseline JPEG (ITU-T T.81), 4:4:4, quality scaled from the standard tables.
// Used when the platform has no native capture. Windows and macOS still save real screenshots.

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const BASE_Y = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const BASE_C = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

const DC_LUM_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUM_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHR_COUNTS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHR_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUM_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUM_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];
const AC_CHR_COUNTS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHR_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

function buildHuffman(counts, values) {
  const table = new Map();
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length - 1]; i++) {
      table.set(values[index], { code, length });
      code += 1;
      index += 1;
    }
    code <<= 1;
  }
  if (index !== values.length) throw new Error('Huffman table does not match its counts');
  return table;
}

const DC_Y = buildHuffman(DC_LUM_COUNTS, DC_LUM_VALUES);
const DC_C = buildHuffman(DC_CHR_COUNTS, DC_CHR_VALUES);
const AC_Y = buildHuffman(AC_LUM_COUNTS, AC_LUM_VALUES);
const AC_C = buildHuffman(AC_CHR_COUNTS, AC_CHR_VALUES);

function scaleQuant(base, quality) {
  const q = Math.min(95, Math.max(1, quality | 0));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return base.map(value => Math.min(255, Math.max(1, Math.floor((value * scale + 50) / 100))));
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.bits = 0;
  }
  write(code, length) {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      this.bits += 1;
      if (this.bits === 8) this.flushByte();
    }
  }
  flushByte() {
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0x00);
    this.acc = 0;
    this.bits = 0;
  }
  finish() {
    if (this.bits > 0) {
      this.acc = (this.acc << (8 - this.bits)) | ((1 << (8 - this.bits)) - 1);
      this.flushByte();
    }
    return Buffer.from(this.bytes);
  }
}

function category(value) {
  if (value === 0) return { bits: 0, magnitude: 0 };
  const abs = Math.abs(value);
  let bits = 0;
  while ((1 << bits) <= abs) bits += 1;
  const magnitude = value < 0 ? value + ((1 << bits) - 1) : value;
  return { bits, magnitude };
}

function dctBlock(samples) {
  const out = new Float64Array(64);
  for (let v = 0; v < 8; v++) {
    const cv = v === 0 ? 1 / Math.SQRT2 : 1;
    for (let u = 0; u < 8; u++) {
      const cu = u === 0 ? 1 / Math.SQRT2 : 1;
      let sum = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          sum += samples[y * 8 + x]
            * Math.cos(((2 * x + 1) * u * Math.PI) / 16)
            * Math.cos(((2 * y + 1) * v * Math.PI) / 16);
        }
      }
      out[v * 8 + u] = 0.25 * cu * cv * sum;
    }
  }
  return out;
}

function encodeBlock(writer, samples, quant, dcTable, acTable, prevDc) {
  const freq = dctBlock(samples);
  const zz = new Array(64);
  for (let i = 0; i < 64; i++) zz[i] = Math.round(freq[ZIGZAG[i]] / quant[ZIGZAG[i]]);
  const diff = zz[0] - prevDc;
  const dc = category(diff);
  const dcCode = dcTable.get(dc.bits);
  writer.write(dcCode.code, dcCode.length);
  if (dc.bits) writer.write(dc.magnitude, dc.bits);
  let run = 0;
  for (let i = 1; i < 64; i++) {
    if (zz[i] === 0) {
      run += 1;
      continue;
    }
    while (run > 15) {
      const zrl = acTable.get(0xf0);
      writer.write(zrl.code, zrl.length);
      run -= 16;
    }
    const ac = category(zz[i]);
    const symbol = (run << 4) | ac.bits;
    const code = acTable.get(symbol);
    if (!code) throw new Error(`Missing AC Huffman symbol ${symbol.toString(16)}`);
    writer.write(code.code, code.length);
    writer.write(ac.magnitude, ac.bits);
    run = 0;
  }
  if (run > 0) {
    const eob = acTable.get(0x00);
    writer.write(eob.code, eob.length);
  }
  return zz[0];
}

function marker(bytes, markerByte, payload = Buffer.alloc(0)) {
  bytes.push(0xff, markerByte);
  if (payload.length) {
    const length = payload.length + 2;
    bytes.push((length >> 8) & 0xff, length & 0xff);
    for (const byte of payload) bytes.push(byte);
  }
}

function quantTable(id, values) {
  const payload = Buffer.alloc(65);
  payload[0] = id;
  for (let i = 0; i < 64; i++) payload[1 + i] = values[ZIGZAG[i]];
  return payload;
}

function huffmanTable(classId, id, counts, values) {
  const payload = Buffer.alloc(1 + 16 + values.length);
  payload[0] = (classId << 4) | id;
  counts.forEach((count, index) => { payload[1 + index] = count; });
  values.forEach((value, index) => { payload[17 + index] = value; });
  return payload;
}

export function encodeJPEG(rgba, width, height, quality = 70) {
  if (!Buffer.isBuffer(rgba) || rgba.length < width * height * 4) throw new Error('Некорректное изображение');
  if (width < 1 || height < 1 || width > 1920 || height > 1080) throw new Error('Слишком большой кадр');
  const padW = Math.ceil(width / 8) * 8;
  const padH = Math.ceil(height / 8) * 8;
  const qy = scaleQuant(BASE_Y, quality);
  const qc = scaleQuant(BASE_C, quality);
  const yPlane = new Int16Array(padW * padH);
  const cbPlane = new Int16Array(padW * padH);
  const crPlane = new Int16Array(padW * padH);
  for (let y = 0; y < padH; y++) {
    const sy = Math.min(y, height - 1);
    for (let x = 0; x < padW; x++) {
      const sx = Math.min(x, width - 1);
      const i = (sy * width + sx) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const o = y * padW + x;
      yPlane[o] = Math.round(0.299 * r + 0.587 * g + 0.114 * b) - 128;
      cbPlane[o] = Math.round(-0.168736 * r - 0.331264 * g + 0.5 * b);
      crPlane[o] = Math.round(0.5 * r - 0.418688 * g - 0.081312 * b);
    }
  }
  const writer = new BitWriter();
  let dy = 0;
  let dcb = 0;
  let dcr = 0;
  const block = new Float64Array(64);
  for (let by = 0; by < padH; by += 8) {
    for (let bx = 0; bx < padW; bx += 8) {
      for (let i = 0; i < 64; i++) block[i] = yPlane[(by + (i >> 3)) * padW + bx + (i & 7)];
      dy = encodeBlock(writer, block, qy, DC_Y, AC_Y, dy);
      for (let i = 0; i < 64; i++) block[i] = cbPlane[(by + (i >> 3)) * padW + bx + (i & 7)];
      dcb = encodeBlock(writer, block, qc, DC_C, AC_C, dcb);
      for (let i = 0; i < 64; i++) block[i] = crPlane[(by + (i >> 3)) * padW + bx + (i & 7)];
      dcr = encodeBlock(writer, block, qc, DC_C, AC_C, dcr);
    }
  }
  const scan = writer.finish();
  const bytes = [0xff, 0xd8];
  marker(bytes, 0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  marker(bytes, 0xdb, quantTable(0, qy));
  marker(bytes, 0xdb, quantTable(1, qc));
  const sof = Buffer.alloc(17);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  sof[6] = 1; sof[7] = 0x11; sof[8] = 0;
  sof[9] = 2; sof[10] = 0x11; sof[11] = 1;
  sof[12] = 3; sof[13] = 0x11; sof[14] = 1;
  sof[15] = 0; sof[16] = 0;
  // SOF is 8 + height + width + 3 components * 3 + component count already in the 17? 
  // Layout: P(1) Y(2) X(2) Nf(1) then Nf*(id, sampling, tq) = 1+2+2+1+9 = 15. I allocated 17.
  marker(bytes, 0xc0, sof.subarray(0, 15));
  marker(bytes, 0xc4, huffmanTable(0, 0, DC_LUM_COUNTS, DC_LUM_VALUES));
  marker(bytes, 0xc4, huffmanTable(1, 0, AC_LUM_COUNTS, AC_LUM_VALUES));
  marker(bytes, 0xc4, huffmanTable(0, 1, DC_CHR_COUNTS, DC_CHR_VALUES));
  marker(bytes, 0xc4, huffmanTable(1, 1, AC_CHR_COUNTS, AC_CHR_VALUES));
  const sos = Buffer.from([
    3,
    1, 0x00,
    2, 0x11,
    3, 0x11,
    0, 63, 0,
  ]);
  marker(bytes, 0xda, sos);
  const header = Buffer.from(bytes);
  return Buffer.concat([header, scan, Buffer.from([0xff, 0xd9])]);
}

export function encodeFrame(jpeg, { seq, width, height }) {
  const header = Buffer.from(JSON.stringify({ seq, width, height }));
  if (header.length > 65535) throw new Error('Слишком большой заголовок кадра');
  const out = Buffer.alloc(3 + header.length + jpeg.length);
  out[0] = 0x01;
  out.writeUInt16BE(header.length, 1);
  header.copy(out, 3);
  jpeg.copy(out, 3 + header.length);
  return out;
}

export function decodeFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer[0] !== 0x01) throw new Error('Некорректный кадр');
  const length = buffer.readUInt16BE(1);
  if (3 + length > buffer.length) throw new Error('Кадр обрезан');
  const meta = JSON.parse(buffer.subarray(3, 3 + length).toString('utf8'));
  return { ...meta, jpeg: buffer.subarray(3 + length) };
}
