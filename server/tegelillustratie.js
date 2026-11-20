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
  },
  {
    id: 'pornstar-martini',
    // Titel in Shopify: "Tegeltje met Recept – Pornstar Martini" (de
    // "Tegeltje met Recept"-familie, vandaar de uitgebreide poort-check in
    // matchTegelIllustratieOntwerp hieronder). Vaste, volledig gekleurde
    // receptillustratie op een witte achtergrond; de klant kiest alleen het
    // formaat (10x10 of 13x13). Asset is gerenderd uit het aangeleverde EPS
    // (Pornstars_martini_recept.eps, 100x100mm) op 1575x1575px.
    herken: /pornstar\s*martini/i,
    assetBestand: 'pornstar-martini.jpg'
  },
  {
    id: 'meisje-met-de-parel',
    // Titel in Shopify: "WC Tegeltje – Meisje met de Parel" (derde titel-
    // familie, vandaar de uitgebreide poort-check hieronder). Vaste, volledig
    // gekleurde illustratie op witte achtergrond; de klant kiest alleen het
    // formaat (10x10 of 13x13). Asset: aangeleverde afbeelding (1254px),
    // opgeschaald naar 1575x1575 en bijna-wit naar zuiver wit gezet.
    herken: /meisje\s*met\s*de\s*parel/i,
    assetBestand: 'meisje-met-de-parel.jpg'
  },
  {
    id: 'driving-home-for-christmas',
    // Titel in Shopify: "Tegeltje Driving home for Christmas – auto met
    // kerstboom" (vierde titel-familie, zonder "met tekst"/"met recept" —
    // vandaar de uitgebreide poort-check hieronder). Vaste, volledig
    // gekleurde illustratie (goudkleurige auto + dennenboom) op een witte
    // achtergrond; de klant kiest alleen het formaat (10x10 of 13x13). Asset:
    // aangeleverde afbeelding (1254px), opgeschaald naar 1575x1575 en
    // bijna-wit naar zuiver wit gezet.
    herken: /driving\s*home\s*for\s*christmas/i,
    assetBestand: 'driving-home-for-christmas.jpg'
  },
  {
    id: 'lieve-zus-je-bent-sterker-dan-je-denkt',
    // Titel in Shopify: "Tegeltje met tekst - Lieve zus, je bent sterker dan
    // je denkt." Vaste, volledig gekleurde illustratie (tekst + roze
    // bloemen in vaas) op een witte achtergrond — alleen leverbaar op wit;
    // de klant kiest alleen het formaat (10x10 of 13x13). Asset: gerenderd uit
    // het aangeleverde PDF (Lieve_zus_je_bent_sterker_dan_je_denkt.pdf,
    // 100x100mm) op 1575x1575px, bijna-wit naar zuiver wit gezet.
    herken: /lieve\s*zus.*sterker\s*dan\s*je\s*denkt/i,
    assetBestand: 'lieve-zus-je-bent-sterker-dan-je-denkt.jpg'
  },
  {
    id: 'vier-het-leven',
    // Titel in Shopify: "Tegeltje met tekst - Vier het leven." Vaste, volledig
    // gekleurde illustratie (donkerblauwe tekst, vlaggetjes + confetti) op een
    // witte achtergrond; de klant kiest alleen het formaat (10x10 of 13x13).
    // Asset: gerenderd uit het aangeleverde PDF (Vier_het_leven.pdf, 100x100mm,
    // ingebedde CMYK-afbeelding 1254px) op 1575x1575px, bijna-wit naar zuiver
    // wit gezet.
    herken: /vier\s*het\s*leven/i,
    assetBestand: 'vier-het-leven.jpg'
  },
  // Landkaart-tegeltjes op plaatsnaam ("Landkaart tegeltje Nijmegen – stadskaart op keramiek"): vaste kaart per stad,
  // 2000x2000px drukbestand op de ai-foto-server. Wordt bij het eerste gebruik opgehaald en in DATA_DIR bewaard.
  // Orders MET een eigen AI-drukbestand (_AI drukbestand, kaartwidget) vallen hier bewust buiten.
  { id: 'landkaart-amsterdam', stad: true, herken: /landkaart.*\b(?:amsterdam)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/e9637ed597ce4db50d6272aee6cddc3e-print.jpg' },
  { id: 'landkaart-rotterdam', stad: true, herken: /landkaart.*\b(?:rotterdam)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/cce913f346ec5f15943def710e0b0557-print.jpg' },
  { id: 'landkaart-den-haag', stad: true, herken: /landkaart.*\b(?:den\s*haag|'s[-\s]?gravenhage)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/09880ca2a3709a312225ca8840bde70e-print.jpg' },
  { id: 'landkaart-utrecht', stad: true, herken: /landkaart.*\b(?:utrecht)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/d3e0378ddcfbab184759cc261443aa24-print.jpg' },
  { id: 'landkaart-eindhoven', stad: true, herken: /landkaart.*\b(?:eindhoven)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/e4c663d78d876980f1f10e204198e1b6-print.jpg' },
  { id: 'landkaart-groningen', stad: true, herken: /landkaart.*\b(?:groningen)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/7a8cd13720b965016e5bb80bf1e8aecf-print.jpg' },
  { id: 'landkaart-tilburg', stad: true, herken: /landkaart.*\b(?:tilburg)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/4b12e6fe1e059a79bd3abb520cdb2999-print.jpg' },
  { id: 'landkaart-almere', stad: true, herken: /landkaart.*\b(?:almere)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/2c3b78cb23a8349885f1c46ae1753f5e-print.jpg' },
  { id: 'landkaart-breda', stad: true, herken: /landkaart.*\b(?:breda)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/cf071655acbc163eed2814b7addb628f-print.jpg' },
  { id: 'landkaart-nijmegen', stad: true, herken: /landkaart.*\b(?:nijmegen)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/03dbaa33b0b851d3e7ab92e96afcfa72-print.jpg' },
  { id: 'landkaart-arnhem', stad: true, herken: /landkaart.*\b(?:arnhem)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/84a715006dd2ebb127893144c0b81fdc-print.jpg' },
  { id: 'landkaart-haarlem', stad: true, herken: /landkaart.*\b(?:haarlem)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/69ff83dabeb841ef02362bfce5f45ddd-print.jpg' },
  { id: 'landkaart-enschede', stad: true, herken: /landkaart.*\b(?:enschede)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/ef67c9c74ee5aa082b8c4bc3d8f70c80-print.jpg' },
  { id: 'landkaart-apeldoorn', stad: true, herken: /landkaart.*\b(?:apeldoorn)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/b1a7fe4ca93561bfc8567fe255cce895-print.jpg' },
  { id: 'landkaart-amersfoort', stad: true, herken: /landkaart.*\b(?:amersfoort)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/749e0e9199366a4456454bf4459e3649-print.jpg' },
  { id: 'landkaart-zwolle', stad: true, herken: /landkaart.*\b(?:zwolle)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/37ef264c631f6146f4b6c87f076b571b-print.jpg' },
  { id: 'landkaart-leiden', stad: true, herken: /landkaart.*\b(?:leiden)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/7c801914ec97fb04dae536896d28db7e-print.jpg' },
  { id: 'landkaart-maastricht', stad: true, herken: /landkaart.*\b(?:maastricht)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/ee17a768a5a4609ce330ad0553ab3dcf-print.jpg' },
  { id: 'landkaart-dordrecht', stad: true, herken: /landkaart.*\b(?:dordrecht)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/835339dff3949cf937fcd9083229bd9b-print.jpg' },
  { id: 'landkaart-delft', stad: true, herken: /landkaart.*\b(?:delft)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/6d8d6220e98b243fccc101c095978282-print.jpg' },
  { id: 'landkaart-den-bosch', stad: true, herken: /landkaart.*\b(?:den\s*bosch|'s[-\s]?hertogenbosch)\b/i, bronUrl: 'https://ai-foto.socialframe.nl/files/8cb26b65e3fdebe29b95d5934a2a7525-print.jpg' }
];

function matchTegelIllustratieOntwerp(li) {
  const titel = li.title || '';
  if (!/tegeltje met (tekst|recept)|wc\s*tegeltje|tegeltje\s+driving\s*home|landkaart\s*tegeltje/i.test(titel)) return null;
  const heeftEigenAiBestand = (li.properties || []).some(p => /^_?\s*AI drukbestand/i.test(p.name || ''));
  return ONTWERPEN.find(o => o.herken.test(titel) && !(o.stad && heeftEigenAiBestand)) || null;
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
      items.push({ title: li.title, lineItemId: li.id, data: { ontwerp, is13x13 } });
    }
  });
  return items;
}

// Vaste asset uit de repo, of (landkaart-steden) eenmalig downloaden van de ai-foto-server en cachen in DATA_DIR.
async function laadOntwerpAfbeelding(ontwerp) {
  if (ontwerp.assetBestand) return fs.readFileSync(path.join(__dirname, 'tegel-illustratie-assets', ontwerp.assetBestand));
  const dir = path.join(process.env.DATA_DIR || require('os').tmpdir(), 'tegel-illustratie-cache');
  const cachePad = path.join(dir, ontwerp.id + '.jpg');
  try { return fs.readFileSync(cachePad); } catch { /* nog niet gecachet */ }
  const axios = require('axios');
  const res = await axios.get(ontwerp.bronUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const buf = Buffer.from(res.data);
  if (buf.length < 10000) throw new Error('Kaartafbeelding voor ' + ontwerp.id + ' lijkt leeg of ongeldig');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cachePad, buf); } catch { /* cache is optioneel */ }
  return buf;
}

async function generateTegelIllustratiePdf(data) {
  const buffer = await laadOntwerpAfbeelding(data.ontwerp);
  const sizeCm = data.is13x13 ? 13 : 10;
  return imageBufferToPrintPdf(buffer, { widthCm: sizeCm, heightCm: sizeCm, dpi: 300 });
}

module.exports = {
  generateTegelIllustratiePdf, isTegelIllustratieLineItem, matchTegelIllustratieOntwerp,
  isTegelIllustratie13x13, extractTegelIllustratieItemsFromOrder, ONTWERPEN
};
