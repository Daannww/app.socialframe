const { PDFDocument, rgb, cmyk } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const {
  MM, splitTextEmoji, preloadEmojiImages, drawMixedText, fitFontSizeToWidth,
  measureMixedTextWidth, embedPhoto, fitPhotoInSquareZone, recolorDarkPixels, getCodeSvg,
  drawBackground, isMarbleBackground, nearWhiteCmyk
} = require('./pdf-shared');

const PAGE_W_MM = 200;
const PAGE_H_MM = 300;

const COLOR_BLACK = rgb(0, 0, 0);
const COLOR_WHITE = rgb(1, 1, 253 / 255); // #fffffd — consistent met het muziekframe
const COLOR_CODE_BACKGROUND = rgb(1, 1, 1);

// --- Alle posities hieronder zijn 1-op-1 gemeten uit het door de klant
// aangeleverde referentiebestand "Autoframe.pdf" (2 pagina's: zonder en met
// QR-code) — zie de opmeet-sessie in de chat voor hoe deze tot stand kwamen. ---

const PHOTO_ZONE = { xMm: 17.5, topMm: 14.01, sizeMm: 165 };

// De titel ("Merk & type auto") staat gecentreerd op de plaat: horizontaal in
// het midden van de pagina, verticaal in het midden van de ruimte tussen de
// foto en de eerste veld-regel eronder (die ruimte verschilt per layout, dus
// dit wordt telkens opnieuw berekend — zie renderTitle hieronder). De
// max-breedte is gelijk aan de fotobreedte: wordt de tekst te lang, dan
// krimpt het lettertype, in plaats van breder dan de foto te worden.
const TITLE = {
  fontSizePt: 45.35,
  maxWidthMm: PHOTO_ZONE.sizeMm,
  // Verhouding basislijn-vanaf-boven t.o.v. de tekstblok-hoogte, gemeten uit
  // het referentiebestand (11.71mm basislijn-offset op een blok van 16mm).
  baselineRatio: 0.732
};

const LABEL_FONT_SIZE_PT = 20;
// Basislijn-offset t.o.v. de "top" van elk veld, gemeten als constante
// verhouding (~0.73x fontgrootte) — zelfde voor elk label, ongeacht layout.
const LABEL_BASELINE_OFFSET_MM = 5.15;

// Layout ZONDER QR-code: 2 kolommen van elk 2 velden, verticale lijn in het midden.
const LAYOUT_NO_QR = {
  divider: { xMm: 100, topMm: 239.72, bottomMm: 265.77, widthMm: 2.02 },
  fields: {
    motor:    { labelXMm: 38.19, labelTopMm: 243.98, iconXMm: 22.18, iconTopMm: 242.19, iconWMm: 11.43, iconHMm: 9.78, maxWidthMm: 59 },
    pk:       { labelXMm: 37.82, labelTopMm: 256.08, iconXMm: 22.48, iconTopMm: 254.21, iconWMm: 10.96, iconHMm: 9.99, maxWidthMm: 59 },
    snelheid: { labelXMm: 135.76, labelTopMm: 243.96, iconXMm: 121.71, iconTopMm: 243.42, iconWMm: 9.02, iconHMm: 7.32, maxWidthMm: 49 },
    naam:     { labelXMm: 135.76, labelTopMm: 255.63, iconXMm: 122.56, iconTopMm: 254.30, iconWMm: 7.32, iconHMm: 8.89, maxWidthMm: 49 }
  }
};

// Layout MET QR-code: alle 4 velden in 1 kolom, QR-code rechts ernaast.
const LAYOUT_QR = {
  divider: { xMm: 105.46, topMm: 224.58, bottomMm: 272.58, widthMm: 2.0 },
  qrBox: { xMm: 123.65, topMm: 226.08, sizeMm: 45 },
  fields: {
    motor:    { labelXMm: 40.9, labelTopMm: 228.97, iconXMm: 25.10, iconTopMm: 227.16, iconWMm: 11.43, iconHMm: 9.82, maxWidthMm: 61 },
    pk:       { labelXMm: 40.9, labelTopMm: 241.07, iconXMm: 25.40, iconTopMm: 239.18, iconWMm: 10.96, iconHMm: 9.78, maxWidthMm: 61 },
    snelheid: { labelXMm: 40.9, labelTopMm: 253.09, iconXMm: 26.33, iconTopMm: 252.56, iconWMm: 8.97, iconHMm: 7.28, maxWidthMm: 61 },
    naam:     { labelXMm: 40.9, labelTopMm: 265.46, iconXMm: 26.92, iconTopMm: 263.44, iconWMm: 7.37, iconHMm: 8.89, maxWidthMm: 61 }
  }
};

// Herkent of een productregel een Auto-frame is.
function isAutoFrameLineItem(li) {
  return /auto-?frame/i.test(li.title || '');
}

