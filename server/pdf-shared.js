const sharp = require('sharp');
const axios = require('axios');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const MM = 72 / 25.4; // PDF-punten per millimeter

// 1% geel (CMYK C0 M0 Y1 K0) — bewust als ECHTE volledig-dekkende kleur, niet
// via PDF-transparantie (niet elke drukkerij-RIP verwerkt transparantie
// betrouwbaar, zie ook de eerdere Spotify-code-balkjes-discussie). Wordt
// gebruikt voor de "Wit" achtergrondoptie, en als achtergrondvlak achter een
// QR-/Spotify-code op een marmer-achtergrond.
function nearWhiteCmyk(cmykFn) {
  return cmykFn(0, 0, 0.01, 0);
}

// Tekent de achtergrond van een volledige pagina: "Wit" (1% geel-truc),
// "Zwart" (diepzwart), "Marmerwit"/"Marmerzwart" (echte marmertextuur,
// beeldvullend uitgerekt over de hele pagina), of niets bij "Transparant".
// `cmykFn`/`rgbFn` zijn de `cmyk`/`rgb` functies uit pdf-lib (per aanroeper
// meegegeven, i.p.v. hier een eigen pdf-lib-import op te zetten).
async function drawBackground(doc, page, achtergrondKleur, pageWidthMm, pageHeightMm, cmykFn, rgbFn) {
  const bg = (achtergrondKleur || '').toLowerCase();
  const wPt = pageWidthMm * MM;
  const hPt = pageHeightMm * MM;

  const hasMarmer = bg.includes('marmer');
  const hasWit = bg.includes('wit');
  const hasZwart = bg.includes('zwart');

  if (hasMarmer && hasWit) {
    await drawImageBackground(doc, page, 'marmerwit.jpg', wPt, hPt);
  } else if (hasMarmer && hasZwart) {
    await drawImageBackground(doc, page, 'marmerzwart.jpg', wPt, hPt);
  } else if (hasWit) {
    page.drawRectangle({ x: 0, y: 0, width: wPt, height: hPt, color: nearWhiteCmyk(cmykFn) });
  } else if (hasZwart) {
    page.drawRectangle({ x: 0, y: 0, width: wPt, height: hPt, color: rgbFn(0, 0, 0) });
  }
  // "Transparant" (of onbekend/leeg): niets tekenen, blijft leeg/transparant.
}

async function drawImageBackground(doc, page, filename, wPt, hPt) {
  const imgPath = path.join(__dirname, 'background-assets', filename);
  const jpgBuffer = fs.readFileSync(imgPath);
  const image = await doc.embedJpg(jpgBuffer);
  page.drawImage(image, { x: 0, y: 0, width: wPt, height: hPt });
}

// Bepaalt of een gegeven achtergrondKleur een marmer-variant is — bij marmer
// krijgt de QR-/Spotify-code-achtergrond 1% geel i.p.v. puur wit, zodat er
// geen vreemd wit blok bovenop de marmertextuur verschijnt.
function isMarbleBackground(achtergrondKleur) {
  const bg = (achtergrondKleur || '').toLowerCase();
  return bg.includes('marmer');
}

