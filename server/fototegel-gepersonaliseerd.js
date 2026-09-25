const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const {
  MM, embedPhotoCoverRectGeenAntiGaten,
  widthOfTextLigatuurVeiligAtSize, drawTextLigatuurVeilig
} = require('./pdf-shared');
const { isFotoTegelLineItem } = require('./shopify');
const { kleurNaarPdfKleur } = require('./fototegel3');

// --- "Gepersonaliseerde foto tegel" ("jouw foto op keramiek") — een
// "polaroid"-achtig ontwerp: 1 eigen foto (cover-fit bijgesneden, GEEN
// afgeronde hoeken), met daaronder gecentreerd de naam + een datum-/
// datumbereik-regel uit de bijbehorende invulapp. Beschikbaar in 10x10 en
// 13x13 — zelfde REFERENTIE_MM-schaaltechniek als de andere tegel-achtige
// producten (fototegel3.js/tegelillustratie.js): alle maten/posities/
// lettergroottes hieronder zijn 1-op-1 uit het aangeleverde voorbeeld-PDF
// (Voorbeeld_foto_tegeltje_.pdf, 100x100mm) gehaald via pikepdf content-
// stream-parsing (foto-plaatsingsmatrix + live tekst-Tm/Td-posities — deze
// tekst was, in tegenstelling tot sommige andere referentiebestanden in dit
// project, GEWOON live tekst, geen tot contouren omgezette vormen).
//
// LET OP: het voorbeeldbestand zelf gebruikte "CormorantGaramond-LightItalic"
// als lettertype, maar de opdrachtgever heeft expliciet gevraagd om
// "Cormorant Garamond semibold italic" te gebruiken (het meegeleverde
// CormorantGaramond-SemiBoldItalic.ttf) — dus HIER bewust een ander gewicht
// dan wat er letterlijk in het voorbeeldbestand stond, de positionering zelf
// is wel exact overgenomen.
const REFERENTIE_MM = 100;

// De foto zelf heeft GEEN achtergrondvlak in het voorbeeldbestand (geen
// vul-rechthoek vóór de afbeelding in de content stream) — de rand rondom de
// foto is dus gewoon onbedrukt/leeg canvas, waardoor in productie de eigen
// kleur van de gekozen keramische tegel ("Kleur tegeltje") daar vanzelf
// doorschijnt. Hier daarom bewust GEEN achtergrondrechthoek tekenen.
const FOTO_VAK = { xMm: 3.939, topMm: 4.089, breedteMm: 91.268, hoogteMm: 77.277 };

// Beide tekstregels: gecentreerd op de paginabreedte (bevestigd door de
// gemeten tekstbreedte + x-positie in het voorbeeldbestand: het midden van
// beide regels komt uit op x ≈ 50,0mm, exact het midden van de 100mm-pagina).
const NAAM_TOP_MM = 87.487; // basislijn van de naam-regel
const DATUM_TOP_MM = 92.623; // basislijn van de datum(bereik)-regel
const PUNTGROOTTE_MM = 5.857; // = 16.6014pt uit het voorbeeldbestand, voor beide regels
// Boven deze breedte wordt een regel automatisch verkleind (in stappen), zodat
// een langere naam of een 4-cijferige jaartal-variant niet buiten de tegel valt.
const MAX_TEKSTBREEDTE_MM = 92;

function fromTopMm(topMm, schaal) {
  return (REFERENTIE_MM * schaal - topMm * schaal) * MM;
}

// Splitst de "Naam"-property (bv. "Winnie Vermeir 19.06.’54 - 19.06.’26") in
// een naam-regel en een datum(bereik)-regel. De invulapp levert dit als 1
// vrij tekstveld aan (net als de "Tekst N"-velden bij "Foto tegel met 3
// foto's" met hun net-iets-andere property-naam-varianten), dus hier de
// datumnotatie aan het EIND van de tekst herkennen en van de rest scheiden.
// Ondersteunt zowel een enkele datum als een bereik (2 datums met een
// streepje ertussen), met een rechte OF kromme apostrof (of HELEMAAL geen
// apostrof, bv. bij voluit geschreven 4-cijferige jaartallen), en 2- of
// 4-cijferige jaartallen. Wordt geen datumnotatie gevonden, dan komt de hele tekst op de
// naam-regel te staan en blijft de datum-regel leeg (in plaats van de order
// te laten mislukken op een onverwacht format).
const DATUM_REGEX = /(\d{1,2}\.\d{1,2}\.['’]?\d{2,4}(?:\s*-\s*\d{1,2}\.\d{1,2}\.['’]?\d{2,4})?)\s*$/;

function splitsNaamEnDatum(ruw) {
  const tekst = String(ruw || '').trim();
  if (!tekst) return { naam: '', datumregel: '' };
  const match = DATUM_REGEX.exec(tekst);
  if (!match) return { naam: tekst, datumregel: '' };
  const naam = tekst.slice(0, match.index).trim();
  if (!naam) return { naam: tekst, datumregel: '' }; // de HELE tekst was al een datum -> niet als lege naam-regel tonen
  return { naam, datumregel: match[1].trim() };
}

// Het formaat staat (net als bij autopictura/Posterly) ergens in de titel/
// variant/eigenschappen als "13x13" — dezelfde generieke herkenning als
// extractTileItemsFromOrder in shopify.js gebruikt voor de andere tegel-
// achtige producten.
function isFotoTegelGepersonaliseerd13x13(li) {
  const props = li.properties || [];
  const textBlob = [li.title, li.variant_title, ...props.map(p => `${p.name} ${p.value}`)].join(' ');
  return /13\s*x\s*13/i.test(textBlob);
}

