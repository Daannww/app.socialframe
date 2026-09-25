const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, cmyk, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const {
  MM, embedPhotoCoverRectGeenAntiGaten, drawImageMetAfgerondeHoeken,
  nearWhiteCmyk, splitTextEmoji, preloadEmojiImages, drawMixedText,
  fitFontSizeToWidth, measureMixedTextWidth
} = require('./pdf-shared');

// --- "Foto tegel met 3 foto's" — jouw-foto-op-keramiek-tegel met 3 losse
// foto's naast elkaar (van links naar rechts) in afgeronde vakken, plus een
// eigen (optioneel) onderschrift per foto met klant-gekozen lettergrootte en
// -kleur. Beschikbaar in 10x10 en 13x13cm — net als de andere tegel-achtige
// producten in dit project (autopictura, "Gepersonaliseerde foto tegel",
// tegelillustratie): de klant kiest het formaat via de variant (hier "Houten-
// houder / 13x13" — het FORMAAT staat hier, i.p.v. bij de andere producten,
// als TWEEDE deel van de varianttitel, dus niet zomaar hergebruikt uit
// shopify.js se extractTileItemsFromOrder).
//
// Alle posities/maten hieronder zijn uit het aangeleverde sjabloon-PDF
// (c9ea5c5d-3_foto_sjabloon.pdf, 100x100mm referentiecanvas) gehaald via
// pikepdf content-stream-parsing — dezelfde vector-extractietechniek als
// elders in dit project. Voor het daadwerkelijke drukwerkbestand wordt alles
// (posities EN lettergroottes) evenredig geschaald met de gekozen fysieke
// tegelmaat (10cm of 13cm) t.o.v. dit 100mm-referentiecanvas.
const REFERENTIE_MM = 100;

// De 3 foto-vakken (afgeronde rechthoeken), van links naar rechts.
const FOTOVAKKEN = [
  { xMm: 5.057, topMm: 32.744, breedteMm: 27.833, hoogteMm: 27.000 },
  { xMm: 36.079, topMm: 32.744, breedteMm: 27.833, hoogteMm: 27.000 },
  { xMm: 67.101, topMm: 32.744, breedteMm: 27.833, hoogteMm: 27.000 }
];
const FOTOVAK_RADIUS_MM = 0.9785;

// Onderschrift-tekst: 1 gedeelde basislijn-hoogte voor alle 3 (de kleine
// onderlinge verschillen in het sjabloon — 69.96/69.71/69.99mm — kwamen
// overduidelijk van het met de hand verslepen van de PLACEHOLDER-tekst
// "Tekst 1/2/3" en zijn geen bewuste ontwerpkeuze; hier dus 1 consistente
// hoogte). Elke tekst wordt HORIZONTAAL GECENTREERD in zijn eigen foto-vak
// i.p.v. het sjabloon se vaste x-startpunt te hergebruiken (dat was
// gekalibreerd op de specifieke breedte van de placeholder-tekst, en klopt
// dus niet meer zodra de klant iets anders/langers invult).
const TEKST_BASELINE_TOP_MM = 69.9;

// --- Klein hartje-icoontje tussen elke foto en zijn onderschrift (ontdekt
// bij het visueel vergelijken van het gerenderde sjabloon met de eerste
// testrender — stond niet in de aanvraag zelf, maar hoort duidelijk bij het
// sjabloon: 3 identieke kleine hartjes, 1 per kolom, rechtstreeks uit het
// sjabloon geextraheerd (zelfde vector-decoratietechniek als elders in dit
// project). Het sjabloon geeft de hartjes GEEN eigen kleur mee (ze delen de
// tekstkleur-instructie uit dezelfde BT/ET-tekstblok als de onderschriften),
// dus hier: elk hartje volgt de kleur van ZIJN EIGEN onderschrift, en wordt
// (net als het onderschrift) overgeslagen als er geen tekst is ingevuld voor
// die foto. ---
// LET OP: pdf-lib se drawSvgPath flipt bij het tekenen ALLEEN de Y-as (SVG is
// y-down, PDF is y-up) — de X-as blijft ongewijzigd. De eerste versie van
// deze pad-string negeerde per ongeluk OOK de X-waarden (i.p.v. alleen Y),
// waardoor het hartje links-rechts gespiegeld/verschoven werd getekend en
// dus niet meer gecentreerd onder de foto stond. Hieronder de gecorrigeerde
// versie: X-waarden exact zoals in het sjabloon (negatief, want de vorm ligt
// t.o.v. het ankerpunt naar LINKS), alleen Y genegeerd t.o.v. het PDF-bronbestand.
const HART_PAD = 'M 0.000,0.000 C 0.000,1.074 -0.687,2.457 -2.866,3.423 C -5.044,2.457 -5.731,1.074 -5.731,0.000 C -5.731,-0.770 -5.078,-1.393 -4.271,-1.393 C -3.603,-1.393 -3.039,-0.965 -2.866,-0.380 C -2.693,-0.965 -2.129,-1.393 -1.460,-1.393 C -0.654,-1.393 0.000,-0.770 0.000,0.000 Z';
const HARTJES = [
  { xMm: 19.986, topMm: 62.247 },
  { xMm: 51.005, topMm: 62.247 },
  { xMm: 82.024, topMm: 62.247 }
];

