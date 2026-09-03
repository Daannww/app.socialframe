const sharp = require('sharp');
const axios = require('axios');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const MM = 72 / 25.4; // PDF-punten per millimeter

// LET OP: eerder stond hier een fix die een onzichtbaar Zero-Width Non-Joiner
// (U+200C) tussen "ff"/"fi"/"fl"/"ffi"/"ffl"-combinaties invoegde, om een
// bekende pdf-lib-ligatuur-breedtebug te omzeilen (github.com/Hopding/
// pdf-lib/issues/1275). In de praktijk (met de echte, gedeployde
// lettertypen) bleek dat teken zelf een ZICHTBARE ruimte te veroorzaken —
// dus een duidelijk zichtbare fout, erger dan de oorspronkelijke (nauwelijks
// zichtbare) bug. Teruggedraaid: deze functie doet nu weer niets, tekst gaat
// ongewijzigd door naar drawText/widthOfTextAtSize.
function voorkomLigatuurGaten(tekst) {
  return tekst;
}

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

// Geeft aan of drawBackground hierboven daadwerkelijk iets tekent voor de
// gegeven waarde (dus alles behalve "Transparant"/leeg/onbekend). Gebruikt
// om te bepalen of een fotovak (bij een niet-vierkante foto, dus met lege
// marge eromheen) zelf nog een vulling nodig heeft — anders blijft die marge
// helemaal ongekleurd, en dat kan een printer nog problematischer vinden dan
// puur wit (#FFFFFF): daar staat dan letterlijk niks getekend.
function hasPageBackground(achtergrondKleur) {
  const bg = (achtergrondKleur || '').toLowerCase();
  return bg.includes('marmer') || bg.includes('wit') || bg.includes('zwart');
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

// Hebreeuws schrift (incl. de "Alphabetic Presentation Forms"-tekens die bij
// bepaalde toetsenborden/lettercombinaties gebruikt worden) — wordt NIET als
// emoji behandeld maar als eigen "hebrew"-tekst-type (zie splitRemainderSafely
// hieronder), en rechts-naar-links getekend (zie drawMixedText). Ontdekt na een
// echte order waarbij Hebreeuwse tekst stilzwijgend wegviel: die tekens vielen
// vroeger buiten SAFE_TEXT_CHAR_REGEX en werden dus ten onrechte als "emoji"
// behandeld — er werd dan (tevergeefs) een emoji-plaatje voor gezocht, dat
// natuurlijk nooit bestaat, dus er verscheen stilzwijgend niets (wel schoof de
// cursor door, als was er wél iets getekend).
const HEBREW_CHAR_REGEX = /[\u0590-\u05FF\uFB1D-\uFB4F]/u;

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
// Hebreeuwse tekens (mét de spaties daartussenin, anders zou de WOORDVOLGORDE
// bij het omdraaien alsnog verkeerd blijven staan — alleen de losse woorden
// zouden dan omgedraaid zijn, niet hun onderlinge volgorde) worden een eigen
// "hebrew"-deel (rechts-naar-links, dus de hele frase wordt hier al in
// tekenvolgorde omgedraaid — zie drawMixedText voor de toelichting waarom),
// en alles daarbuiten wordt als "emoji" behandeld (vangnet, zie
// SAFE_TEXT_CHAR_REGEX hierboven).
function splitRemainderSafely(text) {
  const out = [];
  let buffer = '';
  let bufferType = null;
  const flush = () => {
    if (!buffer) return;
    out.push({ type: bufferType, value: bufferType === 'hebrew' ? [...buffer].reverse().join('') : buffer });
    buffer = '';
  };
  for (const char of text) {
    let type;
    if (HEBREW_CHAR_REGEX.test(char)) {
      type = 'hebrew';
    } else if (char === ' ' && bufferType === 'hebrew') {
      // Spatie MIDDEN in een Hebreeuwse frase: bij die frase houden, i.p.v.
      // een apart "text"-deel te worden — anders zou alleen elk Hebreeuws
      // woord los omgedraaid worden, maar de woorden onderling nog steeds in
      // de verkeerde (links-naar-rechts) volgorde blijven staan.
      type = 'hebrew';
    } else if (SAFE_TEXT_CHAR_REGEX.test(char)) {
      type = 'text';
    } else {
      type = 'emoji';
    }
    if (type !== bufferType) { flush(); bufferType = type; }
    buffer += char;
  }
  flush();
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
// gegeven puntgrootte — emoji tellen even breed als hoog (1 "em"). Voor
// "hebrew"-delen wordt (indien meegegeven) hebrewFont gebruikt om de breedte
// te meten — zonder hebrewFont tellen ze NIET mee (0 breedte) i.p.v. het
// gewone lettertype te proberen: dat lettertype heeft nooit Hebreeuwse
// glyphs, en bij een STANDAARD PDF-lettertype (bv. de Helvetica-noodgreep als
// zelfs Montserrat ontbreekt) gooit pdf-lib daar zelfs een harde fout op
// (WinAnsi-encoding kan het teken niet coderen) — dat zou de HELE PDF-
// generatie laten crashen, terwijl "die tekst blijft leeg" nooit fataal mag
// zijn. Een try/catch eromheen als extra vangnet voor onverwachte tekens
// die zelfs hebrewFont zelf niet kent.
function measureMixedTextWidth(parts, font, sizePt, hebrewFont) {
  return parts.reduce((total, p) => {
    if (p.type === 'emoji') return total + sizePt;
    if (p.type === 'hebrew') {
      if (!hebrewFont) return total; // geen lettertype beschikbaar: telt niet mee, crasht niet
      try {
        return total + hebrewFont.widthOfTextAtSize(p.value, sizePt);
      } catch (e) {
        return total;
      }
    }
    return total + font.widthOfTextAtSize(voorkomLigatuurGaten(p.value), sizePt);
  }, 0);
}

// Tekent een regel tekst+emoji(+Hebreeuws) door elkaar, op de gegeven
// basislijn (PDF-punten, dus al vanaf de onderkant van de pagina). Hebreeuwse
// delen zijn door splitRemainderSafely hierboven al in de juiste (omgekeerde)
// tekenvolgorde gezet, en worden — indien meegegeven — met hebrewFont
// getekend. Zonder hebrewFont (of bij een onverwacht teken dat zelfs
// hebrewFont niet kent) wordt dat deel gewoon overgeslagen i.p.v. een crash
// te riskeren — zie de toelichting bij measureMixedTextWidth hierboven.
function drawMixedText(page, parts, font, sizePt, xPt, baselineYPt, color, emojiCache, hebrewFont) {
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
    } else if (p.type === 'hebrew') {
      if (!hebrewFont) return; // geen lettertype beschikbaar: overslaan, niet crashen
      try {
        page.drawText(p.value, { x: cursorX, y: baselineYPt, size: sizePt, font: hebrewFont, color });
        cursorX += hebrewFont.widthOfTextAtSize(p.value, sizePt);
      } catch (e) {
        console.warn('[pdf-shared] kon Hebreeuws tekstdeel niet tekenen, wordt overgeslagen:', e.message);
      }
    } else {
      const veiligeTekst = voorkomLigatuurGaten(p.value);
      page.drawText(veiligeTekst, { x: cursorX, y: baselineYPt, size: sizePt, font, color });
      cursorX += font.widthOfTextAtSize(veiligeTekst, sizePt);
    }
  });
}

