const { PDFDocument, rgb, cmyk, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const sharp = require('sharp');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const paths = require('./musicframe-paths');
const {
  MM, splitTextEmoji, preloadEmojiImages, measureMixedTextWidth, drawMixedText,
  fitFontSizeToWidth, embedPhoto, fitPhotoInSquareZone, recolorDarkPixels, getCodeSvg,
  drawBackground, isMarbleBackground, nearWhiteCmyk
} = require('./pdf-shared');

const PAGE_W_MM = 200;
const PAGE_H_MM = 300;

// Zwart/wit t.b.v. de 2 stijlvarianten. De exacte kleur uit het basisbestand
// is een "rich black" (CMYK-mix) — voor onze RGB-PDF gebruiken we gewoon zuiver
// zwart/wit, dat oogt identiek.
const COLOR_BLACK = rgb(0, 0, 0);
const COLOR_WHITE = rgb(1, 1, 253 / 255); // #fffffd
// Standaard rood voor het hartje ("Hartje rood") — zelf gekozen, warm/verzadigd rood.
const COLOR_HEART_RED = rgb(0.87, 0.15, 0.22);
// Zuiver wit (#ffffff) voor de achtergrond ACHTER de QR-/Spotify-code — dit is
// bewust een andere kleur dan de #fffffd "witte tekst"-stijl hierboven.
const COLOR_CODE_BACKGROUND = rgb(1, 1, 1);

// Herkent zowel de Nederlandse ("Muziek-frame"/"Valentijn-frame"), Engelse
// ("Music-frame"/"Valentine-frame") als de Duitse ("Musik-rahmen"/
// "Valentins-rahmen") productnaam — internationale orders hebben namelijk
// een écht andere titel in Shopify zelf (niet alleen een vertaling op de
// pakbon).
function isMusicFrameLineItem(li) {
  return /muziek-?frame|music-?frame|valentijn-?frame|valentine?s?-?frame|musik-?rahmen|valentins?-?rahmen/i.test(li.title || '');
}

// Herkent de "klein" / "dik" variant van een Muziek-/Valentijn-frame, op basis
// van titel + variant — net zoals de tegeltjes op "13x13" gecontroleerd worden.
// Bepaalt straks in welke submap en onder welke bestandsnaam het drukwerkbestand
// terechtkomt (zie appendPrintFilesToArchive in index.js).
function getMusicFrameVariant(li) {
  const text = [li.title, li.variant_title].filter(Boolean).join(' ');
  if (/\bdik\b/i.test(text)) return 'dik';
  if (/\bklein\b/i.test(text)) return 'klein';
  return null;
}

// Haalt de door de klant ingevulde velden uit de properties van 1 productregel.
// De exacte volgorde/nummering van de vraagteksten in Shopify kan licht variëren
// (bv. "5. Regel 1" vs "Regel 1"), dus we matchen op kernwoorden i.p.v. exacte tekst.
function extractMusicFrameData(li) {
  const props = li.properties || [];
  const getProp = (regex) => {
    const p = props.find(p => regex.test(p.name || ''));
    return p ? String(p.value || '').trim() : '';
  };

  return {
    style: getProp(/stijl van jouw socialframe/i),
    link: getProp(/link naar.*favoriete nummer|favoriete nummer.*website/i),
    fotoFilter: getProp(/foto-?filter/i),
    achtergrondKleur: getProp(/achtergrond\s*kleur/i),
    hartjeKleur: getProp(/kleur van het hartje/i),
    regel1: getProp(/\bregel\s*1\b/i),
    regel2: getProp(/\bregel\s*2\b/i),
    begintijd: getProp(/begintijd/i),
    eindtijd: getProp(/eindtijd/i),
    bolletjePositie: getProp(/positie\s*bolletje/i),
    photoUrl: getProp(/upload hier jouw favoriete foto/i)
  };
}

// Zoekt in een volledige (raw) Shopify-order naar Muziek-/Valentijn-frame
// productregels, en geeft voor elke bestelde stuks (quantity) een los item
// terug — net als bij de autopictura-tegeltjes: 2x hetzelfde besteld moet ook
// 2 losse drukwerkbestanden opleveren.
function extractMusicFrameItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    if (!isMusicFrameLineItem(li)) return;
    const data = extractMusicFrameData(li);
    const variant = getMusicFrameVariant(li);
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, variant, data });
    }
  });
  return items;
}