// --- Kleuropties voor de onderschrift-tekst — exact de "Optiewaarden" van
// het Shopify-optietype "Kleur" voor dit product (screenshot ontvangen van
// de opdrachtgever, hex hieronder afgelezen uit de kleurstalen in die
// lijst). "Wit" is bewust NIET letterlijk #FFFFFF (zie nearWhiteCmyk
// hieronder) — net als overal elders in dit project. Onbekende/lege
// kleurnaam valt terug op zwart, zodat de tekst nooit onzichtbaar wordt. ---
const KLEUR_TEKST_HEX = {
  zwart: '#000000',
  antraciet: '#383838',
  wit: null, // speciaal: nearWhiteCmyk (zie kleurNaarPdfKleur hieronder)
  zachtblauw: '#ABC8EE',
  lichtgeel: '#F5E3A9',
  lichtroze: '#ECACB8',
  mintgroen: '#B6E5D9',
  lavendel: '#CCA9D1',
  zachtperzik: '#EDC4A8',
  lichtgrijs: '#D1D1D1',
  lichtgroen: '#C9E5BD',
  beige: '#EFE3C9'
};

function normaliseerKleurNaam(naam) {
  return (naam || '').toLowerCase().replace(/[^a-z]/g, '');
}

function hexNaarRgbKleur(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return rgb(0, 0, 0);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function kleurNaarPdfKleur(naam) {
  const key = normaliseerKleurNaam(naam);
  if (key === 'wit') return nearWhiteCmyk(cmyk);
  const hex = KLEUR_TEKST_HEX[key];
  if (!hex) return rgb(0, 0, 0); // onbekende naam -> zwart (nooit onzichtbaar)
  return hexNaarRgbKleur(hex);
}

// Herkent het product "Foto tegel met 3 foto's" (of vergelijkbare
// schrijfwijzen). Pas deze regex aan als de exacte producttitel in Shopify
// net anders geschreven blijkt te zijn.
function isFotoTegel3LineItem(li) {
  return /foto\s*tegel\s*met\s*3\s*foto/i.test(li.title || '');
}

// Het formaat staat bij dit product als TWEEDE deel van de varianttitel
// (bv. "Houten-houder / 13x13"), i.p.v. het eerste deel zoals bij de
// tegelkleur-producten — dus gewoon de hele varianttitel doorzoeken op
// "13x13" (net als de andere tegel-achtige producten in dit project doen op
// hun volledige tekst-blob).
function isFotoTegel3_13x13(li) {
  const props = li.properties || [];
  const textBlob = [li.title, li.variant_title, ...props.map(p => `${p.name} ${p.value}`)].join(' ');
  return /13\s*x\s*13/i.test(textBlob);
}

// Haalt de 3 foto-URL's en de 3 (optionele) onderschriften uit de
// properties. De property-namen die deze personalisatie-app aanlevert
// bevatten kennelijk per veld een net iets andere afsluitende leestekens
// ("Tekst 1::", "Kleur tekst:", "Kleur tekst::", "Kleur tekst.:" — zie het
// voorbeeld-order) — vermoedelijk om naam-botsingen in de designer-tool te
// vermijden. "Foto N"/"Tekst N"/"_font size Tekst N" zijn gelukkig wel met
// een cijfer te matchen; voor "Kleur tekst" (geen cijfer, 3x dezelfde
// naam-vorm-familie) wordt aangenomen dat de 3 voorkomens in
// aanlevervolgorde bij Tekst 1/2/3 horen — geef door als dat een keer niet
// klopt, dan stel ik de matching bij zodra ik een order zie waar het misgaat.
function extractFotoTegel3Data(li) {
  const props = li.properties || [];

  const getProp = (regex) => {
    const p = props.find(p => regex.test(p.name || ''));
    return p ? String(p.value || '').trim() : '';
  };

  const photoUrls = [1, 2, 3].map(n => getProp(new RegExp(`^foto\\s*${n}\\b`, 'i')));

  const kleurProps = props.filter(p => /kleur\s*tekst/i.test(p.name || ''));

  const teksten = [1, 2, 3].map((n, i) => {
    const tekst = getProp(new RegExp(`^tekst\\s*${n}\\b`, 'i'));
    const sizeRaw = getProp(new RegExp(`^_font size tekst\\s*${n}\\b`, 'i'));
    const sizePt = parseFloat(sizeRaw.replace(',', '.'));
    const kleurNaam = kleurProps[i] ? String(kleurProps[i].value || '').trim() : '';
    return {
      tekst,
      sizePt: Number.isFinite(sizePt) && sizePt > 0 ? sizePt : 12,
      kleurNaam
    };
  });

  return {
    photoUrls,
    teksten,
    is13x13: isFotoTegel3_13x13(li)
  };
}

function extractFotoTegel3ItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    if (!isFotoTegel3LineItem(li)) return;
    const data = extractFotoTegel3Data(li);
    if (!data.photoUrls.some(Boolean)) return; // geen enkele foto aangeleverd -> niets te genereren
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, lineItemId: li.id, data });
    }
  });
  return items;
}

