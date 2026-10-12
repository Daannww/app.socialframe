const sharp = require('sharp');

const PROFILES = {
  // tegel: vierkant. poster: 7:5 (liggend of staand), grootste formaat 70x50 cm.
  tegel: { ratio: () => [1, 1], dpi: 300 },
  poster: { ratio: (o) => (o === 'portrait' ? [5, 7] : [7, 5]), dpi: 100 },
};

function targetSize(profile, orientation, settings) {
  const p = PROFILES[profile];
  if (!p) throw new Error('Onbekend profiel: ' + profile);
  const [rw, rh] = p.ratio(orientation);
  if (profile === 'tegel') {
    const px = parseInt(settings.tegel_px, 10);
    return { w: px, h: px, dpi: p.dpi };
  }
  const long = parseInt(settings.poster_long_px, 10);
  return rw >= rh
    ? { w: long, h: Math.round((long * rh) / rw), dpi: p.dpi }
    : { w: Math.round((long * rw) / rh), h: long, dpi: p.dpi };
}

// Foto van de klant: draaien volgens EXIF, bijsnijden naar de verhouding, max 1536 px lang
// (genoeg voor het AI-model, houdt de upload klein).
async function prepareInput(buffer, profile, orientation) {
  const [rw, rh] = PROFILES[profile].ratio(orientation);
  const meta = await sharp(buffer).rotate().metadata();
  const longTarget = 1536;
  const w = rw >= rh ? longTarget : Math.round((longTarget * rw) / rh);
  const h = rw >= rh ? Math.round((longTarget * rh) / rw) : longTarget;
  const out = await sharp(buffer)
    .rotate()
    .resize(w, h, { fit: 'cover', position: sharp.strategy.attention })
    .jpeg({ quality: 92 })
    .toBuffer();
  return { buffer: out, w, h, srcW: meta.width, srcH: meta.height };
}

// Eindbestand: exact de doelafmeting (bijsnijden als het model net een andere verhouding gaf),
// met dpi-metadata, als PNG-vrij hoge kwaliteit JPEG. Voor print geschikt.
async function finalize(buffer, target) {
  const printBuf = await sharp(buffer)
    .resize(target.w, target.h, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
    .withMetadata({ density: target.dpi })
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const previewBuf = await sharp(printBuf)
    .resize({ width: 1000, height: 1000, fit: 'inside' })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { printBuf, previewBuf };
}

// Snelle voorbeeldweergave rechtstreeks uit het ruwe resultaat (zelfde uitsnede als het drukbestand).
async function previewOnly(buffer, target) {
  const k = Math.min(1, 1000 / Math.max(target.w, target.h));
  const w = Math.round(target.w * k), h = Math.round(target.h * k);
  const base = await sharp(buffer).resize(w, h, { fit: 'cover', position: 'centre' }).jpeg({ quality: 90 }).toBuffer();
  // Subtiel diagonaal watermerk, zodat het voorbeeld niet als gratis afbeelding gebruikt kan worden.
  const step = Math.round(Math.max(w, h) / 4);
  const fs = Math.max(14, Math.round(step / 6));
  let t = '';
  for (let y = -step; y < h + step; y += step) for (let x = -step; x < w + step; x += step * 1.4)
    t += `<text x="${Math.round(x)}" y="${Math.round(y)}" font-size="${fs}" font-family="Arial,Helvetica,sans-serif" font-weight="700" fill="#fff" fill-opacity="0.28" stroke="#000" stroke-opacity="0.10" stroke-width="1" transform="rotate(-30 ${Math.round(x)} ${Math.round(y)})">socialframe.nl</text>`;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${t}</svg>`);
  return sharp(base).composite([{ input: svg }]).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { PROFILES, targetSize, prepareInput, finalize, previewOnly };