// Haalt de door de klant ingevulde velden uit de properties van 1 productregel.
function extractAutoFrameData(li) {
  const props = li.properties || [];
  const getProp = (regex) => {
    const p = props.find(p => regex.test(p.name || ''));
    return p ? String(p.value || '').trim() : '';
  };

  return {
    style: getProp(/stijl van jouw/i),
    link: getProp(/link naar/i),
    fotoFilter: getProp(/foto-?filter/i),
    achtergrondKleur: getProp(/achtergrond\s*kleur/i),
    titel: getProp(/merk en type auto|merk\s*\/?\s*type/i),
    motor: getProp(/\bmotor\b/i),
    pk: getProp(/\bpk\b/i),
    snelheid: getProp(/snelheid/i),
    naam: getProp(/\bnaam\b/i),
    photoUrl: getProp(/upload hier jouw favoriete foto|kies jouw foto/i)
  };
}

// Zoekt in een volledige (raw) Shopify-order naar Auto-frame productregels,
// en geeft voor elk besteld exemplaar (quantity) een los item terug.
function extractAutoFrameItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    if (!isAutoFrameLineItem(li)) return;
    const data = extractAutoFrameData(li);
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, data });
    }
  });
  return items;
}

function parseStyle(styleText) {
  const t = (styleText || '').toLowerCase();
  const isWhite = t.includes('wit');
  // "zonder" heeft altijd voorrang — voorkomt dat "... zonder QR-code" per
  // ongeluk als "heeft QR-code" gelezen wordt (bevat toch echt het woord "qr").
  const hasCode = t.includes('qr') && !t.includes('zonder');
  return { color: isWhite ? COLOR_WHITE : COLOR_BLACK, isWhite, hasCode };
}

function fromTopMmFactory(pageHeightMm) {
  return (topMm) => (pageHeightMm - topMm) * MM;
}

/**
 * Bouwt het complete Auto-frame drukwerkbestand (200x300mm PDF).
 * `data` bevat de door de klant ingevulde velden (zie extractAutoFrameData):
 *   { style, link, fotoFilter, achtergrondKleur,
 *     titel, motor, pk, snelheid, naam, photoUrl }
 */
