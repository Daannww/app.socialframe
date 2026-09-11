const {
  PDFDocument, rgb, cmyk, StandardFonts, pushGraphicsState, popGraphicsState,
  clipEvenOdd, endPath, moveTo, lineTo, appendBezierCurve, closePath,
  setFillingColor, fill
} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');
const {
  MM, splitTextEmoji, preloadEmojiImages, measureMixedTextWidth, drawMixedText,
  fitFontSizeToWidth, embedPhotoRounded, drawImageMetAfgerondeHoeken, nearWhiteCmyk, loadHebrewFont
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
const BOLLETJE_DIAMETER_MM = 4.6; // 2x zo groot als de vorige 2.3mm, op verzoek

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
  if (/sound[\s-]?frame/i.test(li.title || '')) return true;
  // Zelfde valstrik als bij muziekframe ontdekt: Shopify/de personalisatie-
  // app kan de aanpasgegevens onder een ander productregel-item hangen
  // (bv. "Als een cadeautje inpakken.") i.p.v. een eigen "Sound-Frame"-regel.
  // Sound-Frame heeft geen enkele eigen UNIEKE eigenschap-naam om positief op
  // te herkennen (het is bijna hetzelfde veldenpakket als muziekframe, alleen
  // zonder linkvraag en zonder achtergrondkleur-keuze) — dus de herkenning
  // hier is deels op AFWEZIGHEID gebaseerd: wel "Regel 1" + "kleur van het
  // hartje" + een tijdlijn-eigenschap, maar GEEN linkvraag (noch muziekframe
  // se "favoriete nummer"-formulering, noch auto-frame se "foto/filmpje/
  // qr-code"-formulering) en GEEN "achtergrond kleur"-eigenschap — dat sluit
  // muziekframe/auto-frame uit zonder ze zelf te hoeven importeren.
  const props = li.properties || [];
  const heeftRegel1 = props.some(p => /\bregel\s*1\b/i.test(p.name || ''));
  const heeftHartjeKleur = props.some(p => /kleur van het hartje/i.test(p.name || ''));
  const heeftTijdlijn = props.some(p => /begintijd|eindtijd|positie\s*bolletje/i.test(p.name || ''));
  const heeftLink = props.some(p => /link naar/i.test(p.name || ''));
  const heeftAchtergrondKleur = props.some(p => /achtergrond\s*kleur/i.test(p.name || ''));
  return heeftRegel1 && heeftHartjeKleur && heeftTijdlijn && !heeftLink && !heeftAchtergrondKleur;
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

// Tekent het hart-icoon als PURE VECTORVORM (zelfde pad als musicframe se
// eigen paths.heart, hergebruikt via iconPaths) — GEEN raster/PNG meer.
// Ontdekt dat de oude raster-aanpak (een PNG met een grijswaarden-luminantie-
// masker als alfakanaal) bij het printen witte vlakken rond het hartje gaf —
// vermoedelijk een print-RIP die een raster-alfakanaal in combinatie met een
// (voor het kleurprofiel-probleem toegevoegd) ICC-profiel niet correct
// afhandelt. Muziekframe had dit probleem nooit, want die tekent zijn hartje
// altijd al als vectorpad — dus nu exact dezelfde techniek hier.
function drawHartVector(page, xPt, yPt, breedteMm, kleur) {
  const schaal = breedteMm / iconPaths.heart.widthMm;
  page.drawSvgPath(iconPaths.heart.d, { x: xPt, y: yPt, scale: schaal, color: kleur });
}

// Tekent de afspeelknop als PURE VECTORVORM: een gevulde cirkel MET EEN ECHT
// GAT in de vorm van het driehoekje, via een even-odd vector-KNIPMASKER
// (cirkel + driehoek samengevoegd, `clipEvenOdd`) i.p.v. de oude raster-PNG-
// met-SVG-uitgeknipt-alfakanaal-aanpak. Binnen dat knippad wordt gewoon een
// rechthoek gevuld — het knippad zelf zorgt dat alleen "cirkel-minus-
// driehoek" daadwerkelijk inkt krijgt, en de foto er middenin gewoon
// zichtbaar blijft (geen inkt = geen wijziging t.o.v. wat eronder ligt).
// Zelfde geometrie (cirkelstraal + driehoek-coördinaten) als voorheen, nu
// alleen als losse vector-operators i.p.v. via een SVG-naar-PNG-rendering.
function drawPlayknopVectorMetGat(page, xPt, yPt, diameterPt, kleur) {
  const R = 45.4121; // straal, in dezelfde eenheden als musicframe-paths.js se eigen (punt-gebaseerde) iconen
  const schaal = diameterPt / (2 * R);
  const cx = R, cy = R;
  const k = 0.5523 * R; // standaard Bezier-benadering van een kwart cirkel

  page.pushOperators(
    pushGraphicsState(),
    // Verschuiven + schalen kan pdf-lib niet los als operator, dus reken de
    // schaal/verschuiving hieronder gewoon zelf door in elke coördinaat.
  );
  const t = (px, py) => [xPt + px * schaal, yPt + py * schaal];
  const [cx0, cy0] = t(cx, cy - R);
  const [cx1x, cy1x] = t(cx + R, cy);
  const [cx2x, cy2x] = t(cx, cy + R);
  const [cx3x, cy3x] = t(cx - R, cy);
  page.pushOperators(
    moveTo(cx0, cy0),
    appendBezierCurve(...t(cx + k, cy - R), ...t(cx + R, cy - k), cx1x, cy1x),
    appendBezierCurve(...t(cx + R, cy + k), ...t(cx + k, cy + R), cx2x, cy2x),
    appendBezierCurve(...t(cx - k, cy + R), ...t(cx - R, cy + k), cx3x, cy3x),
    appendBezierCurve(...t(cx - R, cy - k), ...t(cx - k, cy - R), cx0, cy0),
    closePath(),
    moveTo(...t(62.7075, 45.408)),
    lineTo(...t(34.27, 28.99)),
    lineTo(...t(34.27, 61.8298)),
    closePath(),
    clipEvenOdd(),
    endPath(),
    setFillingColor(kleur),
    moveTo(xPt, yPt),
    lineTo(xPt + diameterPt, yPt),
    lineTo(xPt + diameterPt, yPt + diameterPt),
    lineTo(xPt, yPt + diameterPt),
    closePath(),
    fill(),
    popGraphicsState()
  );
}

async function generateSoundFramePdf(data) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([PAGE_W_MM * MM, PAGE_H_MM * MM]);

  const { color: styleColor, isWhite } = parseStyle(data.style);

  // --- Foto: vierkant (cover-fit, dus altijd het hele kaartje vullend),
  // afgeronde hoeken, met dezelfde print-kleurbalans-correctie als de andere
  // producten (voorkomt #FFFFFF-"gaten" bij het printen). Foto zelf is een
  // gewone, volledig rechthoekige JPEG (met behouden kleurprofiel) — de
  // afronding gebeurt apart via een vector-knipmasker bij het tekenen (zie
  // drawImageMetAfgerondeHoeken in pdf-shared.js), niet in de afbeelding
  // zelf. Ontdekt dat de OUDE aanpak (PNG met een afgerond alfakanaal) het
  // kleurprofiel van de foto altijd volledig kwijtraakte bij het inbedden —
  // pdf-lib se embedPng() bouwt de afbeelding intern helemaal opnieuw op,
  // in tegenstelling tot embedJpg() dat de rauwe JPEG-bytes (incl. een
  // eventueel kleurprofiel) grotendeels ongewijzigd doorgeeft. ---
  if (data.photoUrl) {
    const { image } = await embedPhotoRounded(doc, data.photoUrl, data.fotoFilter, KAART_SIZE_MM);
    drawImageMetAfgerondeHoeken(page, image, {
      x: KAART_X_MM * MM,
      y: fromTopMm(KAART_TOP_MM + KAART_SIZE_MM),
      width: KAART_SIZE_MM * MM,
      height: KAART_SIZE_MM * MM,
      radiusPt: KAART_RADIUS_MM * MM
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

  // Play-knop: gevulde cirkel MET EEN ECHT GAT voor het driehoekje (zie
  // drawPlayknopVectorMetGat hierboven) — pure vector, geen raster meer.
  const playCenterXMm = KAART_X_MM + (0.1015 * KAART_SIZE_MM) +
    (iconPaths.play_circle.pageXMm + iconPaths.play_circle.widthMm / 2 - ICOON_REFERENTIE_X_MM) * ICOON_SCHAAL;
  const playCenterTopMm = ICOON_RIJ_TOP_MM +
    (iconPaths.play_circle.pageTopMm + iconPaths.play_circle.heightMm / 2 - ICOON_REFERENTIE_TOP_MM) * ICOON_SCHAAL;
  const playDiameterMm = iconPaths.play_circle.widthMm * ICOON_SCHAAL;
  const playKnopKleur = isWhite ? COLOR_WHITE : COLOR_BLACK;
  drawPlayknopVectorMetGat(
    page,
    (playCenterXMm - playDiameterMm / 2) * MM,
    fromTopMm(playCenterTopMm + playDiameterMm / 2),
    playDiameterMm * MM,
    playKnopKleur
  );

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

  // --- Hebreeuws lettertype (indien aanwezig) — Montserrat heeft geen
  // Hebreeuwse glyphs. Zie loadHebrewFont in pdf-shared.js. ---
  const hebrewFontBold = await loadHebrewFont(doc, 'Bold');
  const hebrewFontRegular = await loadHebrewFont(doc, 'Regular');

  // --- Regel 1 (titel, bold) / Regel 2 (artiest, regular) — mogen nooit
  // onder het hartje doorlopen, dus max-breedte tot een marge ervoor, met
  // automatisch verkleinen (net als bij het muziekframe) als vangnet.
  // Tekst + hartje samen 5mm omhoog verplaatst (op verzoek) — het hartje
  // raakte de tijdlijnbalk bijna aan (hartje-onderkant op 74.394mm, balk-
  // bovenkant op 74.2mm), waardoor het bolletje op de tijdlijn nauwelijks
  // ruimte had. Onderlinge afstand tussen regel1/regel2/hartje blijft
  // ongewijzigd — de hele groep schuift als geheel omhoog. ---
  const OMHOOG_MM = 5;
  const heartLeftEdgeMm = 78.567;
  const textStartXMm = 10.772;
  const textMaxWidthMm = heartLeftEdgeMm - 4.724 - textStartXMm;
  const textMaxWidthPt = textMaxWidthMm * MM;

  if (data.regel1) {
    const parts = splitTextEmoji(data.regel1);
    const size = fitFontSizeToWidth(parts, fontBold, 4.614 * MM, textMaxWidthPt, 6, hebrewFontBold);
    drawMixedText(page, parts, fontBold, size, textStartXMm * MM, fromTopMm(64.488 - OMHOOG_MM) - size * 0.75, styleColor, emojiCache, hebrewFontBold);
  }
  if (data.regel2) {
    const parts = splitTextEmoji(data.regel2);
    const size = fitFontSizeToWidth(parts, fontRegular, 3.984 * MM, textMaxWidthPt, 6, hebrewFontRegular);
    drawMixedText(page, parts, fontRegular, size, textStartXMm * MM, fromTopMm(69.906 - OMHOOG_MM) - size * 0.75, styleColor, emojiCache, hebrewFontRegular);
  }

  // --- Hartje (optioneel — weglaten als "geen" gekozen) — als PURE VECTOR-
  // vorm getekend (zie drawHartVector hierboven), zelfde techniek als het
  // muziekframe. ---
  const heartRgb = parseHeartColor(data.hartjeKleur);
  if (heartRgb) {
    // Grootte teruggezet naar het oude formaat (op verzoek): de OUDE
    // raster-hartafbeelding (hart-masker.png) had zelf al de nodige
    // witruimte binnen zijn eigen 12.756mm-vak — het nieuwe vectorhart
    // (uit musicframe-paths.js) heeft een veel STRAKKERE eigen omtrek
    // (nauwelijks marge), en vulde dat vak dus bijna volledig — daardoor
    // oogde het merkbaar groter dan voorheen, ook al bleef de "declared"
    // maat 12.756mm ongewijzigd. Precies gemeten (pixel-vergelijking oude
    // vs nieuwe render): het oude hartje was feitelijk maar ~58,6% van die
    // 12.756mm groot. Nieuwe hartgrootte hierop gebaseerd, gecentreerd op
    // exact hetzelfde middelpunt als het oude 12.756mm-vak (zodat de
    // positie t.o.v. de tekst/tijdlijn ongewijzigd blijft) — verder is er
    // niets anders aan dit ontwerp veranderd.
    const heartSizeMm = 7.477;
    // LET OP: drawSvgPath/drawHartVector verwacht de BOVENkant als anker
    // (zelfde conventie als drawIconPath/drawScaledIcon hierboven — de vorm
    // groeit vanaf dit ankerpunt naar ONDEREN), in tegenstelling tot
    // drawImage (dat de ONDERkant als anker verwacht) — de eerdere versie
    // gebruikte per ongeluk nog de drawImage-conventie (topMm + heartSizeMm),
    // waardoor het hartje te laag kwam te staan en de "3:09"-tekst overlapte.
    drawHartVector(
      page,
      81.207 * MM,
      fromTopMm(59.278),
      heartSizeMm,
      rgb(heartRgb[0] / 255, heartRgb[1] / 255, heartRgb[2] / 255)
    );
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
    const size = fitFontSizeToWidth(parts, fontBold, 2.52 * MM, tijdLabelMaxWidthPt, 6, hebrewFontBold);
    drawMixedText(page, parts, fontBold, size, TIJDLIJN_LINKS_MM * MM, fromTopMm(77.087) - size * 0.75, styleColor, emojiCache, hebrewFontBold);
  }
  if (data.eindtijd) {
    const parts = splitTextEmoji(data.eindtijd);
    const size = fitFontSizeToWidth(parts, fontBold, 2.52 * MM, tijdLabelMaxWidthPt, 6, hebrewFontBold);
    const totalWidthPt = measureMixedTextWidth(parts, fontBold, size, hebrewFontBold);
    const xPt = TIJDLIJN_RECHTS_MM * MM - totalWidthPt;
    drawMixedText(page, parts, fontBold, size, xPt, fromTopMm(77.087) - size * 0.75, styleColor, emojiCache, hebrewFontBold);
  }

  return doc.save();
}

module.exports = {
  generateSoundFramePdf, isSoundFrameLineItem, extractSoundFrameData,
  extractSoundFrameItemsFromOrder, parseStyle, parseHeartColor, parsePercent
};
