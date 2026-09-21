const { PDFDocument } = require('pdf-lib');
const { MM, embedPhotoCoverRect } = require('./pdf-shared');

// Zelfde formaat als het muziekframe (200x300mm) — expliciet zo gevraagd,
// ongeacht wat de variant-titel ("S 20x13cm") verder suggereert; dat is
// vermoedelijk de zichtbare foto-afmeting in de fysieke houten standaard,
// niet de drukwerkbestand-afmeting.
const PAGE_W_MM = 200;
const PAGE_H_MM = 300;

function isPhotoFrameLineItem(li) {
  return /foto[\s-]?frame/i.test(li.title || '');
}

// Herkent de "S" (klein-formaat) variant, op basis van titel + variant —
// net zoals het muziekframe "klein"/"dik" herkent. Bevestigd: de variant-
// titel "S 20x13cm" IS de kleine variant. Bepaalt straks in welke submap
// (samen met het muziekframe, zie index.js) het drukwerkbestand terechtkomt.
function getPhotoFrameVariant(li) {
  const text = [li.title, li.variant_title].filter(Boolean).join(' ');
  if (/\bS\b/.test(text)) return 'klein';
  return null;
}

// Simpel product: geen tekst, geen hartje, geen stijlkeuze — alleen een
// foto (en optioneel een zwart-wit-filter) die de hele plaat beeldvullend
// moet vullen.
function extractPhotoFrameData(li) {
  const props = li.properties || [];
  const getProp = (regex) => {
    const p = props.find(p => regex.test(p.name || ''));
    return p ? String(p.value || '').trim() : '';
  };

  return {
    fotoFilter: getProp(/foto[\s-]?filter/i),
    photoUrl: getProp(/kies hier jouw favoriete foto/i)
  };
}

function extractPhotoFrameItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    if (!isPhotoFrameLineItem(li)) return;
    const data = extractPhotoFrameData(li);
    const variant = getPhotoFrameVariant(li);
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, variant, data });
    }
  });
  return items;
}

async function generatePhotoFramePdf(data) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W_MM * MM, PAGE_H_MM * MM]);

  if (data.photoUrl) {
    // embedPhotoCoverRect snijdt de foto bij tot de VOLLEDIGE plaat gevuld
    // is (cover-fit, geen witruimte), met dezelfde print-kleurbalans-
    // correctie als de andere producten (voorkomt #FFFFFF-"gaten" bij het
    // printen — expliciet gecontroleerd, ook voor een zwart-wit foto).
    const { image } = await embedPhotoCoverRect(doc, data.photoUrl, data.fotoFilter, PAGE_W_MM, PAGE_H_MM);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: PAGE_W_MM * MM,
      height: PAGE_H_MM * MM
    });
  }

  return doc.save();
}

module.exports = {
  generatePhotoFramePdf, isPhotoFrameLineItem, getPhotoFrameVariant, extractPhotoFrameData, extractPhotoFrameItemsFromOrder
};
