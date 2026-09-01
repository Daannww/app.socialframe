const { PDFDocument, rgb, cmyk, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');
const { MM, nearWhiteCmyk } = require('./pdf-shared');
const paths = require('./musicframe-paths');

const PAGE_W_MM = 100;
const PAGE_H_MM = 100;

const COLOR_BLACK = rgb(0, 0, 0);
// Wit = de 1%-gele CMYK-truc (C0 M0 Y1 K0), net als overal elders in dit
// project — nooit letterlijk #FFFFFF, want dat kan een printer soms als
// "geen inkt"/gat zien i.p.v. als te printen kleur.
const COLOR_WHITE = nearWhiteCmyk(cmyk);
// De "2e kleur" (accentkleur, bv. goud) — exact overgenomen uit het
// referentiebestand "Jij bent goud" (CMYK 0.2/0.3/0.75/0.05).
const COLOR_GOLD = cmyk(0.2, 0.3, 0.75, 0.05);

// --- Tegelkleuren waarbij de hoofdtekst ZWART wordt (lichte tegel) — alle
// overige kleuren (incl. Zwart zelf) krijgen WITTE hoofdtekst. Bevestigd met
// de opdrachtgever: alleen Wit en Beige geven zwarte tekst. ---
const LICHTE_TEGELKLEUREN = ['wit', 'beige'];

// --- Bekende, vaste tekst-ontwerpen. Elk ontwerp = een lijst van tekstregels
// (kan er meer dan 2 zijn — "Jij bent GOUD" is bv. 3 regels: "Jij", "bent",
// "GOUD"). Regels met accent:true krijgen ALTIJD de accentkleur (goud),
// ongeacht de tegelkleur — overige regels volgen de zwart/wit-regel
// hierboven. Nieuwe varianten kunnen hier simpelweg worden toegevoegd zodra
// er een referentiebestand + voorbeeldbestelling van is. Herkenning gebeurt
// op basis van een kenmerkende zin die in de producttitel voorkomt
// (hoofdletter-ongevoelig, negeert leestekens).
const TEGEL_TEKST_ONTWERPEN = [
  {
    // Titel in Shopify: "Tegeltje met tekst - Jij bent goud."
    herken: /jij\s*bent\s*goud/i,
    regels: [
      { tekst: 'Jij', fontType: 'medium', puntgrootteMm: 18.6, topMm: 23.25, accent: false },
      { tekst: 'bent', fontType: 'medium', puntgrootteMm: 18.6, topMm: 40.25, accent: false },
      { tekst: 'GOUD', fontType: 'blackItalic', puntgrootteMm: 15.0, topMm: 60.12, accent: true }
    ]
  }
];

function fromTopMm(topMm) {
  return (PAGE_H_MM - topMm) * MM;
}

// Herkent of een productregel een "Tegeltje met tekst"-standaardproduct is
// waar we een ontwerp voor kennen. Geeft het ontwerp terug (of null).
function matchTegelTekstOntwerp(li) {
  const titel = li.title || '';
  if (!/tegeltje met tekst/i.test(titel)) return null;
  return TEGEL_TEKST_ONTWERPEN.find(o => o.herken.test(titel)) || null;
}

function isTegelTekstLineItem(li) {
  return matchTegelTekstOntwerp(li) !== null;
}

// Haalt de gekozen tegelkleur uit de Shopify-variant (bv. "Beige / Houten-
// houder" -> "Beige") — dezelfde plek (variant_title) als bij de andere
// tegel-/frame-producten in dit project.
function extractTegelKleur(li) {
  const variantTitle = li.variant_title || '';
  const eersteDeel = variantTitle.split('/')[0].trim();
  return eersteDeel || null;
}

function extractTegelTekstData(li) {
  const ontwerp = matchTegelTekstOntwerp(li);
  const kleur = extractTegelKleur(li);
  return { ontwerp, kleur };
}

// Zoekt in een volledige (raw) Shopify-order naar "Tegeltje met tekst"-
// productregels met een bekend ontwerp, en geeft voor elk besteld exemplaar
// (quantity) een los item terug.
function extractTegelTekstItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    const ontwerp = matchTegelTekstOntwerp(li);
    if (!ontwerp) return;
    const kleur = extractTegelKleur(li);
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, kleur, data: { ontwerp, kleur } });
    }
  });
  return items;
}