async function generateAutoFramePdf(data) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W_MM * MM, PAGE_H_MM * MM]);
  const fromTopMm = fromTopMmFactory(PAGE_H_MM);

  const { color: styleColor, isWhite, hasCode } = parseStyle(data.style);
  const layout = hasCode ? LAYOUT_QR : LAYOUT_NO_QR;

  // Achtergrondkleur: "Wit" (1% geel-truc), "Zwart" (diepzwart), "Marmerwit"/
  // "Marmerzwart" (echte textuur), of niets bij "Transparant" / onbekend.
  await drawBackground(doc, page, data.achtergrondKleur, PAGE_W_MM, PAGE_H_MM, cmyk, rgb);

  // --- Foto (past binnen een vak van 165x165mm, met de EIGEN beeldverhouding
  // behouden — zelfde protocol als het muziekframe.) ---
  if (data.photoUrl) {
    const { image: jpegImage, aspectRatio } = await embedPhoto(doc, data.photoUrl, data.fotoFilter, PHOTO_ZONE.sizeMm);
    const { renderWidthMm, renderHeightMm, renderXMm, renderTopMm } =
      fitPhotoInSquareZone(aspectRatio, PHOTO_ZONE.xMm, PHOTO_ZONE.topMm, PHOTO_ZONE.sizeMm);

    page.drawImage(jpegImage, {
      x: renderXMm * MM,
      y: fromTopMm(renderTopMm + renderHeightMm),
      width: renderWidthMm * MM,
      height: renderHeightMm * MM
    });

    // Technische markering voor de drukkerij: 100% geel op 1% opacity, exact
    // even groot/gepositioneerd als de foto zelf — zelfde protocol als het
    // muziekframe (zie daar voor de volledige toelichting).
    page.drawRectangle({
      x: renderXMm * MM,
      y: fromTopMm(renderTopMm + renderHeightMm),
      width: renderWidthMm * MM,
      height: renderHeightMm * MM,
      color: cmyk(0, 0, 1, 0),
      opacity: 0.01
    });
  }

  // --- Fonts: Montserrat Bold (enige gebruikte gewicht in dit ontwerp) ---
  doc.registerFontkit(fontkit);
  const fontsDir = path.join(__dirname, 'fonts');
  const boldPath = path.join(fontsDir, 'Montserrat-Bold.ttf');
  let fontBold;
  if (fs.existsSync(boldPath)) {
    fontBold = await doc.embedFont(fs.readFileSync(boldPath));
  } else {
    console.warn('[autoframe] Montserrat-Bold.ttf niet gevonden in server/fonts/ — val terug op Helvetica-Bold.');
    fontBold = await doc.embedFont('Helvetica-Bold');
  }

  const emojiCache = await preloadEmojiImages(doc, [
    data.titel, data.motor, data.pk, data.snelheid, data.naam
  ]);

  // --- Titel ("Merk & type auto" -> klant-ingevulde tekst): horizontaal
  // gecentreerd op de plaat, verticaal gecentreerd tussen de foto en de
  // eerste veld-regel eronder (die positie verschilt per layout). ---
  if (data.titel) {
    const parts = splitTextEmoji(data.titel);
    const maxWidthPt = TITLE.maxWidthMm * MM;
    const size = fitFontSizeToWidth(parts, fontBold, TITLE.fontSizePt, maxWidthPt, 10);

    // Horizontaal centreren: gebaseerd op de daadwerkelijke breedte bij de
    // uiteindelijk gekozen (eventueel verkleinde) lettergrootte.
    const textWidthMm = measureMixedTextWidth(parts, fontBold, size) / MM;
    const xMm = (PAGE_W_MM - textWidthMm) / 2;

    // Verticaal centreren tussen foto-onderkant en de bovenkant van het
    // eerste veld-icoontje in de huidige layout (verschilt met/zonder QR-code).
    const photoBottomMm = PHOTO_ZONE.topMm + PHOTO_ZONE.sizeMm;
    const firstFieldTopMm = Math.min(...Object.values(layout.fields).map(f => f.iconTopMm));
    const gapCenterMm = (photoBottomMm + firstFieldTopMm) / 2;
    const blockHeightMm = size * (25.4 / 72);
    const baselineMm = gapCenterMm - blockHeightMm / 2 + blockHeightMm * TITLE.baselineRatio;

    drawMixedText(page, parts, fontBold, size, xMm * MM, fromTopMm(baselineMm), styleColor, emojiCache);
  }

  // --- Vaste iconenrij + 4 klant-ingevulde velden ---
  const iconColorSuffix = isWhite ? 'wit' : 'zwart';
  const iconCache = new Map();
  async function getIconImage(naam) {
    const key = `${naam}-${iconColorSuffix}`;
    if (iconCache.has(key)) return iconCache.get(key);
    const iconPath = path.join(__dirname, 'autoframe-assets', `icon-${naam}-${iconColorSuffix}.png`);
    const png = fs.readFileSync(iconPath);
    const image = await doc.embedPng(png);
    iconCache.set(key, image);
    return image;
  }

  for (const veld of ['motor', 'pk', 'snelheid', 'naam']) {
    const pos = layout.fields[veld];
    const icon = await getIconImage(veld);
    page.drawImage(icon, {
      x: pos.iconXMm * MM,
      y: fromTopMm(pos.iconTopMm + pos.iconHMm),
      width: pos.iconWMm * MM,
      height: pos.iconHMm * MM
    });

    const waarde = data[veld];
    if (waarde) {
      const parts = splitTextEmoji(waarde);
      const maxWidthPt = pos.maxWidthMm * MM;
      const size = fitFontSizeToWidth(parts, fontBold, LABEL_FONT_SIZE_PT, maxWidthPt, 8);
      drawMixedText(
        page, parts, fontBold, size,
        pos.labelXMm * MM, fromTopMm(pos.labelTopMm + LABEL_BASELINE_OFFSET_MM),
        styleColor, emojiCache
      );
    }
  }

  // --- Verticale scheidingslijn ---
  page.drawRectangle({
    x: (layout.divider.xMm - layout.divider.widthMm / 2) * MM,
    y: fromTopMm(layout.divider.bottomMm),
    width: layout.divider.widthMm * MM,
    height: (layout.divider.bottomMm - layout.divider.topMm) * MM,
    color: styleColor
  });

  // --- QR-code (alleen als hasCode) ---
  if (hasCode && data.link) {
    const qrBarColorHex = isWhite ? 'fffffd' : null;
    const codeSvg = await getCodeSvg('qr', data.link, qrBarColorHex);
    const box = layout.qrBox;
    const codePng = await sharp(Buffer.from(codeSvg))
      .resize(box.sizeMm * 12)
      .png()
      .toBuffer();
    const codeImage = await doc.embedPng(codePng);

    // Witte achtergrond — behalve bij een marmer-achtergrond, dan 1% geel
    // (anders staat er een vreemd wit blok bovenop de marmertextuur).
    const codeBackgroundColor = isMarbleBackground(data.achtergrondKleur)
      ? nearWhiteCmyk(cmyk)
      : COLOR_CODE_BACKGROUND;

    page.drawRectangle({
      x: box.xMm * MM,
      y: fromTopMm(box.topMm + box.sizeMm),
      width: box.sizeMm * MM,
      height: box.sizeMm * MM,
      color: codeBackgroundColor
    });
    page.drawImage(codeImage, {
      x: box.xMm * MM,
      y: fromTopMm(box.topMm + box.sizeMm),
      width: box.sizeMm * MM,
      height: box.sizeMm * MM
    });
  }

  return doc.save();
}

module.exports = {
  generateAutoFramePdf, parseStyle,
  isAutoFrameLineItem, extractAutoFrameData, extractAutoFrameItemsFromOrder
};
