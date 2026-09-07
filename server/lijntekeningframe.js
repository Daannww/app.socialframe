const { PDFDocument, rgb } = require('pdf-lib');
const sharp = require('sharp');
const { MM, heeftEchteTransparantie, fetchMetHerpogingen } = require('./pdf-shared');

// Zelfde patroon als AUTOPICTURA_REGEX in server/shopify.js — hier los
// gedupliceerd (i.p.v. te exporteren/importeren) om geen onnodige wijziging
// in dat bestand te hoeven maken voor dit nieuwe, op zichzelf staande
// product.
const AUTOPICTURA_REGEX = /(https?:\/\/[^\s"'<>]*autopictura[^\s"'<>]*)/gi;

// De 4 bestelbare formaten — alleen de 2 zijdematen, GEEN vaste breedte/
// hoogte-toewijzing: welke zijde de breedte wordt en welke de hoogte hangt
// af van de oriëntatie van de foto zelf (zie generateLijntekeningFramePdf
// hieronder) — een staande foto krijgt een staand canvas, een liggende foto
// een liggend canvas. LET OP: "70x50cm" is bij dit product (zowel de
// ingelijste als de acrylglas-variant) in werkelijkheid 70x48cm fysiek, een
// bewuste afwijking van het "ronde" marketingformaat op de website.
const FORMATEN = [
  { herken: /70\s*x\s*50/i, zijdeACm: 70, zijdeBCm: 48 },
  { herken: /50\s*x\s*40/i, zijdeACm: 50, zijdeBCm: 40 },
  { herken: /50\s*x\s*50/i, zijdeACm: 50, zijdeBCm: 50 }
];

function isLijntekeningFrameLineItem(li) {
  return /lijntekening.*portret.*lijst/i.test(li.title || '');
}

// Het formaat staat, net als bij andere meerdere-varianten-producten in dit
// project, gewoon in de producttitel zelf vermeld (bv. "... – Ingelijst
// 50x40cm") — dus titel + variant_title samen doorzoeken, net zoals bij het
// muziekframe se "klein"/"dik"-herkenning.
function getLijntekeningFrameFormaat(li) {
  const text = [li.title, li.variant_title].filter(Boolean).join(' ');
  return FORMATEN.find(f => f.herken.test(text)) || null;
}

function extractLijntekeningFrameData(li) {
  const props = li.properties || [];
  let designLink = null;
  for (const p of props) {
    const m = String(p.value || '').match(AUTOPICTURA_REGEX);
    if (m) { designLink = m[0]; break; }
  }
  return { photoUrl: designLink, formaat: getLijntekeningFrameFormaat(li) };
}

function extractLijntekeningFrameItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    if (!isLijntekeningFrameLineItem(li)) return;
    const data = extractLijntekeningFrameData(li);
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, data });
    }
  });
  return items;
}

// Marge die ALTIJD vrij moet blijven tussen de foto en de rand van het
// formaat (op verzoek: minimaal 2cm rondom).
const MARGE_MM = 20;

// Simpele foto-inbedding ZONDER de gebruikelijke Y+8%-CMYK-anti-gaten-
// correctie die embedPhoto/embedPhotoCoverRect elders in dit project altijd
// toepassen — voor dit specifieke product expliciet niet gewenst ("dit
// product heeft geen last van gaten"). Alleen EXIF-rotatie + verkleinen
// (nooit vergroten) + inbedden, verder de kleuren van de bron-afbeelding
// volledig ongemoeid. Wél nog de bestaande transparantie-detectie
// hergebruikt (PNG i.p.v. JPEG als de foto echte transparantie bevat), puur
// om diezelfde (losstaande) verbetering hier ook te laten gelden — dat is
// geen kleurCORRECTIE, alleen een formaatkeuze.
async function embedPhotoOngewijzigd(doc, photoUrl, maxZijdeMm) {
  const imgRes = await fetchMetHerpogingen(photoUrl, { responseType: 'arraybuffer' });
  const rotatedBuffer = await sharp(Buffer.from(imgRes.data)).rotate().toBuffer();
  const metadata = await sharp(rotatedBuffer).metadata();
  const aspectRatio = metadata.width / metadata.height;

  const maxZijdePx = Math.ceil((maxZijdeMm / 25.4) * 300);
  const resizedBuffer = await sharp(rotatedBuffer)
    .resize({ width: maxZijdePx, height: maxZijdePx, fit: 'inside', withoutEnlargement: true })
    .toBuffer();

  if (await heeftEchteTransparantie(resizedBuffer)) {
    const pngBuffer = await sharp(resizedBuffer).png().toBuffer();
    const image = await doc.embedPng(pngBuffer);
    return { image, aspectRatio };
  }
  const jpegBuffer = await sharp(resizedBuffer).jpeg({ quality: 95 }).toBuffer();
  const image = await doc.embedJpg(jpegBuffer);
  return { image, aspectRatio };
}