// Past een font-grootte automatisch aan (in stapjes van 0.5pt) totdat de
// tekst (incl. eventuele emoji/Hebreeuws) binnen de opgegeven maximale
// breedte past.
function fitFontSizeToWidth(parts, font, defaultSizePt, maxWidthPt, minSizePt = 6, hebrewFont) {
  let size = defaultSizePt;
  while (size > minSizePt && measureMixedTextWidth(parts, font, size, hebrewFont) > maxWidthPt) {
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

  const resizedBuffer = await sharp(rotatedBuffer)
    .resize({ width: targetPx, height: targetPx, fit: 'inside', withoutEnlargement: true }) // verhouding intact, nooit opschalen
    .toBuffer();

  // Kleurbalans-correctie (echte CMYK-conversie, zelfde soort aanpassing als
  // in Illustrator/Photoshop se "Kleuren wijzigen") op elke foto. Nu Y+8% —
  // eerst 1% (oorspronkelijk gevraagd), toen 3% (loste #FFFFFF-pixels op in
  // digitale test tegen een echte, uitdagende testfoto), maar in de
  // PRAKTIJK bij het echt printen bleken er nog gaten te ontstaan (al wel
  // kleiner dan voorheen) — dus de daadwerkelijke drempel van de printer/RIP
  // ligt kennelijk hoger dan waar puur digitaal op te testen is. Naar 8%
  // gezet als praktische, flink sterkere marge; nog altijd met het blote oog
  // nauwelijks waarneembaar (zie de vergelijkingstest in de chat).
  const jpegBuffer = await adjustCmykChannels(resizedBuffer, { c: 0, m: 0, y: 0.08, k: 0 });

  const image = await doc.embedJpg(jpegBuffer);
  return { image, aspectRatio };
}

// Past een ECHTE CMYK-kanaalaanpassing toe op een foto (RGB -> CMYK omreke-
// nen, de kanalen bijstellen, terug naar RGB) — zelfde soort aanpassing als
// in het "Kleuren wijzigen"-dialoogvenster van Illustrator/Photoshop, i.p.v.
// een RGB-benadering. Gebruikt de standaard, eenvoudige CMYK<->RGB-formules
// (geen ICC-kleurprofielen, dat is voor dit doel niet nodig).
// `delta` = { c, m, y, k } als fractie (0.01 = 1%), mag ook negatief zijn.
async function adjustCmykChannels(imageBuffer, delta) {
  const image = sharp(imageBuffer).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const dC = delta.c || 0, dM = delta.m || 0, dY = delta.y || 0, dK = delta.k || 0;

  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;

    // RGB -> CMYK
    const k = 1 - Math.max(r, g, b);
    let c, m, y;
    if (k >= 1) {
      c = 0; m = 0; y = 0; // puur zwart, C/M/Y zijn dan niet gedefinieerd (deling door 0)
    } else {
      c = (1 - r - k) / (1 - k);
      m = (1 - g - k) / (1 - k);
      y = (1 - b - k) / (1 - k);
    }

    // Kanalen bijstellen, elk apart tussen 0 en 1 geklemd
    const c2 = Math.min(1, Math.max(0, c + dC));
    const m2 = Math.min(1, Math.max(0, m + dM));
    const y2 = Math.min(1, Math.max(0, y + dY));
    const k2 = Math.min(1, Math.max(0, k + dK));

    // CMYK -> RGB
    data[i] = Math.round(255 * (1 - c2) * (1 - k2));
    data[i + 1] = Math.round(255 * (1 - m2) * (1 - k2));
    data[i + 2] = Math.round(255 * (1 - y2) * (1 - k2));
  }

  let jpegBuffer = await sharp(data, { raw: info }).jpeg({ quality: 92 }).toBuffer();

  // JPEG-compressie hierna is LOSSY en kan bij scherpe contrastranden een
  // klein aantal pixels toch weer terug naar exact #FFFFFF duwen — zelfde
  // vangnet als eerder al bewezen nodig was: controleren én zo nodig
  // corrigeren ná de compressie, met een paar herhalingen (de hercompressie
  // zelf kan namelijk ook weer een paar nieuwe gevallen veroorzaken).
  for (let poging = 0; poging < 3; poging++) {
    const gecomprimeerd = await sharp(jpegBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let gecorrigeerd = false;
    for (let i = 0; i < gecomprimeerd.data.length; i += gecomprimeerd.info.channels) {
      if (gecomprimeerd.data[i] === 255 && gecomprimeerd.data[i + 1] === 255 && gecomprimeerd.data[i + 2] === 255) {
        gecomprimeerd.data[i + 2] = 230;
        gecorrigeerd = true;
      }
    }
    if (!gecorrigeerd) break;
    jpegBuffer = await sharp(gecomprimeerd.data, { raw: gecomprimeerd.info }).jpeg({ quality: 92 }).toBuffer();
  }

  return jpegBuffer;
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

// Het omgekeerde van recolorDarkPixels: elke LICHTE pixel (de eigen witte
// achtergrond van bv. een Spotify-code) wordt de opgegeven, bijna-witte
// doelkleur i.p.v. letterlijk puur wit — donkere pixels blijven onveranderd.
// Nodig omdat een scanbare code altijd een eigen lichte achtergrond MOET
// hebben (anders onscanbaar), maar die achtergrond hoeft daarvoor niet
// letterlijk #FFFFFF te zijn — net zo subtiel gemaakt als de rest van dit
// project (foto's, "Wit" als achtergrondkleur, enz.).
async function recolorLightPixels(pngBuffer, targetRgb) {
  const image = sharp(pngBuffer).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += info.channels) {
    const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (luminance >= 128) {
      data[i] = targetRgb.r;
      data[i + 1] = targetRgb.g;
      data[i + 2] = targetRgb.b;
    }
  }

  return sharp(data, { raw: info }).png().toBuffer();
}

// Maakt specifiek de LICHTE pixels van een code (bv. de witte achtergrond van
// een Spotify-code) grotendeels doorzichtig via het ALFAKANAAL van de
// afbeelding zelf — dus ECHT in de pixeldata ingebakken, niet als losse
// PDF-drawImage-opacity (die is minder betrouwbaar op sommige RIP's). Donkere
// pixels (de balkjes zelf) blijven altijd 100% dekkend, voor de scanbaarheid.
// Gebruikt bij een gekleurde/marmer-achtergrond, zodat die textuur nog door
// de code-achtergrond heen te zien blijft, i.p.v. een dekkend wit blok.
async function makeLightPixelsTranslucent(pngBuffer, opacityPercent) {
  const image = sharp(pngBuffer).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const targetAlpha = Math.round(255 * (opacityPercent / 100));

  for (let i = 0; i < data.length; i += info.channels) {
    const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (luminance >= 128) {
      data[i + 3] = targetAlpha; // alleen het alfakanaal aanpassen, kleur blijft wit
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

// Haalt uit een simpele SVG (zoals de Spotify Code — <rect>/<path>-elementen
// met een fill-kleur) alle vormen op, MINUS de volledige-canvas-achtergrond-
// rect (fill=wit/#ffffff, exact zo groot als de hele svg). Zo kunnen we de
// balkjes als ECHTE vectorvormen op de pagina tekenen, zonder dat daar ooit
// een achtergrond bij hoeft — dat kan bij een pixelafbeelding niet (die heeft
// altijd een of andere vulling nodig), bij vectorvormen wel: gewoon niets
// tekenen waar geen balkje staat, en de plaat se eigen achtergrond (marmer,
// kleur, of niets bij "Transparant") schijnt daar dan vanzelf doorheen.
// Zoekt alle <g transform="translate(a,b)">...</g>-blokken en hun bereik
// (start/eind-positie in de string) — SVG's van dit soort scanbare codes
// gebruiken vaak zo'n groep om een logo of balkjesrij als geheel te
// verschuiven, en dat missen we anders volledig (enkel de rauwe x/y/d-
// coördinaten binnen zo'n groep zijn NIET al de uiteindelijke positie).
function findGroupTransforms(svgString) {
  const groups = [];
  const gOpenRegex = /<g\b([^>]*)>/gi;
  let gm;
  while ((gm = gOpenRegex.exec(svgString)) !== null) {
    const attrs = gm[1];
    const transformMatch = attrs.match(/transform=["']\s*translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)["']/i);
    if (!transformMatch) continue;
    const dx = parseFloat(transformMatch[1]);
    const dy = parseFloat(transformMatch[2]);
    const openEnd = gm.index + gm[0].length;
    // Simpele aanpak: de eerstvolgende sluitende </g> na deze open-tag —
    // werkt prima voor niet-geneste of simpele SVG's zoals scanbare codes.
    const closeIndex = svgString.indexOf('</g>', openEnd);
    const closeEnd = closeIndex === -1 ? svgString.length : closeIndex;
    groups.push({ start: gm.index, end: closeEnd, dx, dy });
  }
  return groups;
}

// Telt de verschuiving op van alle <g>-groepen waar deze positie (in de
// oorspronkelijke svg-string) binnenin valt — kan er meerdere zijn bij
// geneste groepen.
function getGroupOffsetForPosition(groups, position) {
  let dx = 0, dy = 0;
  groups.forEach(g => {
    if (position >= g.start && position <= g.end) {
      dx += g.dx;
      dy += g.dy;
    }
  });
  return { dx, dy };
}

// Bouwt een SVG-pad-string voor een afgeronde rechthoek (nodig omdat pdf-lib
// se drawRectangle geen hoekafronding ondersteunt) — zelfde uiterlijk als een
// <rect rx=".." ry="..">, maar dan als los pad om via drawSvgPath te tekenen.
function roundedRectPath(x, y, width, height, rx, ry) {
  const rxClamped = Math.min(rx, width / 2);
  const ryClamped = Math.min(ry, height / 2);
  return `M ${x + rxClamped},${y} ` +
    `L ${x + width - rxClamped},${y} ` +
    `Q ${x + width},${y} ${x + width},${y + ryClamped} ` +
    `L ${x + width},${y + height - ryClamped} ` +
    `Q ${x + width},${y + height} ${x + width - rxClamped},${y + height} ` +
    `L ${x + rxClamped},${y + height} ` +
    `Q ${x},${y + height} ${x},${y + height - ryClamped} ` +
    `L ${x},${y + ryClamped} ` +
    `Q ${x},${y} ${x + rxClamped},${y} Z`;
}

function extractSvgShapes(svgString) {
  const viewBoxMatch = svgString.match(/viewBox=["']([^"']+)["']/i);
  const widthMatch = svgString.match(/\swidth=["']([\d.]+)["']/i);
  const heightMatch = svgString.match(/\sheight=["']([\d.]+)["']/i);

  let canvasWidth, canvasHeight;
  if (viewBoxMatch) {
    const parts = viewBoxMatch[1].trim().split(/\s+/).map(Number);
    canvasWidth = parts[2];
    canvasHeight = parts[3];
  } else {
    canvasWidth = widthMatch ? parseFloat(widthMatch[1]) : 100;
    canvasHeight = heightMatch ? parseFloat(heightMatch[1]) : 100;
  }

  const groups = findGroupTransforms(svgString);
  const shapes = [];

  // <rect .../> — voor barcode-achtige balkjes is dit de meest voorkomende vorm.
  const rectRegex = /<rect\b([^>]*)\/?>/gi;
  let m;
  while ((m = rectRegex.exec(svgString)) !== null) {
    const attrs = m[1];
    const getAttr = (naam) => {
      const am = attrs.match(new RegExp(`${naam}=["']([^"']+)["']`, 'i'));
      return am ? am[1] : null;
    };
    const { dx, dy } = getGroupOffsetForPosition(groups, m.index);
    const x = parseFloat(getAttr('x') || '0') + dx;
    const y = parseFloat(getAttr('y') || '0') + dy;
    const width = parseFloat(getAttr('width') || '0');
    const height = parseFloat(getAttr('height') || '0');
    const fill = (getAttr('fill') || '').toLowerCase();
    const rx = parseFloat(getAttr('rx') || '0');
    const ry = parseFloat(getAttr('ry') || getAttr('rx') || '0'); // ry valt terug op rx, zoals SVG's eigen regel

    // De achtergrond-rect: (nagenoeg) de volledige canvas bedekkend, wit
    // gevuld — die slaan we bewust over.
    const isFullCanvasBackground =
      x <= 1 && y <= 1 && width >= canvasWidth - 2 && height >= canvasHeight - 2 &&
      (fill === '#ffffff' || fill === '#fff' || fill === 'white');
    if (isFullCanvasBackground) continue;
    if (width <= 0 || height <= 0) continue;

    if (rx > 0 || ry > 0) {
      // Afgeronde balkjes (het gebruikelijke uiterlijk van een Spotify Code)
      // — als vectorpad getekend, want drawRectangle kent geen afronding.
      shapes.push({ type: 'path', d: roundedRectPath(x, y, width, height, rx, ry) });
    } else {
      shapes.push({ type: 'rect', x, y, width, height });
    }
  }

  // <path .../> — voor een eventueel logo of afgeronde vormen.
  const pathRegex = /<path\b([^>]*)\/?>/gi;
  while ((m = pathRegex.exec(svgString)) !== null) {
    const attrs = m[1];
    const dMatch = attrs.match(/\sd=["']([^"']+)["']/i);
    if (!dMatch) continue;
    const { dx, dy } = getGroupOffsetForPosition(groups, m.index);
    shapes.push({ type: 'path', d: dMatch[1], groupDx: dx, groupDy: dy });
  }

  // <circle .../> — voor het geval een logo als cirkel i.p.v. pad staat.
  const circleRegex = /<circle\b([^>]*)\/?>/gi;
  while ((m = circleRegex.exec(svgString)) !== null) {
    const attrs = m[1];
    const getAttr = (naam) => {
      const am = attrs.match(new RegExp(`${naam}=["']([^"']+)["']`, 'i'));
      return am ? parseFloat(am[1]) : 0;
    };
    const { dx, dy } = getGroupOffsetForPosition(groups, m.index);
    const cx = getAttr('cx') + dx;
    const cy = getAttr('cy') + dy;
    const r = getAttr('r');
    if (r > 0) shapes.push({ type: 'circle', cx, cy, r });
  }

  return { canvasWidth, canvasHeight, shapes };
}

// Tekent de vormen uit extractSvgShapes hierboven als ECHTE vectorvormen op
// de pagina, geschaald naar het opgegeven doelvak (in mm) — geen enkele
// achtergrond, dus de plaat se eigen achtergrond (marmer/kleur/niets) blijft
// overal zichtbaar behalve waar een balkje staat.
function drawSvgShapesInBox(page, svgData, boxXMm, boxTopMm, boxWidthMm, boxHeightMm, color, fromTopMm, MM) {
  const { canvasWidth, canvasHeight, shapes } = svgData;
  // "Contain"-schaling: dezelfde verhouding aanhouden, gecentreerd in het vak.
  const schaal = Math.min(boxWidthMm / canvasWidth, boxHeightMm / canvasHeight);
  const getekendeBreedteMm = canvasWidth * schaal;
  const getekendeHoogteMm = canvasHeight * schaal;
  const offsetXMm = boxXMm + (boxWidthMm - getekendeBreedteMm) / 2;
  const offsetTopMm = boxTopMm + (boxHeightMm - getekendeHoogteMm) / 2;

  shapes.forEach(shape => {
    if (shape.type === 'rect') {
      const xMm = offsetXMm + shape.x * schaal;
      const topMm = offsetTopMm + shape.y * schaal;
      const wMm = shape.width * schaal;
      const hMm = shape.height * schaal;
      page.drawRectangle({
        x: xMm * MM,
        y: fromTopMm(topMm + hMm),
        width: wMm * MM,
        height: hMm * MM,
        color
      });
    } else if (shape.type === 'path') {
      // SVG-y-as loopt omlaag, drawSvgPath van pdf-lib ook (t.o.v. het eigen
      // y-punt) — dus hier ook via fromTopMm werken, met dezelfde schaal.
      // Een eventuele groepsverschuiving (groupDx/groupDy, bv. van een
      // omvattende <g transform="translate(...)">, zoals bij een logo) wordt
      // hier alsnog meegeteld — dat zit namelijk niet al in het pad zelf.
      const groupDxMm = (shape.groupDx || 0) * schaal;
      const groupDyMm = (shape.groupDy || 0) * schaal;
      page.drawSvgPath(shape.d, {
        x: (offsetXMm + groupDxMm) * MM,
        y: fromTopMm(offsetTopMm + groupDyMm),
        scale: schaal * MM,
        color
      });
    } else if (shape.type === 'circle') {
      const cxMm = offsetXMm + shape.cx * schaal;
      const cyTopMm = offsetTopMm + shape.cy * schaal;
      const rMm = shape.r * schaal;
      page.drawEllipse({
        x: cxMm * MM,
        y: fromTopMm(cyTopMm),
        xScale: rMm * MM,
        yScale: rMm * MM,
        color
      });
    }
  });
}

// Zelfde CMYK-kleurbalans-wiskunde als adjustCmykChannels hierboven, maar dan
// met PNG als uitvoer i.p.v. JPEG — nodig voor foto's die een alpha-kanaal
// (transparantie) moeten behouden, zoals bij afgeronde hoeken. PNG is
// lossless, dus het JPEG-hercompressie-vangnet van adjustCmykChannels is hier
// niet nodig (dat bestond specifiek om JPEG-compressieartefacten op te
// vangen). Bewust een LOSSE functie i.p.v. adjustCmykChannels hergebruiken/
// aanpassen — die wordt al door meerdere, al geteste producten gebruikt.
async function adjustCmykChannelsToPng(imageBuffer, delta) {
  const image = sharp(imageBuffer).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const dC = delta.c || 0, dM = delta.m || 0, dY = delta.y || 0, dK = delta.k || 0;

  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const k = 1 - Math.max(r, g, b);
    let c, m, y;
    if (k >= 1) {
      c = 0; m = 0; y = 0;
    } else {
      c = (1 - r - k) / (1 - k);
      m = (1 - g - k) / (1 - k);
      y = (1 - b - k) / (1 - k);
    }
    const c2 = Math.min(1, Math.max(0, c + dC));
    const m2 = Math.min(1, Math.max(0, m + dM));
    const y2 = Math.min(1, Math.max(0, y + dY));
    const k2 = Math.min(1, Math.max(0, k + dK));
    data[i] = Math.round(255 * (1 - c2) * (1 - k2));
    data[i + 1] = Math.round(255 * (1 - m2) * (1 - k2));
    data[i + 2] = Math.round(255 * (1 - y2) * (1 - k2));
  }

  return sharp(data, { raw: info }).png().toBuffer();
}

// Haalt een foto op, snijdt 'm bij tot een VIERKANT (cover-fit — vult altijd
// het hele vak, i.t.t. embedPhoto's contain-fit dat de eigen beeldverhouding
// behoudt), past dezelfde print-kleurbalans-correctie toe, en rondt de hoeken
// af (echte alpha-transparantie in de hoeken, geen wit vlak). Gebruikt voor
// het Sound-Frame-product, waar de foto altijd als afgerond vierkant kaartje
// wordt getoond.
async function embedPhotoRounded(doc, photoUrl, filterValue, targetSizeMm, cornerRadiusMm) {
  const imgRes = await axios.get(photoUrl, { responseType: 'arraybuffer' });
  let pipeline = sharp(Buffer.from(imgRes.data)).rotate(); // EXIF-rotatie vast "bakken"

  const filter = (filterValue || '').toLowerCase();
  if (filter.includes('zwart') || filter.includes('grijs') || filter.includes('black') || filter.includes('white')) {
    pipeline = pipeline.grayscale();
  }
  const rotatedBuffer = await pipeline.toBuffer();

  const targetPx = Math.round((targetSizeMm / 25.4) * 300);
  const vierkantBuffer = await sharp(rotatedBuffer)
    .resize(targetPx, targetPx, { fit: 'cover', position: 'centre' })
    .toBuffer();

  // Zelfde Y+8%-correctie als embedPhoto (zie adjustCmykChannels hierboven
  // voor de uitgebreide toelichting waarom precies 8%).
  const gecorrigeerdBuffer = await adjustCmykChannelsToPng(vierkantBuffer, { c: 0, m: 0, y: 0.08, k: 0 });

  const radiusPx = Math.round((cornerRadiusMm / 25.4) * 300);
  const maskSvg = `<svg width="${targetPx}" height="${targetPx}"><rect x="0" y="0" width="${targetPx}" height="${targetPx}" rx="${radiusPx}" ry="${radiusPx}" fill="white"/></svg>`;
  const maskBuffer = await sharp(Buffer.from(maskSvg)).png().toBuffer();
  const afgerondBuffer = await sharp(gecorrigeerdBuffer)
    .composite([{ input: maskBuffer, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const image = await doc.embedPng(afgerondBuffer);
  return { image };
}

// Laadt een Hebreeuws lettertype (indien aanwezig) voor gebruik in
// drawMixedText/fitFontSizeToWidth/measureMixedTextWidth hierboven — Latijnse
// lettertypen zoals Montserrat hebben geen Hebreeuwse glyphs. Geeft `null`
// terug (met een duidelijke waarschuwing) als het bestand nog ontbreekt, dan
// valt de tekst terug op het gewone lettertype (geen Hebreeuwse tekens
// zichtbaar, maar ook geen stilzwijgend wegvallende cursor-positie meer zoals
// vóór deze fix). `gewicht` is 'Regular' of 'Bold'.
async function loadHebrewFont(doc, gewicht = 'Regular') {
  const bestandsnaam = `NotoSansHebrew-${gewicht}.ttf`;
  const bestandsPad = path.join(__dirname, 'fonts', bestandsnaam);
  if (!fs.existsSync(bestandsPad)) {
    console.warn(`[pdf-shared] ${bestandsnaam} niet gevonden in server/fonts/ — Hebreeuwse tekst kan niet getekend worden (blijft leeg i.p.v. verkeerd lettertype). Zie README voor hoe je het toevoegt.`);
    return null;
  }
  return doc.embedFont(fs.readFileSync(bestandsPad));
}

module.exports = {
  MM,
  splitTextEmoji, emojiToCodepoints, fetchEmojiPng, preloadEmojiImages,
  measureMixedTextWidth, drawMixedText, fitFontSizeToWidth, loadHebrewFont,
  embedPhoto, fitPhotoInSquareZone, recolorDarkPixels, recolorLightPixels, getCodeSvg,
  drawBackground, isMarbleBackground, hasPageBackground, nearWhiteCmyk, adjustCmykChannels,
  extractSvgShapes, drawSvgShapesInBox, embedPhotoRounded, voorkomLigatuurGaten
};