async function generateTegelTekstPdf(data) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([PAGE_W_MM * MM, PAGE_H_MM * MM]);

  // --- Lettertypen: Playfair Display (Medium + Black Italic), net als het
  // referentiebestand. Terugval op Times Roman (dichtstbijzijnde ingebouwde
  // PDF-lettertype qua stijl — een schreef-lettertype, i.t.t. Helvetica) als
  // de echte Playfair Display-bestanden niet aanwezig zijn. ---
  const mediumPath = path.join(__dirname, 'fonts', 'PlayfairDisplay-Medium.ttf');
  const blackItalicPath = path.join(__dirname, 'fonts', 'PlayfairDisplay-BlackItalic.ttf');
  let fontMedium, fontBlackItalic;
  if (fs.existsSync(mediumPath) && fs.existsSync(blackItalicPath)) {
    fontMedium = await doc.embedFont(fs.readFileSync(mediumPath));
    fontBlackItalic = await doc.embedFont(fs.readFileSync(blackItalicPath));
  } else {
    console.warn('[texttile] PlayfairDisplay-Medium.ttf/PlayfairDisplay-BlackItalic.ttf niet gevonden in server/fonts/ — val terug op Times Roman. Zie README voor hoe je de echte lettertypebestanden toevoegt.');
    fontMedium = await doc.embedFont(StandardFonts.TimesRoman);
    fontBlackItalic = await doc.embedFont(StandardFonts.TimesRomanBoldItalic);
  }

  const ontwerp = data.ontwerp;
  if (!ontwerp) {
    throw new Error('Geen bekend tekst-ontwerp meegegeven aan generateTegelTekstPdf.');
  }

  // --- Hoofdtekst-kleur: zwart bij Wit/Beige, wit bij alle andere tegel-
  // kleuren (bevestigd met de opdrachtgever). De accentregel (regel 2) is
  // hier bewust NIET van afhankelijk — die blijft altijd de accentkleur. ---
  const kleurNaam = (data.kleur || '').toLowerCase();
  const hoofdtekstKleur = LICHTE_TEGELKLEUREN.some(k => kleurNaam.includes(k)) ? COLOR_BLACK : COLOR_WHITE;

  const fontVoorType = (type) => type === 'blackItalic' ? fontBlackItalic : fontMedium;

  (ontwerp.regels || []).forEach(regel => {
    const font = fontVoorType(regel.fontType);
    const kleur = regel.accent ? COLOR_GOLD : hoofdtekstKleur;
    const sizePt = regel.puntgrootteMm * MM;
    const textWidthPt = font.widthOfTextAtSize(regel.tekst, sizePt);
    const xPt = (PAGE_W_MM * MM - textWidthPt) / 2; // horizontaal gecentreerd
    page.drawText(regel.tekst, {
      x: xPt,
      y: fromTopMm(regel.topMm) - sizePt * 0.75, // tekst-baseline t.o.v. de top van de tekstregel (zie toelichting hieronder)
      size: sizePt,
      font,
      color: kleur
    });
  });

  // --- Hartje: hergebruikt het bestaande hart-icoon-pad (musicframe-paths.js),
  // herschaald naar de grootte uit het referentiebestand (6.81 x 6.03mm i.p.v.
  // de oorspronkelijke 14.3 x 14.085mm) — altijd de accentkleur, ongeacht de
  // tegelkleur. Positie exact zoals opgemeten (top=77.03mm, gecentreerd). ---
  const HART_SCHAAL = 0.4522; // gemiddelde van de breedte-/hoogte-verhouding, zie opmeet-sessie
  const hartBreedteMm = paths.heart.widthMm * HART_SCHAAL;
  const hartXMm = (PAGE_W_MM - hartBreedteMm) / 2;
  page.drawSvgPath(paths.heart.d, {
    x: hartXMm * MM,
    y: fromTopMm(77.03),
    scale: HART_SCHAAL,
    color: COLOR_GOLD
  });

  return doc.save();
}

module.exports = {
  generateTegelTekstPdf, isTegelTekstLineItem, matchTegelTekstOntwerp,
  extractTegelKleur, extractTegelTekstData, extractTegelTekstItemsFromOrder,
  TEGEL_TEKST_ONTWERPEN, LICHTE_TEGELKLEUREN
};
