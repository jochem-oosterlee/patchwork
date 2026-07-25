// Rasterize the Patchwork app icon (lucide 'cable') to PNG using sharp.
const fs    = require('fs');
const path  = require('path');
const sharp = require('sharp');

const SIZE  = 512;
const PAD_R = 112;                 // panel corner radius
const BG    = '#ffaa33';           // panel: accent orange
const EDGE  = '#cc8a29';           // panel edge: darker orange
const FG    = '#16181c';           // cable: panel-dark

// lucide cable, viewBox 24×24
// Read official lucide cable SVG, recolour stroke to our accent.
const cableSvg = fs.readFileSync(path.join(__dirname, '..', 'resources', 'cable.svg'), 'utf8')
  .replace('stroke="currentColor"', `stroke="${FG}"`);

const panelSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <rect x="1.5" y="1.5" width="${SIZE-3}" height="${SIZE-3}" rx="${PAD_R}" ry="${PAD_R}"
        fill="${BG}" stroke="${EDGE}" stroke-width="3"/>
</svg>`.trim();

(async () => {
  const outDir = path.join(__dirname, '..', 'resources');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'patchwork-icon.png');

  const panel = await sharp(Buffer.from(panelSvg)).png().toBuffer();
  const cable = await sharp(Buffer.from(cableSvg), { density: 600 }).resize(340, 340).png().toBuffer();

  const cableTop  = Math.round((SIZE - 340) / 2);
  await sharp(panel)
    .composite([{ input: cable, top: cableTop, left: cableTop }])
    .png()
    .toFile(out);

  console.log('wrote', out);
})().catch(e => { console.error(e); process.exit(1); });
