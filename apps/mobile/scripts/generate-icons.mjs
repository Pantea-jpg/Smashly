// Draws the interim app icon and splash image (a wallet on the brand blue) without design tools.
// Replace assets/icon.png and assets/splash-icon.png with the club's own artwork when available
// (1024×1024 PNG; the icon must be square, opaque and without rounded corners — iOS rounds them).
//   node scripts/generate-icons.mjs
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const SIZE = 1024;
const SS = 4; // supersampling for smooth edges
const BLUE = [0x0a, 0x63, 0xd6];
const BLUE_DARK = [0x08, 0x4f, 0xab];
const WHITE = [0xff, 0xff, 0xff];
const TINT = [0xd6, 0xe6, 0xfb];

/** Signed distance to a rounded rectangle (negative inside). */
function roundedRect(px, py, x, y, w, h, r) {
  const cx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const cy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  const outside = Math.hypot(Math.max(cx, 0), Math.max(cy, 0));
  return outside + Math.min(Math.max(cx, cy), 0) - r;
}
const circle = (px, py, x, y, r) => Math.hypot(px - x, py - y) - r;

/** The wallet glyph: shapes painted back to front; returns [rgb, coverage] for a sample. */
function wallet(px, py, colors) {
  const layers = [
    // flap behind the body
    [roundedRect(px, py, 250, 300, 470, 230, 60), colors.flap],
    // body
    [roundedRect(px, py, 212, 380, 600, 380, 72), colors.body],
    // clasp tab
    [roundedRect(px, py, 600, 500, 212, 140, 56), colors.flap],
    // clasp button
    [circle(px, py, 680, 570, 30), colors.button],
  ];
  let rgb = null;
  for (const [d, c] of layers) if (d <= 0) rgb = c;
  return rgb;
}

function render({ background, colors, opaque }) {
  const png = new PNG({ width: SIZE, height: SIZE, colorType: opaque ? 2 : 6 });
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const c = wallet(px, py, colors) ?? background;
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 1;
          }
        }
      }
      const n = SS * SS;
      const i = (y * SIZE + x) * 4;
      png.data[i] = a ? Math.round(r / a) : 0;
      png.data[i + 1] = a ? Math.round(g / a) : 0;
      png.data[i + 2] = a ? Math.round(b / a) : 0;
      png.data[i + 3] = Math.round((a / n) * 255);
    }
  }
  return PNG.sync.write(png, { colorType: opaque ? 2 : 6 });
}

const dir = new URL('../assets/', import.meta.url);
// App icon: opaque blue square with a white wallet (App Store rejects icons with transparency).
writeFileSync(
  new URL('icon.png', dir),
  render({
    background: BLUE,
    colors: { body: WHITE, flap: TINT, button: BLUE_DARK },
    opaque: true,
  }),
);
// Splash: the wallet in brand blue on transparent, centred by expo-splash-screen on white/black.
writeFileSync(
  new URL('splash-icon.png', dir),
  render({
    background: null,
    colors: { body: BLUE, flap: [0x6f, 0xa6, 0xec], button: WHITE },
    opaque: false,
  }),
);
console.log('wrote assets/icon.png and assets/splash-icon.png');