function extractFotoTegelGepersonaliseerdData(li) {
  const props = li.properties || [];
  const getProp = (regex) => {
    const p = props.find(p => regex.test(p.name || ''));
    return p ? String(p.value || '').trim() : '';
  };

  const photoUrl = getProp(/kies\s*jouw\s*foto/i);
  const { naam, datumregel } = splitsNaamEnDatum(getProp(/^naam\b/i));
  const kleurNaam = getProp(/kies\s*hier\s*de\s*tekst\s*kleur/i);

  return {
    photoUrl,
    naam,
    datumregel,
    kleurNaam,
    is13x13: isFotoTegelGepersonaliseerd13x13(li)
  };
}

function extractFotoTegelGepersonaliseerdItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    if (!isFotoTegelLineItem(li)) return;
    const data = extractFotoTegelGepersonaliseerdData(li);
    if (!data.photoUrl) return; // geen foto aangeleverd -> niets te genereren
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, lineItemId: li.id, data });
    }
  });
  return items;
}

// Laadt het Cormorant Garamond SemiBold Italic-lettertype als het bestand
// aanwezig is in server/fonts/ — anders terugval op een ingebouwd PDF-
// standaardlettertype (schuingezette Helvetica), net als bij alle andere
// producten in dit project wanneer een eigen lettertypebestand ontbreekt.
// Zie server/fonts/LEES-MIJ.txt.
async function laadFont(doc) {
  const bestandsPad = path.join(__dirname, 'fonts', 'CormorantGaramond-SemiBoldItalic.ttf');
  if (fs.existsSync(bestandsPad)) {
    return doc.embedFont(fs.readFileSync(bestandsPad));
  }
  console.warn('[fototegel-gepersonaliseerd] CormorantGaramond-SemiBoldItalic.ttf niet gevonden in server/fonts/ — val terug op Helvetica-Oblique. Zie server/fonts/LEES-MIJ.txt.');
  return doc.embedFont(StandardFonts.HelveticaOblique);
}

// Tekent 1 regel gecentreerd op de paginabreedte, en verkleint 'm (in kleine
// stapjes) als 'ie anders buiten MAX_TEKSTBREEDTE_MM zou vallen — zelfde
// soort auto-shrink-aanpak als elders in dit project (bv. de "groep"-tekst-
// regels in texttile.js), hier per regel apart toegepast.
function tekenGecentreerdeRegel(page, font, tekst, topMm, schaal, kleur) {
  if (!tekst) return;
  let sizeMm = PUNTGROOTTE_MM * schaal;
  const maxBreedtePt = MAX_TEKSTBREEDTE_MM * schaal * MM;
  let breedtePt = widthOfTextLigatuurVeiligAtSize(font, tekst, sizeMm * MM);
  while (breedtePt > maxBreedtePt && sizeMm > 1) {
    sizeMm -= 0.05;
    breedtePt = widthOfTextLigatuurVeiligAtSize(font, tekst, sizeMm * MM);
  }
  const xPt = (REFERENTIE_MM * schaal * MM) / 2 - breedtePt / 2;
  const yPt = fromTopMm(topMm, schaal) - sizeMm * MM * 0.75; // zelfde empirische basislijn-offset als elders (fromTopMm-conventie)
  drawTextLigatuurVeilig(page, font, tekst, xPt, yPt, sizeMm * MM, kleur);
}

async function generateFotoTegelGepersonaliseerdPdf(data) {
  const sizeMm = data.is13x13 ? 130 : 100;
  const schaal = sizeMm / REFERENTIE_MM;

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([sizeMm * MM, sizeMm * MM]);

  // --- De foto: cover-fit bijgesneden tot het gemeten fotovak, GEEN
  // afgeronde hoeken (het voorbeeldbestand heeft een rechte rechthoek) en
  // GEEN kleurcorrectie-truc nodig (net als bij "Foto tegel met 3 foto's"). ---
  if (data.photoUrl) {
    const breedteMm = FOTO_VAK.breedteMm * schaal;
    const hoogteMm = FOTO_VAK.hoogteMm * schaal;
    const { image } = await embedPhotoCoverRectGeenAntiGaten(doc, data.photoUrl, breedteMm, hoogteMm);
    const xPt = FOTO_VAK.xMm * schaal * MM;
    const yPt = fromTopMm(FOTO_VAK.topMm + FOTO_VAK.hoogteMm, schaal); // onderkant van het vak (drawImage-oorsprong is linksonder)
    page.drawImage(image, { x: xPt, y: yPt, width: breedteMm * MM, height: hoogteMm * MM });
  }

  // --- Naam + datum(bereik), beide gecentreerd, in de gekozen tekstkleur
  // (dezelfde, met de opdrachtgever bevestigde kleurenlijst als "Foto tegel
  // met 3 foto's" — onbekende/lege kleurnaam valt terug op zwart, zoals in
  // het voorbeeldbestand). ---
  const font = await laadFont(doc);
  const kleur = kleurNaarPdfKleur(data.kleurNaam);
  tekenGecentreerdeRegel(page, font, data.naam, NAAM_TOP_MM, schaal, kleur);
  tekenGecentreerdeRegel(page, font, data.datumregel, DATUM_TOP_MM, schaal, kleur);

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

module.exports = {
  generateFotoTegelGepersonaliseerdPdf,
  isFotoTegelGepersonaliseerd13x13,
  extractFotoTegelGepersonaliseerdData,
  extractFotoTegelGepersonaliseerdItemsFromOrder,
  splitsNaamEnDatum
};
