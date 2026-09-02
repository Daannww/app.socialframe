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
const RGB255_BLACK = [0, 0, 0];
const RGB255_WHITE = [255, 255, 253];

// --- Het "kaartje" (foto + overlay) vult nu de VOLLEDIGE 100x100mm tegel —
// het referentiebestand bleek een gestileerde preview te zijn (kleiner
// kaartje met witruimte eromheen, voor social-media-gebruik), niet een
// drukklaar 1-op-1-bestand. Alle overige posities hieronder zijn daarom
// PROPORTIONEEL herschaald (t.o.v. het oorspronkelijk gemeten 63.5mm-
// kaartje) i.p.v. simpelweg de oude mm-waarden te hergebruiken. ---
const KAART_X_MM = 0;
const KAART_TOP_MM = 0;
const KAART_SIZE_MM = 100;
const KAART_RADIUS_MM = 4.724;

// Tijdlijnbalk: horizontaal bereik afgeleid van de overlay-afbeelding se
// eigen, interne verhoudingen (10.15%-89.17% van het kaartje), verticaal
// gecentreerd rond 74.2% van de kaartje-hoogte — deze formule schaalt vanzelf
// mee met KAART_X_MM/KAART_SIZE_MM hierboven.
const TIJDLIJN_LINKS_MM = KAART_X_MM + 0.1015 * KAART_SIZE_MM;
const TIJDLIJN_RECHTS_MM = KAART_X_MM + 0.8917 * KAART_SIZE_MM;
// TIJDLIJN_TOP_MM is de BOVENKANT van de balk (drawSvgPath se anker-punt is
// de top van het pad, niet het midden) — TIJDLIJN_MIDDEN_MM hieronder is het
// écht verticale midden van de balk, en is wat het bolletje moet gebruiken
// om precies gecentreerd te staan (eerder stond het bolletje per ongeluk op
// TIJDLIJN_TOP_MM zelf, dus zichtbaar iets te hoog t.o.v. de balk).
const TIJDLIJN_TOP_MM = KAART_TOP_MM + 0.742 * KAART_SIZE_MM;
const BOLLETJE_DIAMETER_MM = 2.3;

// --- Afspeelknoppen-rij: hergebruikt de bestaande vector-iconen van het
// muziekframe (musicframe-paths.js), herschaald om in het Sound-Frame-
// kaartje te passen. REFERENTIE_* is de linkerboven-hoek van die iconrij
// zoals gemeten in het muziekframe se EIGEN 200x300mm-canvas; ICOON_SCHAAL
// is experimenteel bepaald zodat de herschaalde rij dezelfde relatieve
// breedte inneemt als de oorspronkelijk aangeleverde raster-overlay. ---
const ICOON_REFERENTIE_X_MM = 18.777;
const ICOON_REFERENTIE_TOP_MM = 237.8;
const ICOON_SCHAAL = 0.48581;
// Iconrij verticaal gepositioneerd t.o.v. de tijdlijnbalk (net onder de
// balk, net als bij het muziekframe) — TIJDLIJN_TOP_MM is het MIDDEN van de balk.
const ICOON_RIJ_TOP_MM = TIJDLIJN_TOP_MM + 5.039;

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
// muziekframe) — bepaalt zowel de tekstkleur als de kleur van de play-knop.
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

