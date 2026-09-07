const { PDFDocument, StandardFonts, cmyk } = require('pdf-lib');
const { MM } = require('./pdf-shared');

// Afmetingen + tekstpositie 1-op-1 gemeten uit het door de gebruiker
// aangeleverde referentiebestand ("kentekensjabloon.pdf", voertuig "Auto")
// — bevestigd: de voorbeeldtekst "HIER DE TEKST" staat daar exact
// horizontaal gecentreerd (x-midden = exact de helft van de paginabreedte)
// op 45.35pt (16,00mm) lettergrootte, met de top van de tekst op 120,44mm
// vanaf boven. Kleur in het referentiebestand: CMYK(0, 0, 0.01, 0) — de
// bekende "1%-gele" anti-gaten-truc die verder in dit hele project wordt
// gebruikt voor bijna-wit — bevestigt dat dit product op een DONKER/ZWART
// fysiek materiaal print (de tekst zou anders onzichtbaar zijn).
// LET OP: alleen het "Auto"-voertuig-sjabloon is aangeleverd; een ander
// voertuigtype (zie de "Kies hier het voertuig"-eigenschap) heeft mogelijk
// een ander formaat — dat is nu niet bekend/ondersteund.
const VOERTUIG_FORMATEN = {
  auto: { breedteMm: 526.0, hoogteMm: 132.5, standaardTopMm: 120.44 }
};
const STANDAARD_LETTERGROOTTE_MM = 16.00;
const MARGE_MM = 10; // 1cm, op verzoek — minimaal vrij te houden aan weerszijden van de tekst
const TEKST_KLEUR = cmyk(0, 0, 0.01, 0);

function isKentekenplaathouderLineItem(li) {
  return /kentekenplaathouder/i.test(li.title || '');
}

function extractKentekenplaathouderData(li) {
  const props = li.properties || [];
  const getProp = (regex) => {
    const p = props.find(p => regex.test(p.name || ''));
    return p ? String(p.value || '').trim() : '';
  };

  const voertuigRuw = getProp(/voertuig/i).toLowerCase();
  const voertuig = VOERTUIG_FORMATEN[voertuigRuw] ? voertuigRuw : 'auto'; // terugval op "auto" bij een (nog) onbekend voertuigtype

  return {
    voertuig,
    tekst: getProp(/^tekst$/i) || getProp(/\btekst\b/i)
  };
}

function extractKentekenplaathouderItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    if (!isKentekenplaathouderLineItem(li)) return;
    const data = extractKentekenplaathouderData(li);
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, data });
    }
  });
  return items;
}

async function generateKentekenplaathouderPdf(data) {
  const formaat = VOERTUIG_FORMATEN[data.voertuig] || VOERTUIG_FORMATEN.auto;
  const doc = await PDFDocument.create();
  const page = doc.addPage([formaat.breedteMm * MM, formaat.hoogteMm * MM]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  const tekst = data.tekst || '';
  if (tekst) {
    // Altijd horizontaal gecentreerd (op verzoek — een eventuele "_align"-
    // eigenschap van de klant wordt hier bewust genegeerd, dit product is
    // altijd gecentreerd).
    // Lettergrootte begint op de "standaard" maat uit het referentiebestand,
    // en wordt in kleine stapjes verkleind totdat de tekst weer binnen de
    // marge (1cm aan weerszijden) past — dus alleen ingrijpen bij LANGERE
    // tekst dan het voorbeeld, nooit vergroten. Rekent met een kleine
    // veiligheidsmarge extra (5mm) bovenop de vereiste 1cm: de centrering
    // en deze marge-berekening gebruiken de "advance width" van het
    // lettertype (de gebruikelijke, correcte manier om tekst te centreren),
    // maar de WERKELIJK ZICHTBARE inkt-breedte kan daar per tekst een fractie
    // van ligt afwijken (afhankelijk van de exacte letters waarmee de tekst
    // begint/eindigt) — gemeten tot ~2,6mm asymmetrie bij een realistische
    // tekst ("IJSSELSTEIN AUTOBEDRIJF..."), dus 5mm veiligheidsmarge geeft
    // ruim voldoende marge zodat de daadwerkelijk zichtbare marge ook in
    // het ongunstigste geval nooit onder de vereiste 1cm zakt.
    let sizePt = STANDAARD_LETTERGROOTTE_MM * MM;
    const veiligheidsmargeMm = 5;
    const maxBreedtePt = (formaat.breedteMm - 2 * (MARGE_MM + veiligheidsmargeMm)) * MM;
    while (sizePt > 2 * MM && font.widthOfTextAtSize(tekst, sizePt) > maxBreedtePt) {
      sizePt -= 0.1 * MM;
    }

    const tekstBreedtePt = font.widthOfTextAtSize(tekst, sizePt);
    const xPt = (formaat.breedteMm * MM - tekstBreedtePt) / 2;
    // Verticale positie: het referentiebestand se "standaard" top-positie
    // (in mm vanaf boven) als vaste ankerpositie voor de baseline — dezelfde
    // top-naar-baseline-omrekening (size * 0.75) als elders in dit project
    // (zie texttile.js) gebruikt.
    const yPt = (formaat.hoogteMm - formaat.standaardTopMm) * MM - sizePt * 0.75;

    page.drawText(tekst, { x: xPt, y: yPt, size: sizePt, font, color: TEKST_KLEUR });
  }

  return doc.save();
}

module.exports = {
  generateKentekenplaathouderPdf, isKentekenplaathouderLineItem,
  extractKentekenplaathouderData, extractKentekenplaathouderItemsFromOrder, VOERTUIG_FORMATEN
};