// --- Emoji-ondersteuning ---
// Montserrat (en bijna elk gewoon lettertype) bevat geen emoji-tekens, dus die
// vallen anders gewoon weg. We herkennen emoji apart en tekenen ze als kleine
// afbeeldingen via Twemoji (Twitter's gratis, open-source emoji-set) — dezelfde
// aanpak die WhatsApp/Slack/Discord gebruiken om emoji van willekeurig welk
// platform (dus ook Apple) er overal consistent uit te laten zien.
const EMOJI_REGEX = /(\p{Regional_Indicator}{2}|[0-9#*]\ufe0f?\u20e3|\p{Extended_Pictographic}(?:\u200d\p{Extended_Pictographic})*(?:\ufe0f)?|\p{Emoji_Presentation})/gu;

// Vangnet: elk los teken dat overblijft in een "tekst"-stuk, maar buiten het
// normale Latijnse schrift valt (dus geen normale letters/cijfers/leestekens/
// accenten), wordt ALSNOG als "emoji" behandeld. Dit vangt nieuwere/zeldzame
// Apple-emoji op die de reguliere expressie hierboven nog niet kent (bv. een
// nieuwe emoji die recenter is dan de Unicode-versie van de server) — zonder
// dit vangnet zou zo'n teken gewoon als tekst naar het lettertype gaan, dat er
// geen icoontje voor heeft, en als kapot vierkantje verschijnen.
const SAFE_TEXT_CHAR_REGEX = /[\u0000-\u036F\u1E00-\u1EFF\u2010-\u2027\u2030-\u205E\u20A0-\u20CF]/u;

function splitTextEmoji(text) {
  const parts = [];
  let lastIndex = 0;
  for (const match of text.matchAll(EMOJI_REGEX)) {
    if (match.index > lastIndex) parts.push(...splitRemainderSafely(text.slice(lastIndex, match.index)));
    parts.push({ type: 'emoji', value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(...splitRemainderSafely(text.slice(lastIndex)));
  return parts;
}

// Splitst een "tekst"-stuk verder op: normale tekens blijven gewoon tekst,
// maar elk teken buiten het veilige Latijnse bereik wordt als eigen "emoji"-
// deel behandeld (vangnet, zie SAFE_TEXT_CHAR_REGEX hierboven).
function splitRemainderSafely(text) {
  const out = [];
  let buffer = '';
  for (const char of text) {
    if (SAFE_TEXT_CHAR_REGEX.test(char)) {
      buffer += char;
    } else {
      if (buffer) { out.push({ type: 'text', value: buffer }); buffer = ''; }
      out.push({ type: 'emoji', value: char });
    }
  }
  if (buffer) out.push({ type: 'text', value: buffer });
  return out;
}

function emojiToCodepoints(emoji) {
  const codepoints = [];
  for (const char of emoji) codepoints.push(char.codePointAt(0).toString(16));
  return codepoints.join('-');
}

// Haalt de Twemoji-svg op en zet 'm om naar PNG. Probeert eerst met de exacte
// codepoints, en anders zonder de losse "fe0f" (variation selector) erachter —
// niet elke emoji heeft daarvoor een apart svg-bestand.
async function fetchEmojiPng(emoji, sizePx) {
  const codepoints = emojiToCodepoints(emoji);
  const candidates = [codepoints];
  if (codepoints.endsWith('-fe0f')) candidates.push(codepoints.replace(/-fe0f$/, ''));

  for (const cp of candidates) {
    try {
      const url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@latest/assets/svg/${cp}.svg`;
      const res = await axios.get(url, { responseType: 'text' });
      return await sharp(Buffer.from(res.data)).resize(sizePx, sizePx).png().toBuffer();
    } catch (e) {
      // probeer de volgende variant, of geef uiteindelijk niets terug
    }
  }
  return null;
}

// Haalt voor alle gevonden emoji in de gegeven teksten vast de PNG's op en
// embedt ze in het PDF-document, zodat we ze tijdens het tekenen meteen kunnen
// hergebruiken (en dezelfde emoji niet 2x ophalen als 'ie op meerdere velden staat).
async function preloadEmojiImages(doc, texts, sizePx = 128) {
  const cache = new Map();
  const allEmoji = new Set();
  texts.forEach(text => {
    if (!text) return;
    splitTextEmoji(text).forEach(p => { if (p.type === 'emoji') allEmoji.add(p.value); });
  });

  await Promise.all(Array.from(allEmoji).map(async emoji => {
    try {
      const png = await fetchEmojiPng(emoji, sizePx);
      if (png) cache.set(emoji, await doc.embedPng(png));
    } catch (e) {
      console.warn(`[pdf-shared] kon emoji "${emoji}" niet ophalen, wordt weggelaten:`, e.message);
    }
  }));

  return cache;
}

// Meet de totale breedte (in PDF-punten) van tekst + emoji samen, bij een
// gegeven puntgrootte — emoji tellen even breed als hoog (1 "em").
function measureMixedTextWidth(parts, font, sizePt) {
  return parts.reduce((total, p) => {
    if (p.type === 'emoji') return total + sizePt;
    return total + font.widthOfTextAtSize(p.value, sizePt);
  }, 0);
}

// Tekent een regel tekst+emoji door elkaar, op de gegeven basislijn (PDF-punten,
// dus al vanaf de onderkant van de pagina).
function drawMixedText(page, parts, font, sizePt, xPt, baselineYPt, color, emojiCache) {
  let cursorX = xPt;
  parts.forEach(p => {
    if (p.type === 'emoji') {
      const img = emojiCache.get(p.value);
      if (img) {
        const size = sizePt * 1.15;
        page.drawImage(img, {
          x: cursorX,
          y: baselineYPt - sizePt * 0.15,
          width: size,
          height: size
        });
      }
      cursorX += sizePt;
    } else {
      page.drawText(p.value, { x: cursorX, y: baselineYPt, size: sizePt, font, color });
      cursorX += font.widthOfTextAtSize(p.value, sizePt);
    }
  });
}

// Past een font-grootte automatisch aan (in stapjes van 0.5pt) totdat de
// tekst (incl. eventuele emoji) binnen de opgegeven maximale breedte past.
function fitFontSizeToWidth(parts, font, defaultSizePt, maxWidthPt, minSizePt = 6) {
  let size = defaultSizePt;
  while (size > minSizePt && measureMixedTextWidth(parts, font, size) > maxWidthPt) {
    size -= 0.5;
  }
  return size;
}

// Bewaart de foto met de EIGEN beeldverhouding intact (niet uitgerekt of
// bijgesneden naar vierkant) — geeft naast de ingebedde afbeelding ook de
// beeldverhouding terug, zodat de aanroeper 'm netjes kan "contain"-passen
// binnen een vierkant vak (i.e. het lege deel blijft leeg i.p.v. gevuld).
// `targetZoneSizeMm`: de fysieke afmeting (mm) van het vak waar de foto in
// komt — bepaalt de resize-resolutie zodat het resultaat altijd minstens
// 300dpi haalt (i.p.v. een vaste pixelwaarde die per product te laag kon
// uitvallen). Een te kleine bronfoto wordt nooit kunstmatig opgeschaald
// (fit: 'inside' vergroot nooit, alleen verkleinen indien nodig) — dat zou
// alleen maar vervagen, geen echte kwaliteit toevoegen.
async function embedPhoto(doc, photoUrl, filterValue, targetZoneSizeMm = 160) {
  const imgRes = await axios.get(photoUrl, { responseType: 'arraybuffer' });
  let pipeline = sharp(Buffer.from(imgRes.data)).rotate(); // EXIF-rotatie vast "bakken"

  const filter = (filterValue || '').toLowerCase();
  if (filter.includes('zwart') || filter.includes('grijs') || filter.includes('black') || filter.includes('white')) {
    pipeline = pipeline.grayscale();
  }
  // filter === 'kleur' (of onbekend/leeg): geen aanpassing

  const rotatedBuffer = await pipeline.toBuffer();
  const metadata = await sharp(rotatedBuffer).metadata();
  const aspectRatio = metadata.width / metadata.height; // >1 = breder dan hoog

  // Benodigde pixels voor 300dpi op het volledige vak (langste zijde) — een
  // niet-vierkante foto vult sowieso maar 1 richting van het vak, dus dit is
  // ruim voldoende voor beide richtingen.
  const targetPx = Math.ceil((targetZoneSizeMm / 25.4) * 300);

  const jpegBuffer = await sharp(rotatedBuffer)
    .resize({ width: targetPx, height: targetPx, fit: 'inside', withoutEnlargement: true }) // verhouding intact, nooit opschalen
    .jpeg({ quality: 92 })
    .toBuffer();

  const image = await doc.embedJpg(jpegBuffer);
  return { image, aspectRatio };
}

// Berekent, gegeven een vierkant vak (zoneSizeMm) en de beeldverhouding van de
// foto, de daadwerkelijke render-afmetingen + positie zodat de foto's EIGEN
// verhouding behouden blijft ("contain"-passen, gecentreerd) — het lege deel
// (zijkanten óf boven-/onderkant, afhankelijk van de foto) blijft leeg.
function fitPhotoInSquareZone(aspectRatio, zoneXMm, zoneTopMm, zoneSizeMm) {
  let renderWidthMm, renderHeightMm;
  if (aspectRatio >= 1) {
    renderWidthMm = zoneSizeMm;
    renderHeightMm = zoneSizeMm / aspectRatio;
  } else {
    renderHeightMm = zoneSizeMm;
    renderWidthMm = zoneSizeMm * aspectRatio;
  }
  return {
    renderWidthMm,
    renderHeightMm,
    renderXMm: zoneXMm + (zoneSizeMm - renderWidthMm) / 2,
    renderTopMm: zoneTopMm + (zoneSizeMm - renderHeightMm) / 2
  };
}

// Kleurt een zwart/wit-afbeelding om: elke donkere pixel wordt de opgegeven
// doelkleur, elke lichte pixel blijft puur wit. ECHTE pixelkleur (niet PDF-
// transparantie/opacity) — niet elke drukkerij-RIP verwerkt transparantie
// betrouwbaar, een aangepaste pixelkleur werkt overal hetzelfde.
async function recolorDarkPixels(pngBuffer, targetRgb) {
  const image = sharp(pngBuffer).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += info.channels) {
    const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (luminance < 128) {
      data[i] = targetRgb.r;
      data[i + 1] = targetRgb.g;
      data[i + 2] = targetRgb.b;
    } else {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
    }
  }

  return sharp(data, { raw: info }).png().toBuffer();
}

// Genereert de svg voor een QR-code of Spotify Code.
async function getCodeSvg(codeType, link, barColorHex) {
  if (codeType === 'qr') {
    try {
      const dark = barColorHex ? `#${barColorHex}` : '#000000';
      return await QRCode.toString(link, { type: 'svg', margin: 1, color: { dark, light: '#ffffff' } });
    } catch (e) {
      // Zelfde redenering als bij Spotify hieronder: nooit de hele PDF laten
      // crashen enkel omdat 1 QR-code niet gegenereerd kon worden.
      console.warn(`[pdf-shared] kon QR-code niet genereren voor "${link}", wordt weggelaten:`, e.message);
      return null;
    }
  }
  if (codeType === 'spotify') {
    let uri = link.trim();
    // Spotify-deellinks bevatten soms een extra onderdeel vlak na
    // "spotify.com/" (taal-/regiocode zoals "intl-de", of bv. "embed") — dat
    // onderdeel is generiek optioneel meegenomen, zodat de link hoe dan ook
    // correct naar het juiste spotify:type:id-formaat wordt omgezet, ongeacht
    // welke variant Spotify gebruikt.
    const match = uri.match(/open\.spotify\.com\/(?:[a-z0-9-]+\/)?(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/i);
    if (match) uri = `spotify:${match[1]}:${match[2]}`;
    const encoded = encodeURIComponent(uri);
    // Spotify's eigen scannables-service accepteert voor de voorgrondkleur
    // UITSLUITEND de letterlijke woorden "black"/"white" — geen hex-code (een
    // hex geeft een 400-fout). We halen 'm daarom altijd met zwarte balkjes op
    // (altijd geldig, altijd contrast) en kleuren die zelf achteraf om.
    const svgUrl = `https://scannables.scdn.co/uri/plain/svg/ffffff/black/640/${encoded}`;
    try {
      const res = await axios.get(svgUrl, { responseType: 'text' });
      return res.data;
    } catch (e) {
      // Nooit de HELE PDF-generatie laten crashen enkel omdat de Spotify-code
      // niet opgehaald kon worden (bv. een link die toch niet herkend werd,
      // of Spotify's service tijdelijk niet bereikbaar) — liever een bestand
      // zonder code dan helemaal geen bestand.
      console.warn(`[pdf-shared] kon Spotify Code niet ophalen voor "${link}", wordt weggelaten:`, e.message);
      return null;
    }
  }
  return null;
}

module.exports = {
  MM,
  splitTextEmoji, emojiToCodepoints, fetchEmojiPng, preloadEmojiImages,
  measureMixedTextWidth, drawMixedText, fitFontSizeToWidth,
  embedPhoto, fitPhotoInSquareZone, recolorDarkPixels, getCodeSvg,
  drawBackground, isMarbleBackground, nearWhiteCmyk
};
