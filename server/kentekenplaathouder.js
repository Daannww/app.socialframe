const { PDFDocument, StandardFonts, cmyk } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');
const { MM } = require('./pdf-shared');

// Afmetingen 1-op-1 gemeten uit het door de gebruiker aangeleverde
// referentiebestand ("kentekensjabloon.pdf", voertuig "Auto"): 526,0 x
// 132,5mm. Kleur in het referentiebestand: CMYK(0, 0, 0.01, 0) — de bekende
// "1%-gele" anti-gaten-truc die verder in dit hele project wordt gebruikt
// voor bijna-wit — bevestigt dat dit product op een DONKER/ZWART fysiek
// materiaal print (de tekst zou anders onzichtbaar zijn).
// LET OP: alleen het "Auto"-voertuig-sjabloon is aangeleverd; een ander
// voertuigtype (zie de "Kies hier het voertuig"-eigenschap) heeft mogelijk
// een ander formaat — dat is nu niet bekend/ondersteund.
const VOERTUIG_FORMATEN = {
  auto: { breedteMm: 526.0, hoogteMm: 132.5 }
};
const STANDAARD_LETTERGROOTTE_MM = 16.00;
const MARGE_MM = 10; // 1cm, op verzoek — minimaal vrij te houden aan weerszijden van de tekst
// Onderkant van de letters (dus de baseline, voor tekens zonder onderlengte
// zoals hoofdletters/cijfers) op exact 4mm vanaf de onderkant van het
// canvas — expliciet zo opgegeven. Tekens MET een onderlengte (bv. een "J"
// in sommige lettertypen) steken vanzelfsprekend een stukje onder deze
// lijn uit — dat is bekend en geaccepteerd, geen apart geval voor nodig.
const BASELINE_VANAF_ONDER_MM = 4;
const TEKST_KLEUR = cmyk(0, 0, 0.01, 0);

// De 6 lettertype-keuzes uit de Shopify-dropdown. LET OP: momenteel zijn
// alleen "Helvetica-bold" (ingebouwd PDF-standaardlettertype) en
// "Montserrat" (al aanwezig in het project, zie server/fonts/ — visueel
// bevestigd volledig en correct) daadwerkelijk beschikbaar.
// "Muktavaani-bold" leek eerst ook bruikbaar (rechtstreeks uit het
// referentiebestand geëxtraheerd, en de tekenlijst gaf "geen ontbrekende
// tekens" aan) — maar bleek bij nader (visueel) onderzoek een KAPOT subset:
// vrijwel alle letters (C, W, L, ., O, P, N, A, ...) staan wel in de
// tekenlijst maar hebben 0 bytes aan padgegevens — precies hetzelfde
// probleem als destijds bij Caveat-Regular. Alleen de letters die
// toevallig in "HIER DE TEKST" voorkwamen (R, I, S, ...) werken. Dus deze
// valt voorlopig terug op Helvetica-Bold, tot het volledige (niet-
// gesubsette) lettertype wordt aangeleverd.
// "BebasNeue-bold", "Oswald-regular" en "Opensans-bold" zijn inmiddels wél
// aangeleverd (volledige, geldige lettertypebestanden — grondig
// gecontroleerd op lege/kapotte tekens, geen enkele gevonden, en visueel
// bevestigd via een losse render buiten pdf-lib om). LET OP: "Bebas Neue"
// bestaat niet als aparte bold-variant — het lettertype zelf is van
// zichzelf al een vet/hoog-contrast weergavelettertype, dus de "bold"-optie
// in de Shopify-dropdown wijst gewoon naar de gewone (enige) Regular-versie.
const LETTERTYPE_MAP = {
  'helvetica-bold': { standaard: StandardFonts.HelveticaBold },
  'montserratbold': { bestand: 'Montserrat-Bold.ttf' },
  'montserrat-bold': { bestand: 'Montserrat-Bold.ttf' },
  'bebasneue-bold': { bestand: 'BebasNeue-Regular.ttf' }, // geen aparte bold-variant, zie hierboven
  'oswald-regular': { bestand: 'Oswald-Regular.ttf' },
  'opensans-bold': { bestand: 'OpenSans_Bold.ttf' },
  // Nog niet (volledig) aangeleverd — valt terug op Helvetica-Bold:
  'muktavaani-bold': { standaard: StandardFonts.HelveticaBold, ontbreekt: true }
};

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
    tekst: getProp(/^tekst$/i) || getProp(/\btekst\b/i),
    lettertype: getProp(/lettertype/i)
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
  doc.registerFontkit(fontkit);
  const page = doc.addPage([formaat.breedteMm * MM, formaat.hoogteMm * MM]);

  const lettertypeSleutel = (data.lettertype || '').toLowerCase().replace(/[\s:]+$/, '');
  const lettertypeInfo = LETTERTYPE_MAP[lettertypeSleutel] || { standaard: StandardFonts.HelveticaBold, onbekend: true };
  if (lettertypeInfo.ontbreekt || lettertypeInfo.onbekend) {
    console.warn(`[kentekenplaathouder] Lettertype "${data.lettertype}" is niet beschikbaar, val terug op Helvetica-Bold.`);
  }
  let font;
  if (lettertypeInfo.bestand) {
    const fontBytes = fs.readFileSync(path.join(__dirname, 'fonts', lettertypeInfo.bestand));
    font = await doc.embedFont(fontBytes);
  } else {
    font = await doc.embedFont(lettertypeInfo.standaard);
  }

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
    // Baseline op exact 4mm vanaf de onderkant van het canvas — pdf-lib se
    // "y" bij drawText is namelijk al de baseline-positie vanaf onder (PDF-
    // coördinaten lopen van onder naar boven), dus dit is een rechtstreekse
    // toewijzing, geen omrekening nodig. Blijft ONGEWIJZIGD ongeacht de
    // lettergrootte (dus ook bij automatisch verkleinde tekst) — precies
    // zoals opgegeven.
    const yPt = BASELINE_VANAF_ONDER_MM * MM;

    page.drawText(tekst, { x: xPt, y: yPt, size: sizePt, font, color: TEKST_KLEUR });
  }

  return doc.save();
}

module.exports = {
  generateKentekenplaathouderPdf, isKentekenplaathouderLineItem,
  extractKentekenplaathouderData, extractKentekenplaathouderItemsFromOrder, VOERTUIG_FORMATEN
};
