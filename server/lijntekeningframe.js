const { PDFDocument, rgb } = require('pdf-lib');
const axios = require('axios');
const { MM, embedPhoto } = require('./pdf-shared');

// Zelfde patroon als AUTOPICTURA_REGEX in server/shopify.js — hier los
// gedupliceerd (i.p.v. te exporteren/importeren) om geen onnodige wijziging
// in dat bestand te hoeven maken voor dit nieuwe, op zichzelf staande
// product.
const AUTOPICTURA_REGEX = /(https?:\/\/[^\s"'<>]*autopictura[^\s"'<>]*)/gi;

// De 4 bestelbare formaten — LET OP: "70x50cm" is bij dit product (zowel de
// ingelijste als de acrylglas-variant) in werkelijkheid 70x48cm fysiek, een
// bewuste afwijking van het "ronde" marketingformaat op de website.
const FORMATEN = [
  { herken: /70\s*x\s*50/i, breedteCm: 70, hoogteCm: 48 },
  { herken: /50\s*x\s*40/i, breedteCm: 50, hoogteCm: 40 },
  { herken: /50\s*x\s*50/i, breedteCm: 50, hoogteCm: 50 }
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

async function generateLijntekeningFramePdf(data) {
  if (!data.formaat) {
    throw new Error('Kon het bestelde formaat niet herkennen uit de producttitel/variant.');
  }
  const pageWMm = data.formaat.breedteCm * 10;
  const pageHMm = data.formaat.hoogteCm * 10;

  const doc = await PDFDocument.create();
  const page = doc.addPage([pageWMm * MM, pageHMm * MM]);

  // Achtergrond: bewust LETTERLIJK puur wit (#FFFFFF), op expliciet verzoek
  // — dit is een uitzondering op de "nooit puur wit"-anti-gaten-regel die
  // verder in dit project overal geldt (zie de transparante-foto's- en
  // QR-code-fixes). De foto zelf (hieronder, via embedPhoto) krijgt nog wel
  // gewoon de gebruikelijke kleurcorrectie mee — dit gaat alleen over het
  // vlak ERBUITEN.
  page.drawRectangle({ x: 0, y: 0, width: pageWMm * MM, height: pageHMm * MM, color: rgb(1, 1, 1) });

  if (data.photoUrl) {
    // Beschikbare ruimte voor de foto: het volledige formaat, min de marge
    // rondom aan ALLE kanten (dus 2x de marge eraf per richting).
    const beschikbareBreedteMm = pageWMm - 2 * MARGE_MM;
    const beschikbareHoogteMm = pageHMm - 2 * MARGE_MM;

    // embedPhoto regelt het ophalen/roteren/kleurcorrigeren en geeft de
    // eigen beeldverhouding van de foto terug — de uiteindelijke plaatsing
    // (welke richting precies de volle beschikbare ruimte vult, en de rest
    // proportioneel meeschaalt) bepalen we hieronder zelf, voor dit
    // rechthoekige (niet per se vierkante) beschikbare vak.
    const targetZoneMm = Math.max(beschikbareBreedteMm, beschikbareHoogteMm);
    const { image, aspectRatio } = await embedPhoto(doc, data.photoUrl, null, targetZoneMm);

    const beschikbareVerhouding = beschikbareBreedteMm / beschikbareHoogteMm;
    let renderBreedteMm, renderHoogteMm;
    if (aspectRatio >= beschikbareVerhouding) {
      // Foto is verhoudingsgewijs breder dan het beschikbare vak -> breedte
      // vult de volle beschikbare breedte, hoogte schaalt proportioneel mee
      // (en blijft dus binnen de beschikbare hoogte).
      renderBreedteMm = beschikbareBreedteMm;
      renderHoogteMm = beschikbareBreedteMm / aspectRatio;
    } else {
      // Foto is verhoudingsgewijs smaller/hoger -> hoogte vult de volle
      // beschikbare hoogte, breedte schaalt proportioneel mee (en blijft
      // dus binnen de beschikbare breedte) — bv. het door de gebruiker
      // genoemde geval van een smallere foto in een brede lijst.
      renderHoogteMm = beschikbareHoogteMm;
      renderBreedteMm = beschikbareHoogteMm * aspectRatio;
    }
    const renderXMm = (pageWMm - renderBreedteMm) / 2;
    const renderYMm = (pageHMm - renderHoogteMm) / 2; // PDF-Y vanaf onder — bij verticaal centreren is "vanaf onder" en "vanaf boven" hetzelfde getal

    page.drawImage(image, {
      x: renderXMm * MM,
      y: renderYMm * MM,
      width: renderBreedteMm * MM,
      height: renderHoogteMm * MM
    });
  }

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
