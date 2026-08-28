/**
 * Rebuilds public/img/{logo,logo-mark,favicon}.png from assets/logo-source.png.
 *
 *   node scripts/build-logo-assets.js
 *
 * The source art is a painted head on a solid black square. Shipping it as-is
 * would put a black tile in the header, so this cuts the square away and
 * leaves the head with its green halo on transparency. It only needs running
 * when the artwork itself changes; the outputs are committed.
 *
 * pngjs is a transitive dependency rather than a declared one. If npm ever
 * hoists it out, `npm i -D pngjs` and this keeps working — nothing that runs
 * in production imports this file.
 */
const fs = require('fs');
const { PNG } = require('pngjs');

const SRC = require('path').join(__dirname, '..', 'assets', 'logo-source.png');
const OUT = require('path').join(__dirname, '..', 'public', 'img') + '/';

const src = PNG.sync.read(fs.readFileSync(SRC));
const W = src.width, H = src.height, D = src.data;
const lum = (i) => 0.299 * D[i] + 0.587 * D[i + 1] + 0.114 * D[i + 2];

// Flood-fill the black field in from every border pixel. Only the outer black
// field is connected to the edge; the black strokes inside the drawing are
// ringed by the green glow, so they survive.
const removed = new Uint8Array(W * H);
const stack = [];
const push = (x, y) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const p = y * W + x;
  if (removed[p]) return;
  const i = p << 2;
  if (D[i + 3] < 12) { removed[p] = 1; return; }   // already transparent margin
  if (lum(i) > 50) return;                          // not the black field
  removed[p] = 1;
  stack.push(p);
};
for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
while (stack.length) {
  const p = stack.pop(), x = p % W, y = (p - x) / W;
  push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
}

// Feather: a pixel left standing but touching the cut, and still dark, is the
// antialiased rim of the field rather than part of the art. Fade it out by how
// dark it is instead of leaving a hard black fringe on the glow.
const alpha = new Uint8Array(W * H).fill(255);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const p = y * W + x;
  if (removed[p]) { alpha[p] = 0; continue; }
  const touches = (x > 0 && removed[p - 1]) || (x < W - 1 && removed[p + 1]) ||
                  (y > 0 && removed[p - W]) || (y < H - 1 && removed[p + W]);
  if (!touches) continue;
  const l = lum(p << 2);
  if (l < 110) alpha[p] = Math.round(Math.max(0, (l - 30) / 80) * 255);
}
for (let p = 0; p < W * H; p++) {
  const i = p << 2;
  D[i + 3] = Math.min(D[i + 3], alpha[p]);
}

// Bounding box of what is left.
let x0 = W, y0 = H, x1 = -1, y1 = -1;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (D[((y * W + x) << 2) + 3] < 8) continue;
  if (x < x0) x0 = x; if (x > x1) x1 = x;
  if (y < y0) y0 = y; if (y > y1) y1 = y;
}
console.log('art bbox', x0, y0, x1, y1, 'w', x1 - x0 + 1, 'h', y1 - y0 + 1);

// Box-average downscale of an arbitrary source rect into a w×h PNG.
function resample(sx, sy, sw, sh, w, h) {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ax = sx + (x * sw) / w, bx = sx + ((x + 1) * sw) / w;
    const ay = sy + (y * sh) / h, by = sy + ((y + 1) * sh) / h;
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let py = Math.floor(ay); py < Math.ceil(by); py++)
      for (let px = Math.floor(ax); px < Math.ceil(bx); px++) {
        if (px < 0 || py < 0 || px >= W || py >= H) { n++; continue; }
        const i = (py * W + px) << 2, al = D[i + 3] / 255;
        r += D[i] * al; g += D[i + 1] * al; b += D[i + 2] * al; a += D[i + 3]; n++;
      }
    const o = (y * w + x) << 2;
    const al = a / n / 255;
    out.data[o]     = al > 0 ? Math.round(r / n / al) : 0;
    out.data[o + 1] = al > 0 ? Math.round(g / n / al) : 0;
    out.data[o + 2] = al > 0 ? Math.round(b / n / al) : 0;
    out.data[o + 3] = Math.round(a / n);
  }
  return out;
}

const aw = x1 - x0 + 1, ah = y1 - y0 + 1;
// Square frame around the art, so every square output keeps the same crop.
const side = Math.max(aw, ah);
const qx = x0 - ((side - aw) >> 1), qy = y0 - ((side - ah) >> 1);

const write = (name, png) => {
  fs.writeFileSync(OUT + name, PNG.sync.write(png));
  console.log(name, png.width + 'x' + png.height, fs.statSync(OUT + name).size);
};

// The two square marks keep their transparency: they land on the site's own
// black, and a baked-in tile would fight the page's rounded corners.
write('logo-mark.png', resample(qx, qy, side, side, 512, 512));
write('favicon.png', resample(qx, qy, side, side, 96, 96));

/* The share card is the one output that must NOT be transparent. It is
   consumed by Messenger, Facebook and iMessage, which composite an
   unfurled image onto whatever their own bubble is — usually white, where a
   green halo cut from black looks like a printing error. So the head goes
   back onto the black it was painted on, centred in the 1.91:1 frame every
   one of those clients crops to. */
function shareCard(w, h) {
  const out = new PNG({ width: w, height: h });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 0x0b; out.data[i + 1] = 0x0d;
    out.data[i + 2] = 0x0b; out.data[i + 3] = 255;
  }
  const artH = Math.round(h * 0.82), artW = Math.round((artH * aw) / ah);
  const art = resample(x0, y0, aw, ah, artW, artH);
  const ox = (w - artW) >> 1, oy = (h - artH) >> 1;
  for (let y = 0; y < artH; y++) for (let x = 0; x < artW; x++) {
    const s = (y * artW + x) << 2, al = art.data[s + 3] / 255;
    if (!al) continue;
    const d = ((y + oy) * w + (x + ox)) << 2;
    for (let c = 0; c < 3; c++) {
      out.data[d + c] = Math.round(art.data[s + c] * al + out.data[d + c] * (1 - al));
    }
  }
  return out;
}
write('logo.png', shareCard(1200, 630));
