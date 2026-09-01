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

// --- Tegelkleuren waarbij de hoofdtekst ZWART wordt (lichte tegel) — alle
// overige kleuren (incl. Zwart zelf) krijgen WITTE hoofdtekst. Bevestigd met
// de opdrachtgever: alleen Wit en Beige geven zwarte tekst. ---
const LICHTE_TEGELKLEUREN = ['wit', 'beige'];

// --- Bekende, vaste tekst-ontwerpen. Elk ontwerp heeft:
//  - herken: regex die matcht op de producttitel
//  - lettertypeBestanden/lettertypeTerugval: elk ontwerp kan zijn EIGEN
//    lettertype(n) gebruiken (bv. Playfair Display vs. Blastered) — bestanden
//    horen in server/fonts/ te staan; ontbreken ze, dan valt de server terug
//    op het meegegeven ingebouwde PDF-lettertype.
//  - regels: lijst van tekstregels. accent:true = ALTIJD de accentkleur
//    (ongeacht tegelkleur); overige regels volgen de zwart/wit-regel
//    hierboven.
//  - hart: eigen hart-pad + eigen (vaste) kleur + positie/schaal — twee
//    'eenheid'-varianten worden ondersteund, zie drawHart() hieronder.
// Nieuwe varianten kunnen hier simpelweg worden toegevoegd zodra er een
// referentiebestand + voorbeeldbestelling van is.
const TEGEL_TEKST_ONTWERPEN = [
  {
    id: 'jij-bent-goud',
    // Titel in Shopify: "Tegeltje met tekst - Jij bent goud."
    herken: /jij\s*bent\s*goud/i,
    lettertypeBestanden: { medium: 'PlayfairDisplay-Medium.ttf', blackItalic: 'PlayfairDisplay-BlackItalic.ttf' },
    lettertypeTerugval: { medium: StandardFonts.TimesRoman, blackItalic: StandardFonts.TimesRomanBoldItalic },
    regels: [
      { tekst: 'Jij', fontStijl: 'medium', puntgrootteMm: 18.6, topMm: 23.25, accent: false },
      { tekst: 'bent', fontStijl: 'medium', puntgrootteMm: 18.6, topMm: 40.25, accent: false },
      { tekst: 'GOUD', fontStijl: 'blackItalic', puntgrootteMm: 15.0, topMm: 60.12, accent: true }
    ],
    // "genormaliseerd": het hart-pad (uit musicframe-paths.js) staat in eigen
    // eenheden, met een gedocumenteerde widthMm — de schaal is experimenteel
    // bepaald (zie eerdere opmeet-sessie) om op de doelbreedte uit te komen.
    hart: {
      eenheid: 'genormaliseerd',
      pad: paths.heart.d,
      kleur: cmyk(0.2, 0.3, 0.75, 0.05), // altijd goud, ongeacht tegelkleur
      breedteMm: paths.heart.widthMm,
      schaal: 0.4522,
      topMm: 77.03
    }
  },
  {
    id: 'altijd-fijn-oma',
    // Titel in Shopify: "Tegeltje met tekst - Altijd fijn om bij Oma te zijn."
    herken: /altijd\s*fijn.*oma/i,
    lettertypeBestanden: { regular: 'Blastered-Regular.otf' },
    lettertypeTerugval: { regular: StandardFonts.HelveticaBold },
    regels: [
      { tekst: 'ALTIJD FIJN', fontStijl: 'regular', puntgrootteMm: 15.346, topMm: 19.6, accent: false },
      { tekst: 'OM BIJ OMA', fontStijl: 'regular', puntgrootteMm: 15.346, topMm: 38.78, accent: false },
      { tekst: 'TE ZIJN!', fontStijl: 'regular', puntgrootteMm: 15.346, topMm: 57.96, accent: false }
    ],
    // "pdf-punten": dit pad is rechtstreeks uit de PDF-inhoud van het
    // referentiebestand gehaald (via de ruwe content-stream-operators) — de
    // coördinaten staan al in PDF-punten, dus schaal 1 (geen mm-omrekening).
    hart: {
      eenheid: 'pdf-punten',
      pad: 'M 0,-0.0 C 0.784,-6.955 2.052,-13.846 3.8,-20.629 C 3.825,-20.209 3.84,-19.806 3.857,-19.447 C 4.169,-12.73 2.426,-6.241 0,-0.0 M -8.402,3.299 C -8.309,3.193 -8.243,3.093 -8.214,3.004 C -7.516,0.838 -6.818,-1.328 -6.12,-3.493 C -6.412,-1.037 -6.703,1.419 -6.995,3.876 C -7.054,4.374 -5.137,3.694 -3.976,2.904 C -4.122,4.287 -4.25,5.673 -4.357,7.061 C -5.693,5.834 -7.055,4.584 -8.402,3.299 M -19.896,-11.142 C -19.458,-11.363 -19.015,-11.635 -18.658,-11.916 C -17.959,-10.137 -17.26,-8.359 -16.561,-6.58 C -16.441,-6.279 -15.513,-6.534 -14.596,-6.989 C -13.934,-5.237 -13.416,-3.432 -13.045,-1.573 C -12.973,-1.216 -12.218,-1.487 -11.404,-1.921 C -11.505,-1.265 -11.594,-0.607 -11.674,0.053 C -14.937,-3.343 -17.893,-7.017 -19.896,-11.142 M -14.108,-14.076 C -14.291,-14.005 -14.487,-13.912 -14.685,-13.806 C -15.09,-14.837 -15.495,-15.867 -15.9,-16.898 C -15.189,-16.022 -14.607,-15.072 -14.108,-14.076 M 0.03,-24.901 C 0.528,-25.549 0.225,-25.471 1.125,-25.33 C 1.839,-25.218 2.354,-24.88 2.736,-24.414 C 2.072,-24.068 1.288,-23.563 1.07,-22.927 C 0.412,-21.01 -0.227,-19.087 -0.853,-17.159 C -0.685,-18.571 -0.518,-19.983 -0.35,-21.395 C -0.306,-21.769 -1.235,-21.515 -2.195,-21.055 C -1.78,-21.903 -1.337,-22.74 -0.855,-23.55 C -0.58,-24.011 -0.298,-24.475 0.03,-24.901 M 6.334,-26.926 C 4.688,-28.486 2.125,-27.717 0.365,-26.805 C -2.103,-25.528 -3.717,-23.576 -5.034,-21.168 C -6.564,-18.369 -7.8,-15.439 -8.742,-12.415 C -9.904,-15.96 -11.433,-19.326 -14.635,-21.517 C -16.571,-22.842 -19,-23.523 -21.31,-22.864 C -23.483,-22.244 -26.066,-20.66 -26.194,-18.179 C -26.477,-12.708 -23.057,-7.05 -19.855,-2.897 C -15.835,2.315 -10.883,6.771 -6.078,11.237 C -5.67,11.616 -4.668,11.19 -3.785,10.61 C -2.719,10.249 -0.946,9.104 -0.722,8.621 C 2.025,2.698 4.763,-3.296 6.382,-9.645 C 7.148,-12.649 7.656,-15.729 7.743,-18.832 C 7.807,-21.121 8.156,-25.199 6.334,-26.926 Z',
      kleur: cmyk(0.223, 0.973, 0.602, 0.156), // altijd deze kleur, ongeacht tegelkleur
      ankerXMm: 53.27,
      ankerTopMm: 85.284
    }
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

// Laadt alle lettertype-stijlen die een ontwerp nodig heeft, met per stijl
// een terugval op een ingebouwd PDF-lettertype als het echte bestand
// ontbreekt in server/fonts/.
async function laadLettertypen(doc, ontwerp) {
  const fonts = {};
  for (const stijl of Object.keys(ontwerp.lettertypeBestanden || {})) {
    const bestandsnaam = ontwerp.lettertypeBestanden[stijl];
    const bestandsPad = path.join(__dirname, 'fonts', bestandsnaam);
    if (fs.existsSync(bestandsPad)) {
      fonts[stijl] = await doc.embedFont(fs.readFileSync(bestandsPad));
    } else {
      console.warn(`[texttile] ${bestandsnaam} niet gevonden in server/fonts/ — val terug op een ingebouwd PDF-lettertype. Zie README voor hoe je het echte lettertypebestand toevoegt.`);
      fonts[stijl] = await doc.embedFont(ontwerp.lettertypeTerugval[stijl] || StandardFonts.Helvetica);
    }
  }
  return fonts;
}

// Tekent het hart-icoon van een ontwerp — ondersteunt 2 opslag-eenheden
// (zie de toelichting bij TEGEL_TEKST_ONTWERPEN hierboven).
function drawHart(page, hart) {
  if (hart.eenheid === 'pdf-punten') {
    page.drawSvgPath(hart.pad, {
      x: hart.ankerXMm * MM,
      y: fromTopMm(hart.ankerTopMm),
      scale: 1, // staat al in PDF-punten, geen mm-omrekening nodig
      color: hart.kleur
    });
  } else {
    // 'genormaliseerd': eigen eenheden met een gedocumenteerde breedteMm,
    // herschaald met de experimenteel bepaalde factor.
    const hartBreedteMm = hart.breedteMm * hart.schaal;
    const hartXMm = (PAGE_W_MM - hartBreedteMm) / 2;
    page.drawSvgPath(hart.pad, {
      x: hartXMm * MM,
      y: fromTopMm(hart.topMm),
      scale: hart.schaal,
      color: hart.kleur
    });
  }
}

async function generateTegelTekstPdf(data) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([PAGE_W_MM * MM, PAGE_H_MM * MM]);

  const ontwerp = data.ontwerp;
  if (!ontwerp) {
    throw new Error('Geen bekend tekst-ontwerp meegegeven aan generateTegelTekstPdf.');
  }

  const fonts = await laadLettertypen(doc, ontwerp);

  // --- Hoofdtekst-kleur: zwart bij Wit/Beige, wit bij alle andere tegel-
  // kleuren (bevestigd met de opdrachtgever). Regels met accent:true zijn
  // hier bewust NIET van afhankelijk — die houden altijd hun eigen vaste
  // accentkleur (per regel meegegeven). ---
  const kleurNaam = (data.kleur || '').toLowerCase();
  const hoofdtekstKleur = LICHTE_TEGELKLEUREN.some(k => kleurNaam.includes(k)) ? COLOR_BLACK : COLOR_WHITE;

  (ontwerp.regels || []).forEach(regel => {
    const font = fonts[regel.fontStijl];
    const kleur = regel.accent ? (regel.accentKleur || ontwerp.hart.kleur) : hoofdtekstKleur;
    const sizePt = regel.puntgrootteMm * MM;
    const textWidthPt = font.widthOfTextAtSize(regel.tekst, sizePt);
    const xPt = (PAGE_W_MM * MM - textWidthPt) / 2; // horizontaal gecentreerd
    page.drawText(regel.tekst, {
      x: xPt,
      y: fromTopMm(regel.topMm) - sizePt * 0.75, // tekst-baseline t.o.v. de top van de tekstregel (empirisch bepaald, zie opmeet-sessie)
      size: sizePt,
      font,
      color: kleur
    });
  });

  // --- Hartje: altijd de eigen, vaste kleur van dit ontwerp — nooit
  // afhankelijk van de tegelkleur. ---
  drawHart(page, ontwerp.hart);

  return doc.save();
}

module.exports = {
  generateTegelTekstPdf, isTegelTekstLineItem, matchTegelTekstOntwerp,
  extractTegelKleur, extractTegelTekstData, extractTegelTekstItemsFromOrder,
  TEGEL_TEKST_ONTWERPEN, LICHTE_TEGELKLEUREN
};