// Zet een pagina-Y-positie (mm, vanaf BOVEN, zoals in het basisbestand gemeten)
// om naar een PDF-Y-positie (punten, vanaf ONDER).
function fromTopMm(topMm) {
  return (PAGE_H_MM - topMm) * MM;
}

function drawIconPath(page, pathInfo, color) {
  // BELANGRIJK: pathInfo.d staat al in PDF-punten (zo geëxtraheerd/genormaliseerd
  // uit het basisbestand), dus hier GEEN scale:MM toepassen — dat zou een dubbele
  // mm-naar-punt-conversie zijn (~2.83x te groot). Alleen de ankerpositie (x/y)
  // wordt in mm opgegeven en dus wél omgerekend.
  page.drawSvgPath(pathInfo.d, {
    x: pathInfo.pageXMm * MM,
    y: fromTopMm(pathInfo.pageTopMm),
    color
  });
}

// Bepaalt tekst-/iconkleur en of er een hartje/code bij moet, op basis van de
// door de klant gekozen "stijl" (6 varianten, zie server/inventory.js-achtige aanpak).
function parseStyle(styleText) {
  const t = (styleText || '').toLowerCase();
  const isWhite = t.includes('wit');
  let codeType = 'geen';
  if (t.includes('qr')) codeType = 'qr';
  else if (t.includes('spotify')) codeType = 'spotify';
  return { color: isWhite ? COLOR_WHITE : COLOR_BLACK, codeType, isWhite };
}

function parseHeartColor(value, defaultColor) {
  const t = (value || '').toLowerCase();
  if (!t || t.includes('geen')) return null; // geen hartje tekenen
  if (t.includes('rood')) return COLOR_HEART_RED;
  if (t.includes('zwart')) return COLOR_BLACK;
  if (t.includes('wit')) return COLOR_WHITE;
  return defaultColor; // onbekende waarde: val terug op de tekstkleur
}

// Percentage-tekst ("20%") naar getal 0-100
function parsePercent(value, fallback) {
  if (!value) return fallback;
  const match = String(value).match(/(\d+(\.\d+)?)/);
  return match ? Math.max(0, Math.min(100, parseFloat(match[1]))) : fallback;
}

