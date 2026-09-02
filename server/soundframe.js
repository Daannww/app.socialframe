const { PDFDocument, rgb, cmyk, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const {
  MM, splitTextEmoji, preloadEmojiImages, measureMixedTextWidth, drawMixedText,
  fitFontSizeToWidth, embedPhotoRounded, nearWhiteCmyk
} = require('./pdf-shared');
// Hergebruikt de bestaande vector-iconen (shuffle/vorige/afspelen/volgende/
// herhalen) van het muziekframe — i.p.v. de kant-en-aangeleverde raster-
// overlay, voor scherpere printkwaliteit op elke resolutie.
const iconPaths = require('./musicframe-paths');

const PAGE_W_MM = 100;
const PAGE_H_MM = 100;

const COLOR_BLACK = rgb(0, 0, 0);
const COLOR_WHITE = nearWhiteCmyk(cmyk); // 1%-gele CMYK-truc, net als de rest van het project

// --- Alle posities hieronder zijn 1-op-1 opgemeten uit het door de klant
// aangeleverde referentiebestand (zie de opmeet-sessie in de chat) — een
// 1000x1000pt-PDF die exact 100x100mm voorstelt (dus 1pt = 0.1mm, geen
// standaard 72dpi-conversie zoals bij de Illustrator-bestanden). ---

// Het "kaartje" (foto + overlay) — vierkant, afgeronde hoeken, gecentreerd
// op de tegel met witruimte eromheen (dus NIET beeldvullend).
const KAART_X_MM = 18.3;
const KAART_TOP_MM = 19.15;
const KAART_SIZE_MM = 63.5;
const KAART_RADIUS_MM = 3;

// Tijdlijnbalk: horizontaal bereik afgeleid van de overlay-afbeelding se
// eigen, interne verhoudingen (10.15%-89.17% van het kaartje), verticaal
// gecentreerd rond 74.2% van de kaartje-hoogte.
const TIJDLIJN_LINKS_MM = KAART_X_MM + 0.1015 * KAART_SIZE_MM;
const TIJDLIJN_RECHTS_MM = KAART_X_MM + 0.8917 * KAART_SIZE_MM;
const TIJDLIJN_TOP_MM = KAART_TOP_MM + 0.742 * KAART_SIZE_MM;
const BOLLETJE_DIAMETER_MM = 3.5;

// --- Afspeelknoppen-rij: hergebruikt de bestaande vector-iconen van het
// muziekframe (musicframe-paths.js), herschaald om in het veel kleinere
// Sound-Frame-kaartje te passen. REFERENTIE_* is de linkerboven-hoek van die
// iconrij zoals gemeten in het muziekframe se EIGEN 200x300mm-canvas; ICOON_
// SCHAAL is experimenteel bepaald zodat de herschaalde rij dezelfde relatieve
// breedte inneemt als de oorspronkelijk aangeleverde raster-overlay
// (10.15%-89.17% van het kaartje, zie hierboven).
const ICOON_REFERENTIE_X_MM = 18.777;
const ICOON_REFERENTIE_TOP_MM = 237.8;
const ICOON_SCHAAL = 0.3085;
// Iconrij verticaal gepositioneerd t.o.v. de tijdlijnbalk (net onder de balk,
// net als bij het muziekframe) — TIJDLIJN_TOP_MM is het MIDDEN van de balk.
const ICOON_RIJ_TOP_MM = TIJDLIJN_TOP_MM + 3.2;

function fromTopMm(topMm) {
  return (PAGE_H_MM - topMm) * MM;
}

// Tekent 1 icoon-pad uit musicframe-paths.js, herschaald en herpositioneerd
// voor het Sound-Frame-kaartje. LET OP: musicframe.js se eigen drawIconPath
// past GEEN schaal toe (icoon-paden staan daar al op de juiste, uiteindelijke
// grootte) — hier dus wél, via de ICOON_SCHAAL-factor hierboven.
function drawScaledIcon(page, pathInfo, color) {
  const xMm = KAART_X_MM + (0.1015 * KAART_SIZE_MM) + (pathInfo.pageXMm - ICOON_REFERENTIE_X_MM) * ICOON_SCHAAL;
  const topMm = ICOON_RIJ_TOP_MM + (pathInfo.pageTopMm - ICOON_REFERENTIE_TOP_MM) * ICOON_SCHAAL;
  page.drawSvgPath(pathInfo.d, {
    x: xMm * MM,
    y: fromTopMm(topMm),
    scale: ICOON_SCHAAL,
    color
  });
}

function isSoundFrameLineItem(li) {
  return /sound[\s-]?frame/i.test(li.title || '');
}

// Zelfde aanpak als extractMusicFrameData in musicframe.js — matcht op
// kernwoorden i.p.v. exacte vraagtekst, want de nummering/formulering in
// Shopify kan licht variëren.
function extractSoundFrameData(li) {
  const props = li.properties || [];
  const getProp = (regex) => {
    const p = props.find(p => regex.test(p.name || ''));
    return p ? String(p.value || '').trim() : '';
  };

  return {
    style: getProp(/stijl van jouw socialframe/i),
    fotoFilter: getProp(/foto-?filter/i),
    hartjeKleur: getProp(/kleur van het hartje/i),
    regel1: getProp(/\bregel\s*1\b/i),
    regel2: getProp(/\bregel\s*2\b/i),
    begintijd: getProp(/begintijd/i),
    eindtijd: getProp(/eindtijd/i),
    bolletjePositie: getProp(/positie\s*bolletje/i),
    photoUrl: getProp(/upload hier jouw favoriete foto/i)
  };
}

function extractSoundFrameItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    if (!isSoundFrameLineItem(li)) return;
    const data = extractSoundFrameData(li);
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, data });
    }
  });
  return items;
}

