const fs = require('fs');
const path = require('path');
const { imageBufferToPrintPdf } = require('./printfile');

// Vaste-illustratie-tegeltjes: net als de "Tegeltje met tekst"-ontwerpen in
// texttile.js qua producttitel-familie, maar FUNDAMENTEEL anders van aard —
// dit zijn kant-en-klare, volledig gekleurde aquarel-illustraties (geen
// zwart/wit-lijntekening die per tegelkleur van kleur wisselt) die
// rechtstreeks als vaste JPEG-afbeelding worden geprint, in de klant se
// keuze van 10x10 of 13x13cm — exact hetzelfde protocol als de bestaande
// autopictura-tegeltjes (zie imageBufferToPrintPdf in server/printfile.js,
// inclusief de Y+8%-anti-gaten-kleurcorrectie die daar al ingebouwd zit).
// Geen kleurwissel-logica nodig (past dus niet in het texttile.js-systeem,
// dat daar juist omheen gebouwd is) en geen klant-aanpassingen (vaste
// tekst/illustratie, de klant kiest alleen het formaat).
const ONTWERPEN = [
  {
    id: 'dat-dit-huis-gevuld-met-liefde',
    // Titel in Shopify: "Tegeltje met tekst – Dat dit huis gevuld mag zijn
    // met liefde, vrolijkheid en zonneschijn."
    herken: /dat\s*dit\s*huis\s*gevuld\s*mag\s*zijn\s*met\s*liefde/i,
    assetBestand: 'dat-dit-huis-gevuld-met-liefde.jpg'
  }
];

function matchTegelIllustratieOntwerp(li) {
  const titel = li.title || '';
  if (!/tegeltje met tekst/i.test(titel)) return null;
  return ONTWERPEN.find(o => o.herken.test(titel)) || null;
}

function isTegelIllustratieLineItem(li) {
  return matchTegelIllustratieOntwerp(li) !== null;
}

// Zelfde 10x13-detectie als de autopictura-tegeltjes (extractTileItemsFromOrder
// in server/shopify.js): titel + variant + properties samen doorzoeken,
// standaard 10x10 tenzij "13x13" ergens voorkomt.
function isTegelIllustratie13x13(li) {
  const props = li.properties || [];
  const textBlob = [li.title, li.variant_title, ...props.map(p => `${p.name} ${p.value}`)].join(' ');
  return /13\s*x\s*13/i.test(textBlob);
}

function extractTegelIllustratieItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    const ontwerp = matchTegelIllustratieOntwerp(li);
    if (!ontwerp) return;
    const is13x13 = isTegelIllustratie13x13(li);
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, data: { ontwerp, is13x13 } });
    }
  });
  return items;
}

async function generateTegelIllustratiePdf(data) {
  const assetPad = path.join(__dirname, 'tegel-illustratie-assets', data.ontwerp.assetBestand);
  const buffer = fs.readFileSync(assetPad);
  const sizeCm = data.is13x13 ? 13 : 10;
  return imageBufferToPrintPdf(buffer, { widthCm: sizeCm, heightCm: sizeCm, dpi: 300 });
}

module.exports = {
  generateTegelIllustratiePdf, isTegelIllustratieLineItem, matchTegelIllustratieOntwerp,
  isTegelIllustratie13x13, extractTegelIllustratieItemsFromOrder, ONTWERPEN
};