// Laadt het Sacramento-lettertype (het schrijflettertype uit het sjabloon)
// als het bestand aanwezig is in server/fonts/ — anders terugval op een
// ingebouwd PDF-standaardlettertype (Helvetica), net als bij de andere
// producten in dit project wanneer een eigen lettertypebestand ontbreekt.
// Zie server/fonts/LEES-MIJ.txt voor hoe het echte bestand toe te voegen.
async function laadOnderschriftFont(doc) {
  const bestandsPad = path.join(__dirname, 'fonts', 'Sacramento-Regular.ttf');
  if (fs.existsSync(bestandsPad)) {
    return doc.embedFont(fs.readFileSync(bestandsPad));
  }
  console.warn('[fototegel3] Sacramento-Regular.ttf niet gevonden in server/fonts/ — val terug op Helvetica. Zie server/fonts/LEES-MIJ.txt.');
  return doc.embedFont(StandardFonts.Helvetica);
}

async function generateFotoTegel3Pdf(data) {
  const sizeMm = data.is13x13 ? 130 : 100;
  const schaal = sizeMm / REFERENTIE_MM;

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([sizeMm * MM, sizeMm * MM]);

  function fromTopMm(topMm) {
    return (sizeMm - topMm * schaal) * MM;
  }

  // --- De 3 foto's, van links naar rechts, elk cover-fit bijgesneden tot
  // zijn eigen vak en afgerond via een vector-knipmasker (GEEN anti-gaten-
  // kleurcorrectie — expliciet niet nodig voor dit product). Een lege/
  // ontbrekende foto-URL slaat gewoon dat ene vak over (blijft leeg) i.p.v.
  // de hele generatie te laten mislukken. ---
  for (let i = 0; i < FOTOVAKKEN.length; i++) {
    const url = data.photoUrls[i];
    if (!url) continue;
    const vak = FOTOVAKKEN[i];
    const breedteMm = vak.breedteMm * schaal;
    const hoogteMm = vak.hoogteMm * schaal;
    const { image } = await embedPhotoCoverRectGeenAntiGaten(doc, url, breedteMm, hoogteMm);
    const xPt = vak.xMm * schaal * MM;
    const yPt = fromTopMm(vak.topMm + vak.hoogteMm); // onderkant van het vak (drawImage-oorsprong is linksonder)
    drawImageMetAfgerondeHoeken(page, image, {
      x: xPt, y: yPt, width: breedteMm * MM, height: hoogteMm * MM,
      radiusPt: FOTOVAK_RADIUS_MM * schaal * MM
    });
  }

  // --- De 3 (optionele) onderschriften, gecentreerd onder hun eigen foto. ---
  const font = await laadOnderschriftFont(doc);
  const emojiCache = await preloadEmojiImages(doc, data.teksten.map(t => t.tekst || ''));
  const baselineYPt = fromTopMm(TEKST_BASELINE_TOP_MM);

  for (let i = 0; i < FOTOVAKKEN.length; i++) {
    const info = data.teksten[i];
    if (!info || !info.tekst) continue;
    const vak = FOTOVAKKEN[i];
    const parts = splitTextEmoji(info.tekst);
    const gewensteSizePt = info.sizePt * schaal;
    const maxWidthPt = vak.breedteMm * schaal * MM;
    const sizePt = fitFontSizeToWidth(parts, font, gewensteSizePt, maxWidthPt, gewensteSizePt * 0.5);
    const tekstBreedtePt = measureMixedTextWidth(parts, font, sizePt);
    const cellCenterXPt = (vak.xMm + vak.breedteMm / 2) * schaal * MM;
    const xPt = cellCenterXPt - tekstBreedtePt / 2;
    const kleur = kleurNaarPdfKleur(info.kleurNaam);
    drawMixedText(page, parts, font, sizePt, xPt, baselineYPt, kleur, emojiCache);

    // Hartje boven dit onderschrift, in dezelfde kleur.
    const hart = HARTJES[i];
    page.drawSvgPath(HART_PAD, {
      x: hart.xMm * schaal * MM,
      y: fromTopMm(hart.topMm),
      scale: schaal,
      color: kleur
    });
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

module.exports = {
  generateFotoTegel3Pdf, isFotoTegel3LineItem, isFotoTegel3_13x13,
  extractFotoTegel3Data, extractFotoTegel3ItemsFromOrder,
  KLEUR_TEKST_HEX, FOTOVAKKEN
};