// Stijl: alleen "Zwart"/"Wit" (geen QR-/Spotify-code-varianten zoals bij het
// muziekframe) — bepaalt zowel de tekstkleur als welke overlay-afbeelding
// (zwarte of witte iconen) gebruikt wordt.
function parseStyle(styleText) {
  const t = (styleText || '').toLowerCase();
  const isWhite = t.includes('wit');
  return { color: isWhite ? COLOR_WHITE : COLOR_BLACK, isWhite };
}

function parseHeartColor(value) {
  const t = (value || '').toLowerCase();
  if (!t || t.includes('geen')) return null;
  if (t.includes('rood')) return [227, 6, 19]; // exact overgenomen uit het referentiebestand
  if (t.includes('zwart')) return [0, 0, 0];
  if (t.includes('wit')) return [255, 255, 253]; // 1%-gele-truc-equivalent in RGB
  return [227, 6, 19]; // onbekende waarde: rood is de enige geziene optie, dus dat als redelijke standaard
}

function parsePercent(value, fallback) {
  if (!value) return fallback;
  const match = String(value).match(/(\d+(\.\d+)?)/);
  return match ? Math.max(0, Math.min(100, parseFloat(match[1]))) : fallback;
}

// Bouwt een ingekleurde versie van het hart-icoon: het opgeslagen alfamasker
// (de vorm, uit het referentiebestand gehaald als grijswaarden-luminantie-
// masker — dezelfde techniek als een PDF-SMask) gecombineerd met een egale
// vlakkleur. LET OP: dit is GEEN normaal alfakanaal, dus we voegen het via
// joinChannel expliciet als 4e (alfa-)kanaal toe — sharp's composite/dest-in
// verwacht een al-aanwezig alfakanaal en zou een grijswaardenbeeld anders als
// volledig ondoorzichtig behandelen (geen enkele maskering).
async function maakIngekleurdHart(kleurRgb255) {
  const maskerPad = path.join(__dirname, 'soundframe-assets', 'hart-masker.png');
  const { width, height } = await sharp(maskerPad).metadata();
  const vlakRaw = await sharp({
    create: { width, height, channels: 3, background: kleurRgb255 }
  }).raw().toBuffer();
  const maskerRaw = await sharp(maskerPad).greyscale().raw().toBuffer();
  return sharp(vlakRaw, { raw: { width, height, channels: 3 } })
    .joinChannel(maskerRaw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

async function generateSoundFramePdf(data) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([PAGE_W_MM * MM, PAGE_H_MM * MM]);

  const { color: styleColor, isWhite } = parseStyle(data.style);

  // --- Foto: vierkant (cover-fit, dus altijd het hele kaartje vullend),
  // afgeronde hoeken, met dezelfde print-kleurbalans-correctie als de andere
  // producten (voorkomt #FFFFFF-"gaten" bij het printen). ---
  if (data.photoUrl) {
    const { image } = await embedPhotoRounded(doc, data.photoUrl, data.fotoFilter, KAART_SIZE_MM, KAART_RADIUS_MM);
    page.drawImage(image, {
      x: KAART_X_MM * MM,
      y: fromTopMm(KAART_TOP_MM + KAART_SIZE_MM),
      width: KAART_SIZE_MM * MM,
      height: KAART_SIZE_MM * MM
    });
  }

  // --- Overlay (tijdlijnbalk + afspeelknoppen-rij): als ECHTE vectorvormen
  // getekend (hergebruik van musicframe-paths.js), i.p.v. de aangeleverde
  // raster-overlay — scherper op elke printresolutie. Kleur volgt de
  // gekozen stijl (zwart/wit), net als de tekst. ---
  const timelineWidthMm = TIJDLIJN_RECHTS_MM - TIJDLIJN_LINKS_MM;
  const timelineScale = timelineWidthMm / iconPaths.timeline_bar.widthMm;
  page.drawSvgPath(iconPaths.timeline_bar.d, {
    x: TIJDLIJN_LINKS_MM * MM,
    y: fromTopMm(TIJDLIJN_TOP_MM),
    scale: timelineScale,
    color: styleColor
  });

  ['shuffle_1', 'shuffle_2', 'shuffle_3', 'prev', 'next', 'repeat_1', 'repeat_2']
    .forEach(naam => drawScaledIcon(page, iconPaths[naam], styleColor));

  // Play-knop: VOLLEDIG GEVULDE cirkel (i.t.t. muziekframe se open ring-
  // vormige play_circle-pad) — zo staat het in het Sound-Frame-
  // referentiebestand. Het driehoekje erin krijgt de TEGENOVERGESTELDE
  // kleur, anders zou het niet zichtbaar zijn tegen de gevulde cirkel.
  const playCenterXMm = KAART_X_MM + (0.1015 * KAART_SIZE_MM) +
    (iconPaths.play_circle.pageXMm + iconPaths.play_circle.widthMm / 2 - ICOON_REFERENTIE_X_MM) * ICOON_SCHAAL;
  const playCenterTopMm = ICOON_RIJ_TOP_MM +
    (iconPaths.play_circle.pageTopMm + iconPaths.play_circle.heightMm / 2 - ICOON_REFERENTIE_TOP_MM) * ICOON_SCHAAL;
  const playRadiusMm = (iconPaths.play_circle.widthMm / 2) * ICOON_SCHAAL;
  page.drawCircle({
    x: playCenterXMm * MM,
    y: fromTopMm(playCenterTopMm),
    size: playRadiusMm * MM,
    color: styleColor
  });
  drawScaledIcon(page, iconPaths.play_triangle, isWhite ? COLOR_BLACK : COLOR_WHITE);

  // --- Fonts: Montserrat (al aanwezig, zelfde bestanden als muziekframe) ---
  const fontsDir = path.join(__dirname, 'fonts');
  const regularPath = path.join(fontsDir, 'Montserrat-Regular.ttf');
  const boldPath = path.join(fontsDir, 'Montserrat-Bold.ttf');
  let fontRegular, fontBold;
  if (fs.existsSync(regularPath) && fs.existsSync(boldPath)) {
    fontRegular = await doc.embedFont(fs.readFileSync(regularPath));
    fontBold = await doc.embedFont(fs.readFileSync(boldPath));
  } else {
    console.warn('[soundframe] Montserrat-lettertypen niet gevonden in server/fonts/ — val terug op Helvetica.');
    fontRegular = await doc.embedFont(StandardFonts.Helvetica);
    fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  }

  const emojiCache = await preloadEmojiImages(doc, [data.regel1, data.regel2, data.begintijd, data.eindtijd]);

  // --- Regel 1 (titel, bold) / Regel 2 (artiest, regular) — mogen nooit
  // onder het hartje doorlopen, dus max-breedte tot 3mm ervoor, met
  // automatisch verkleinen (net als bij het muziekframe) als vangnet. ---
  const heartLeftEdgeMm = 68.19;
  const textStartXMm = 25.14;
  const textMaxWidthMm = heartLeftEdgeMm - 3 - textStartXMm;
  const textMaxWidthPt = textMaxWidthMm * MM;

  if (data.regel1) {
    const parts = splitTextEmoji(data.regel1);
    const size = fitFontSizeToWidth(parts, fontBold, 2.93 * MM, textMaxWidthPt);
    drawMixedText(page, parts, fontBold, size, textStartXMm * MM, fromTopMm(60.10) - size * 0.75, styleColor, emojiCache);
  }
  if (data.regel2) {
    const parts = splitTextEmoji(data.regel2);
    const size = fitFontSizeToWidth(parts, fontRegular, 2.53 * MM, textMaxWidthPt);
    drawMixedText(page, parts, fontRegular, size, textStartXMm * MM, fromTopMm(63.54) - size * 0.75, styleColor, emojiCache);
  }

  // --- Hartje (optioneel — weglaten als "geen" gekozen) — als echte,
  // ingekleurde hartvorm (uit het referentiebestand gehaald), niet als
  // benaderende cirkel. ---
  const heartRgb = parseHeartColor(data.hartjeKleur);
  if (heartRgb) {
    const heartSizeMm = 8.1;
    const heartPngBuffer = await maakIngekleurdHart({ r: heartRgb[0], g: heartRgb[1], b: heartRgb[2] });
    const heartImage = await doc.embedPng(heartPngBuffer);
    page.drawImage(heartImage, {
      x: heartLeftEdgeMm * MM,
      y: fromTopMm(58.29 + heartSizeMm),
      width: heartSizeMm * MM,
      height: heartSizeMm * MM
    });
  }

  // --- Bolletje op de tijdlijn: ALTIJD zichtbaar (de balk zelf zit al in de
  // overlay-afbeelding hierboven), positie 0-100% net als bij het
  // muziekframe, standaard 20% als niet ingevuld. ---
  const dotPercent = parsePercent(data.bolletjePositie, 20);
  const dotCenterXMm = TIJDLIJN_LINKS_MM + (TIJDLIJN_RECHTS_MM - TIJDLIJN_LINKS_MM) * dotPercent / 100;
  page.drawCircle({
    x: dotCenterXMm * MM,
    y: fromTopMm(TIJDLIJN_TOP_MM),
    size: (BOLLETJE_DIAMETER_MM / 2) * MM,
    color: styleColor
  });

  // --- Tijd-labels (Begintijd links, Eindtijd rechts van de tijdlijn) —
  // allebei optioneel, onafhankelijk van elkaar. ---
  const tijdLabelMaxWidthPt = 25 * MM;
  if (data.begintijd) {
    const parts = splitTextEmoji(data.begintijd);
    const size = fitFontSizeToWidth(parts, fontBold, 1.6 * MM, tijdLabelMaxWidthPt, 6);
    drawMixedText(page, parts, fontBold, size, TIJDLIJN_LINKS_MM * MM, fromTopMm(68.10) - size * 0.75, styleColor, emojiCache);
  }
  if (data.eindtijd) {
    const parts = splitTextEmoji(data.eindtijd);
    const size = fitFontSizeToWidth(parts, fontBold, 1.6 * MM, tijdLabelMaxWidthPt, 6);
    const totalWidthPt = measureMixedTextWidth(parts, fontBold, size);
    const xPt = TIJDLIJN_RECHTS_MM * MM - totalWidthPt;
    drawMixedText(page, parts, fontBold, size, xPt, fromTopMm(68.10) - size * 0.75, styleColor, emojiCache);
  }

  return doc.save();
}

module.exports = {
  generateSoundFramePdf, isSoundFrameLineItem, extractSoundFrameData,
  extractSoundFrameItemsFromOrder, parseStyle, parseHeartColor, parsePercent
};
