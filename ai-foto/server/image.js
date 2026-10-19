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
async function prepareInput(buffer, profile, orientation, crop, opts = {}) {
  const [rw, rh] = PROFILES[profile].ratio(orientation);
  const ratio = rw / rh;
  const rotated = await sharp(buffer).rotate().toBuffer({ resolveWithObject: true });
  const W = rotated.info.width, H = rotated.info.height;
  let src = rotated.data;
  if (crop && crop.w > 0 && crop.h > 0) {
    // De gekozen uitsnede wordt (zonder iets weg te knippen) uitgebreid naar de verhouding van het product,
    // en blijft binnen de foto.
    const cx = (crop.x + crop.w / 2) * W, cy = (crop.y + crop.h / 2) * H;
    let bw = crop.w * W, bh = crop.h * H;
    if (bw / bh < ratio) bw = bh * ratio; else bh = bw / ratio;
    if (bw > W) { bw = W; bh = bw / ratio; }
    if (bh > H) { bh = H; bw = bh * ratio; }
    const left = Math.round(Math.min(W - bw, Math.max(0, cx - bw / 2)));
    const top = Math.round(Math.min(H - bh, Math.max(0, cy - bh / 2)));
    src = await sharp(src).extract({ left, top, width: Math.min(W - left, Math.round(bw)), height: Math.min(H - top, Math.round(bh)) }).toBuffer();
  }
  const longTarget = 1536;
  const w = rw >= rh ? longTarget : Math.round((longTarget * rw) / rh);
  const h = rw >= rh ? Math.round((longTarget * rh) / rw) : longTarget;
  // Geen uitsnede gekozen: de héle foto blijft zichtbaar (witte randen), in plaats van links/rechts of boven/onder af te snijden.
  const meta = await sharp(src).metadata();
  const srcRatio = meta.width / meta.height;
  const padded = !!opts.whole && !(crop && crop.w > 0 && crop.h > 0) && Math.abs(srcRatio / ratio - 1) > 0.04;
  const out = await sharp(src)
    .resize(w, h, padded ? { fit: 'contain', background: '#ffffff' } : { fit: 'cover', position: sharp.strategy.attention })
    .jpeg({ quality: 92 })
    .toBuffer();
  return { buffer: out, w, h, srcW: W, srcH: H, padded };
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
  // Geen watermerk meer (storend voor de klant); het voorbeeld wordt alleen verkleind getoond.
  return sharp(base).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { PROFILES, targetSize, prepareInput, finalize, previewOnly };