// Bouwt de play-knop als een gevulde cirkel MET EEN ECHT GAT in de vorm van
// het driehoekje — dus geen ondoorzichtig driehoekje erbovenop getekend,
// maar een uitsparing waar de foto (of wat er verder onder zit) gewoon
// doorheen zichtbaar blijft. Gebruikt SVG se fill-rule="evenodd": een punt
// dat binnen ZOWEL de cirkel als het (erin geneste) driehoekje valt, telt als
// "even" aantal overlappende vormen en blijft dus ongevuld — precies het
// gewenste gat-effect. Sharp/librsvg rendert dat als echte alfa-transparantie
// in de uitvoer-PNG (dus geen kwestie van "witte" of "zwarte" vulling, maar
// oprecht doorzichtig).
async function maakPlayknopMetGat(kleurRgb255, pixelGrootte) {
  const R = 45.4121; // straal, in dezelfde eenheden als musicframe-paths.js se eigen (punt-gebaseerde) iconen
  const cirkelPad = `M ${R},0 A ${R},${R} 0 1,1 ${R},${2 * R} A ${R},${R} 0 1,1 ${R},0 Z`;
  // Driehoekje van musicframe-paths.js se play_triangle, verschoven naar zijn
  // relatieve positie BINNEN de cirkel (zelfde relatieve plek als in het
  // muziekframe se eigen 200x300mm-canvas).
  const driehoekPad = 'M 62.7075,45.408 L 34.27,28.99 L 34.27,61.8298 Z';
  const [r, g, b] = kleurRgb255;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${2 * R}" height="${2 * R}" viewBox="0 0 ${2 * R} ${2 * R}">
    <path fill-rule="evenodd" fill="rgb(${r},${g},${b})" d="${cirkelPad} ${driehoekPad}"/>
  </svg>`;
  return sharp(Buffer.from(svg))
    .resize(pixelGrootte, pixelGrootte)
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
  // getekend (hergebruik van musicframe-paths.js). Kleur volgt de gekozen
  // stijl (zwart/wit), net als de tekst. ---
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

  // Play-knop: gevulde cirkel MET EEN ECHT TRANSPARANT GAT voor het
  // driehoekje (zie maakPlayknopMetGat hierboven) — dus niet een ondoorzichtig
  // driehoekje erbovenop, maar een uitsparing waar de foto doorheen schijnt.
  const playCenterXMm = KAART_X_MM + (0.1015 * KAART_SIZE_MM) +
    (iconPaths.play_circle.pageXMm + iconPaths.play_circle.widthMm / 2 - ICOON_REFERENTIE_X_MM) * ICOON_SCHAAL;
  const playCenterTopMm = ICOON_RIJ_TOP_MM +
    (iconPaths.play_circle.pageTopMm + iconPaths.play_circle.heightMm / 2 - ICOON_REFERENTIE_TOP_MM) * ICOON_SCHAAL;
  const playDiameterMm = iconPaths.play_circle.widthMm * ICOON_SCHAAL;
  const playPixelGrootte = Math.round((playDiameterMm / 25.4) * 300); // 300dpi
  const playKnopKleur = isWhite ? RGB255_WHITE : RGB255_BLACK;
  const playKnopPngBuffer = await maakPlayknopMetGat(playKnopKleur, playPixelGrootte);
  const playKnopImage = await doc.embedPng(playKnopPngBuffer);
  page.drawImage(playKnopImage, {
    x: (playCenterXMm - playDiameterMm / 2) * MM,
    y: fromTopMm(playCenterTopMm + playDiameterMm / 2),
    width: playDiameterMm * MM,
    height: playDiameterMm * MM
  });

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
  // onder het hartje doorlopen, dus max-breedte tot een marge ervoor, met
  // automatisch verkleinen (net als bij het muziekframe) als vangnet. ---
  const heartLeftEdgeMm = 78.567;
  const textStartXMm = 10.772;
  const textMaxWidthMm = heartLeftEdgeMm - 4.724 - textStartXMm;
  const textMaxWidthPt = textMaxWidthMm * MM;

  if (data.regel1) {
    const parts = splitTextEmoji(data.regel1);
    const size = fitFontSizeToWidth(parts, fontBold, 4.614 * MM, textMaxWidthPt);
    drawMixedText(page, parts, fontBold, size, textStartXMm * MM, fromTopMm(64.488) - size * 0.75, styleColor, emojiCache);
  }
  if (data.regel2) {
    const parts = splitTextEmoji(data.regel2);
    const size = fitFontSizeToWidth(parts, fontRegular, 3.984 * MM, textMaxWidthPt);
    drawMixedText(page, parts, fontRegular, size, textStartXMm * MM, fromTopMm(69.906) - size * 0.75, styleColor, emojiCache);
  }

  // --- Hartje (optioneel — weglaten als "geen" gekozen) — als echte,
  // ingekleurde hartvorm (uit het referentiebestand gehaald), niet als
  // benaderende cirkel. ---
  const heartRgb = parseHeartColor(data.hartjeKleur);
  if (heartRgb) {
    const heartSizeMm = 12.756;
    const heartPngBuffer = await maakIngekleurdHart({ r: heartRgb[0], g: heartRgb[1], b: heartRgb[2] });
    const heartImage = await doc.embedPng(heartPngBuffer);
    page.drawImage(heartImage, {
      x: heartLeftEdgeMm * MM,
      y: fromTopMm(61.638 + heartSizeMm),
      width: heartSizeMm * MM,
      height: heartSizeMm * MM
    });
  }

  // --- Bolletje op de tijdlijn: ALTIJD zichtbaar, positie 0-100% net als bij
  // het muziekframe, standaard 20% als niet ingevuld. Verticaal gecentreerd
  // op het ECHTE midden van de balk (TIJDLIJN_TOP_MM is de bovenkant van de
  // balk, dus + de helft van de geschaalde balkhoogte). ---
  const timelineBarHeightMm = iconPaths.timeline_bar.heightMm * timelineScale;
  const tijdlijnMiddenMm = TIJDLIJN_TOP_MM + timelineBarHeightMm / 2;
  const dotPercent = parsePercent(data.bolletjePositie, 20);
  const dotCenterXMm = TIJDLIJN_LINKS_MM + (TIJDLIJN_RECHTS_MM - TIJDLIJN_LINKS_MM) * dotPercent / 100;
  page.drawCircle({
    x: dotCenterXMm * MM,
    y: fromTopMm(tijdlijnMiddenMm),
    size: (BOLLETJE_DIAMETER_MM / 2) * MM,
    color: styleColor
  });

  // --- Tijd-labels (Begintijd links, Eindtijd rechts van de tijdlijn) —
  // allebei optioneel, onafhankelijk van elkaar. ---
  const tijdLabelMaxWidthPt = 40 * MM;
  if (data.begintijd) {
    const parts = splitTextEmoji(data.begintijd);
    const size = fitFontSizeToWidth(parts, fontBold, 2.52 * MM, tijdLabelMaxWidthPt, 6);
    drawMixedText(page, parts, fontBold, size, TIJDLIJN_LINKS_MM * MM, fromTopMm(77.087) - size * 0.75, styleColor, emojiCache);
  }
  if (data.eindtijd) {
    const parts = splitTextEmoji(data.eindtijd);
    const size = fitFontSizeToWidth(parts, fontBold, 2.52 * MM, tijdLabelMaxWidthPt, 6);
    const totalWidthPt = measureMixedTextWidth(parts, fontBold, size);
    const xPt = TIJDLIJN_RECHTS_MM * MM - totalWidthPt;
    drawMixedText(page, parts, fontBold, size, xPt, fromTopMm(77.087) - size * 0.75, styleColor, emojiCache);
  }

  return doc.save();
}

module.exports = {
  generateSoundFramePdf, isSoundFrameLineItem, extractSoundFrameData,
  extractSoundFrameItemsFromOrder, parseStyle, parseHeartColor, parsePercent
};