async function generateLijntekeningFramePdf(data) {
  if (!data.formaat) {
    throw new Error('Kon het bestelde formaat niet herkennen uit de producttitel/variant.');
  }
  if (!data.photoUrl) {
    throw new Error('Geen autopictura-ontwerplink gevonden op deze order.');
  }

  const { zijdeACm, zijdeBCm } = data.formaat;

  // Foto eerst ophalen (nodig om de eigen oriëntatie te bepalen, VOORDAT we
  // weten of het canvas straks liggend of staand moet zijn).
  const targetZoneMm = Math.max(zijdeACm, zijdeBCm) * 10; // ruim voldoende voor de langste zijde
  const doc = await PDFDocument.create();
  const { image, aspectRatio } = await embedPhotoOngewijzigd(doc, data.photoUrl, targetZoneMm);

  // Canvas-oriëntatie volgt de foto: een staande foto (aspectRatio < 1)
  // krijgt een staand canvas (de kleinste zijdemaat als breedte, de
  // grootste als hoogte), een liggende foto (aspectRatio > 1) een liggend
  // canvas — i.p.v. altijd een vaste breedte/hoogte-toewijzing te gebruiken.
  // Bij een vierkant formaat (zijdeACm === zijdeBCm) maakt dit toch niets uit.
  const staand = aspectRatio < 1;
  const pageWMm = (staand ? Math.min(zijdeACm, zijdeBCm) : Math.max(zijdeACm, zijdeBCm)) * 10;
  const pageHMm = (staand ? Math.max(zijdeACm, zijdeBCm) : Math.min(zijdeACm, zijdeBCm)) * 10;

  const page = doc.addPage([pageWMm * MM, pageHMm * MM]);

  // Achtergrond: bewust LETTERLIJK puur wit (#FFFFFF) — dit product heeft
  // geen last van print-gaten, dus GEEN 1%-gele CMYK-truc hier (in
  // tegenstelling tot bijna alle andere producten in dit project). Geldt
  // zowel voor dit vlak als voor de foto zelf (zie embedPhotoOngewijzigd
  // hierboven, die bewust GEEN kleurcorrectie toepast).
  page.drawRectangle({ x: 0, y: 0, width: pageWMm * MM, height: pageHMm * MM, color: rgb(1, 1, 1) });

  // Beschikbare ruimte voor de foto: het volledige (nu bekende) canvas, min
  // de marge rondom aan ALLE kanten (dus 2x de marge eraf per richting).
  const beschikbareBreedteMm = pageWMm - 2 * MARGE_MM;
  const beschikbareHoogteMm = pageHMm - 2 * MARGE_MM;
  const beschikbareVerhouding = beschikbareBreedteMm / beschikbareHoogteMm;

  let renderBreedteMm, renderHoogteMm;
  if (aspectRatio >= beschikbareVerhouding) {
    renderBreedteMm = beschikbareBreedteMm;
    renderHoogteMm = beschikbareBreedteMm / aspectRatio;
  } else {
    renderHoogteMm = beschikbareHoogteMm;
    renderBreedteMm = beschikbareHoogteMm * aspectRatio;
  }
  const renderXMm = (pageWMm - renderBreedteMm) / 2;
  const renderYMm = (pageHMm - renderHoogteMm) / 2;

  page.drawImage(image, {
    x: renderXMm * MM,
    y: renderYMm * MM,
    width: renderBreedteMm * MM,
    height: renderHoogteMm * MM
  });

  // Dun lichtgrijs snijlijntje rondom de volledige buitenrand — puur een
  // visuele snijhulplijn (op verzoek), geen onderdeel van het ontwerp zelf.
  const SNIJLIJN_KLEUR = rgb(0.75, 0.75, 0.75);
  const SNIJLIJN_DIKTE_MM = 0.3;
  page.drawRectangle({
    x: (SNIJLIJN_DIKTE_MM / 2) * MM,
    y: (SNIJLIJN_DIKTE_MM / 2) * MM,
    width: (pageWMm - SNIJLIJN_DIKTE_MM) * MM,
    height: (pageHMm - SNIJLIJN_DIKTE_MM) * MM,
    borderColor: SNIJLIJN_KLEUR,
    borderWidth: SNIJLIJN_DIKTE_MM * MM
  });

  return doc.save();
}

module.exports = {
  generateLijntekeningFramePdf, isLijntekeningFrameLineItem, getLijntekeningFrameFormaat,
  extractLijntekeningFrameData, extractLijntekeningFrameItemsFromOrder
};