async function generateMusicFramePdf(data) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W_MM * MM, PAGE_H_MM * MM]);

  const { color: styleColor, codeType, isWhite } = parseStyle(data.style);
  const hasCode = codeType !== 'geen' && !!data.link;
  // QR-code (lokaal gegenereerd, exacte hex mogelijk): #fffffd bij witte stijl.
  const qrBarColorHex = isWhite ? 'fffffd' : null;
  // Spotify Code (via Spotify's service, alleen zwart/wit mogelijk): bij de
  // witte stijl kleuren we de balkjes zelf om naar #fffffc — dat is het
  // RGB-equivalent van dezelfde CMYK 1%-geel-truc (C0 M0 Y1 K0) die ook al
  // achter de foto gebruikt wordt. Een ECHTE pixelkleur i.p.v. PDF-transparantie,
  // want niet elke drukkerij-RIP verwerkt transparantie betrouwbaar.
  const SPOTIFY_NEAR_WHITE_RGB = { r: 255, g: 255, b: 252 }; // #fffffc

  // Achtergrondkleur: "Wit" (1% geel-truc), "Zwart" (diepzwart), "Marmerwit"/
  // "Marmerzwart" (echte textuur), of niets bij "Transparant" / onbekend.
  await drawBackground(doc, page, data.achtergrondKleur, PAGE_W_MM, PAGE_H_MM, cmyk, rgb);

  // --- Foto (past binnen een vak van 160x160mm, gecentreerd, 15.6mm vanaf
  // boven — met de EIGEN beeldverhouding van de foto behouden: een niet-
  // vierkante foto vult dus niet het hele vak, het lege deel (zijkanten óf
  // boven-/onderkant, afhankelijk van de foto) blijft leeg i.p.v. gevuld of
  // uitgerekt.) ---
  if (data.photoUrl) {
    const zoneSizeMm = 160;
    const { image: jpegImage, aspectRatio } = await embedPhoto(doc, data.photoUrl, data.fotoFilter, zoneSizeMm);
    const zoneXMm = (PAGE_W_MM - zoneSizeMm) / 2;
    const zoneTopMm = 15.6;

    const { renderWidthMm, renderHeightMm, renderXMm, renderTopMm } =
      fitPhotoInSquareZone(aspectRatio, zoneXMm, zoneTopMm, zoneSizeMm);

    page.drawImage(jpegImage, {
      x: renderXMm * MM,
      y: fromTopMm(renderTopMm + renderHeightMm),
      width: renderWidthMm * MM,
      height: renderHeightMm * MM
    });
    // De technische print-markering (subtiele gele tint) zit al in de foto
    // zelf gebakken — zie applyPrintMarkerTint in pdf-shared.js — dus hier
    // geen apart laagje met PDF-opacity meer nodig (was onbetrouwbaar).
  }

  // --- Fonts: Montserrat (Regular + Bold) als je die in server/fonts/ hebt
  // gezet (zie README), anders val terug op de standaard PDF-lettertypen. ---
  doc.registerFontkit(fontkit);
  const fontsDir = path.join(__dirname, 'fonts');
  const regularPath = path.join(fontsDir, 'Montserrat-Regular.ttf');
  const boldPath = path.join(fontsDir, 'Montserrat-Bold.ttf');

  let fontRegular, fontBold;
  if (fs.existsSync(regularPath) && fs.existsSync(boldPath)) {
    fontRegular = await doc.embedFont(fs.readFileSync(regularPath));
    fontBold = await doc.embedFont(fs.readFileSync(boldPath));
  } else {
    console.warn('[musicframe] Montserrat-lettertypen niet gevonden in server/fonts/ — val terug op Helvetica. Zie README voor hoe je de echte Montserrat-bestanden toevoegt.');
    fontRegular = await doc.embedFont(StandardFonts.Helvetica);
    fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  }

  // --- Emoji in Regel 1/2 vast ophalen (Apple- en andere platform-emoji
  // bevatten geen glyph in Montserrat, dus die tekenen we als kleine plaatjes) ---
  const emojiCache = await preloadEmojiImages(doc, [data.regel1, data.regel2, data.begintijd, data.eindtijd]);

  // --- Regel 1 (verplicht) ---
  // Tekst mag nooit dichter dan 3mm bij het hartje komen. Past de tekst niet op
  // de standaard-puntgrootte, dan wordt het lettertype automatisch verkleind
  // tot het wél past — nooit afbreken naar een 2e regel of buiten de plaat lopen.
  const heartLeftEdgeMm = paths.heart.pageXMm; // 167.01mm
  const textStartXMm = 19.7;
  const textMaxWidthMm = heartLeftEdgeMm - 3 - textStartXMm; // beschikbare breedte tot 3mm voor het hartje
  const textMaxWidthPt = textMaxWidthMm * MM;

  if (data.regel1) {
    const parts = splitTextEmoji(data.regel1);
    const size = fitFontSizeToWidth(parts, fontBold, 27.8, textMaxWidthPt);
    drawMixedText(page, parts, fontBold, size, textStartXMm * MM, fromTopMm(189.7 + 9.8), styleColor, emojiCache);
  }

  // --- Regel 2 (optioneel — weglaten als niet ingevuld) ---
  if (data.regel2) {
    const parts = splitTextEmoji(data.regel2);
    const size = fitFontSizeToWidth(parts, fontRegular, 28, textMaxWidthPt);
    drawMixedText(page, parts, fontRegular, size, textStartXMm * MM, fromTopMm(203.1 + 9.9), styleColor, emojiCache);
  }

  // --- Hartje (optioneel — weglaten als "geen" gekozen) ---
  const heartColor = parseHeartColor(data.hartjeKleur, styleColor);
  if (heartColor) {
    drawIconPath(page, paths.heart, heartColor);
  }

  // --- Tijdlijn-balk + bolletje: ALTIJD zichtbaar, ongeacht of Begintijd/
  // Eindtijd zijn ingevuld (die zijn optioneel — de balk zelf niet). Het
  // bolletje gebruikt bij ontbrekende "Positie Bolletje Tijdlijn" gewoon de
  // standaard 20%. ---
  drawIconPath(page, paths.timeline_bar, styleColor);

  const dotPercent = parsePercent(data.bolletjePositie, 20);
  const barXMm = paths.timeline_bar.pageXMm;
  const barWidthMm = paths.timeline_bar.widthMm;
  const dotDiameterMm = 7.5;
  const dotCenterXMm = barXMm + (barWidthMm * dotPercent / 100);
  const dotCenterTopMm = paths.timeline_bar.pageTopMm + (paths.timeline_bar.heightMm / 2);

  page.drawCircle({
    x: dotCenterXMm * MM,
    y: fromTopMm(dotCenterTopMm),
    size: (dotDiameterMm / 2) * MM,
    color: styleColor
  });

  // --- Tijd-labels: elk apart optioneel — alleen tekenen als die ene waarde
  // ook echt is ingevuld (dus bv. wel een begintijd zonder eindtijd kan ook).
  // Gebruiken dezelfde emoji-veilige tekenroutine als Regel 1/2 hierboven —
  // dit veld is bedoeld voor korte tijdsaanduidingen ("0:18"), maar een klant
  // kan hier per ongeluk (of expres) iets heel anders/langers in typen, dus
  // ook hier een max-breedte + automatisch verkleinen als vangnet. ---
  const timeLabelMaxWidthPt = 70 * MM;
  if (data.begintijd) {
    const parts = splitTextEmoji(data.begintijd);
    const size = fitFontSizeToWidth(parts, fontBold, 17.2, timeLabelMaxWidthPt, 8);
    drawMixedText(page, parts, fontBold, size, 19.8 * MM, fromTopMm(230.5 + 6.1), styleColor, emojiCache);
  }
  if (data.eindtijd) {
    const parts = splitTextEmoji(data.eindtijd);
    const size = fitFontSizeToWidth(parts, fontBold, 17.2, timeLabelMaxWidthPt, 8);
    const totalWidthPt = measureMixedTextWidth(parts, fontBold, size);
    const xPt = (PAGE_W_MM - 19.8) * MM - totalWidthPt;
    drawMixedText(page, parts, fontBold, size, xPt, fromTopMm(230.5 + 6.1), styleColor, emojiCache);
  }

  // --- Vaste iconenrij (shuffle, vorige, afspelen, volgende, herhalen) ---
  // Verschuivingen zijn gebaseerd op de door de klant aangeleverde
  // referentiebestanden. "Geen code" en "QR-code" gebruiken bewust dezelfde
  // hoogte (de QR-code-hoogte is de referentie) — dus de hele rij, inclusief
  // het herhaal-icoon, schuift in beide gevallen 2.824mm naar beneden t.o.v.
  // de rauwe basispositie uit het originele basisbestand. Spotify-code blijft
  // een eigen (grotere) verschuiving gebruiken.
  const BASE_SHIFT_MM = 2.824;
  const SPOTIFY_SHIFT_MM = -8.73;

  const iconShiftMm = codeType === 'spotify' ? SPOTIFY_SHIFT_MM : BASE_SHIFT_MM;

  ['shuffle_1', 'shuffle_2', 'shuffle_3', 'prev', 'play_triangle', 'play_circle', 'next', 'repeat_1', 'repeat_2'].forEach(name => {
    drawIconPath(page, { ...paths[name], pageTopMm: paths[name].pageTopMm + iconShiftMm }, styleColor);
  });

  // --- QR-/Spotify-code, met witte achtergrond — behalve bij een marmer-
  // achtergrond, dan wordt dat 1% geel (anders staat er een vreemd wit blok
  // bovenop de marmertextuur). ---
  const codeBackgroundColor = isMarbleBackground(data.achtergrondKleur)
    ? nearWhiteCmyk(cmyk)
    : COLOR_CODE_BACKGROUND;

  if (hasCode) {
    if (codeType === 'qr') {
      // Exacte, rechtstreeks uit FRAME_QR_code.pdf gemeten positie
      // (x=161.925mm, top=247.011mm, 20x20mm) — bewust een vaste, letterlijke
      // waarde i.p.v. een berekening, om te voorkomen dat een verschuiving
      // per ongeluk dubbel meetelt.
      const CODE_SIZE_MM = 20;
      const codeXMm = 161.925;
      const codeTopMm = 247.011;
      const codeYPdf = fromTopMm(codeTopMm + CODE_SIZE_MM);

      page.drawRectangle({
        x: codeXMm * MM,
        y: codeYPdf,
        width: CODE_SIZE_MM * MM,
        height: CODE_SIZE_MM * MM,
        color: codeBackgroundColor
      });

      const codeSvg = await getCodeSvg('qr', data.link, qrBarColorHex);
      // Kan null zijn als het ophalen om wat voor reden dan ook mislukte —
      // dan liever de rest van het bestand gewoon compleet, zonder code, dan
      // de hele PDF-generatie te laten crashen.
      if (codeSvg) {
        const codePng = await sharp(Buffer.from(codeSvg))
          .resize(CODE_SIZE_MM * 12)
          .png()
          .toBuffer();
        const codeImage = await doc.embedPng(codePng);
        page.drawImage(codeImage, {
          x: codeXMm * MM,
          y: codeYPdf,
          width: CODE_SIZE_MM * MM,
          height: CODE_SIZE_MM * MM
        });
      }
    } else if (codeType === 'spotify') {
      // Exact gemeten vak uit FRAME_spotify_code.pdf: x=43.55mm, top=261.32mm,
      // 113x28.25mm. De echte Spotify Code (met logo + soundwave) wordt via
      // Spotify's eigen scannables-service opgehaald — dat geeft een preciezer
      // en per nummer correct resultaat dan het exacte voorbeeldpatroon natekenen.
      const boxXMm = 43.55;
      const boxTopMm = 261.32;
      const boxWidthMm = 113;
      const boxHeightMm = 28.25;

      const codeSvg = await getCodeSvg('spotify', data.link);
      // Kan null zijn als het ophalen mislukte (bv. een link die niet
      // herkend werd, of Spotify's service tijdelijk niet bereikbaar) — dan
      // liever de rest van het bestand gewoon compleet, zonder code.
      if (codeSvg) {
        let codePng = await sharp(Buffer.from(codeSvg))
          .resize(boxWidthMm * 12, boxHeightMm * 12, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
          .png()
          .toBuffer();
        // Bij de witte stijl: balkjes omkleuren naar #fffffc (1% geel CMYK-
        // equivalent), als ECHTE pixelkleur, niet als PDF-transparantie.
        if (isWhite) {
          codePng = await recolorDarkPixels(codePng, SPOTIFY_NEAR_WHITE_RGB);
        }
        const codeImage = await doc.embedPng(codePng);

        // Witte achtergrond over het hele vak, dan de code erbovenop.
        page.drawRectangle({
          x: boxXMm * MM,
          y: fromTopMm(boxTopMm + boxHeightMm),
          width: boxWidthMm * MM,
          height: boxHeightMm * MM,
          color: codeBackgroundColor
        });
        page.drawImage(codeImage, {
          x: boxXMm * MM,
          y: fromTopMm(boxTopMm + boxHeightMm),
          width: boxWidthMm * MM,
          height: boxHeightMm * MM
        });
      }
    }
  }

  return doc.save();
}

module.exports = {
  generateMusicFramePdf, parseStyle, parseHeartColor, parsePercent,
  isMusicFrameLineItem, extractMusicFrameData, extractMusicFrameItemsFromOrder,
  getMusicFrameVariant, embedPhoto, splitTextEmoji, preloadEmojiImages, measureMixedTextWidth, drawMixedText,
  recolorDarkPixels
};
