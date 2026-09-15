// Stuurt pakbonnen automatisch naar een fysieke printer via de PrintNode-
// cloud-print-service (https://www.printnode.com/), i.p.v. dat de gebruiker
// zelf via het browser-printvenster hoeft te klikken. Werkwijze:
//   1. De pakbon-HTML (zelfde inhoud als de bestaande browser-printflow,
//      zie receiptHtml.js) via een lokale, headless Chrome (puppeteer) naar
//      een PDF renderen — puppeteer draait op de server zelf, dus geen
//      aparte losse dienst nodig.
//   2. Die PDF als base64 naar PrintNode se REST-API sturen, met de
//      printer-ID en API-key uit de omgevingsvariabelen.
//
// Omgevingsvariabelen (zie .env.example):
//   PRINTNODE_API_KEY   - de API-key uit je PrintNode-account (Account -> API Keys)
//   PRINTNODE_PRINTER_ID - de numerieke printer-ID (te vinden in de PrintNode-
//                          desktop-app of dashboard; bij "Bonnenprinter" is
//                          dat 75792954)
const axios = require('axios');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const { buildReceiptHtml } = require('./receiptHtml');

const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTNODE_PRINTER_ID = process.env.PRINTNODE_PRINTER_ID;

let gedeeldeBrowser = null;
async function pakBrowser() {
  // 1 gedeelde, langlevende browser-instantie hergebruiken i.p.v. voor elke
  // pakbon een nieuwe Chrome-instantie op te starten (dat kost, zeker bij
  // een bulk-print van meerdere orders tegelijk, onnodig veel tijd/geheugen).
  // LET OP: dit is een PROPERTY ("connected"), GEEN methode — de eerdere
  // versie riep 'm per ongeluk aan als browser.isConnected() (een oudere
  // puppeteer-API die in deze versie niet meer bestaat), wat een "is not a
  // function"-fout gaf zodra de gedeelde browser-instantie een 2e keer
  // gebruikt werd (dus feitelijk bij elke print na de allereerste).
  if (!gedeeldeBrowser || !gedeeldeBrowser.connected) {
    gedeeldeBrowser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      // Normaal gesproken gebruikt puppeteer gewoon zijn eigen, tijdens
      // "npm install" automatisch gedownloade Chrome — dit hoeft dus niet
      // ingesteld te worden. Alleen als noodgreep voor een serveromgeving
      // waar dat downloaden onverhoopt niet lukt: dan kun je hiermee naar
      // een handmatig geïnstalleerde Chrome/Chromium wijzen.
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    });
  }
  return gedeeldeBrowser;
}

// Genereert de PDF voor PRECIES 1 order, met een paginahoogte die exact bij
// de inhoud van DIE ene pakbon past.
async function genereerEnkelePakbonPdf(order, serverBasisUrl) {
  // BELANGRIJK: eerst de VOLLEDIGE HTML opbouwen (incl. het ophalen van
  // eventuele foto's — kan even duren, zeker bij een trage/onbereikbare
  // fotolink), en PAS DAARNA een puppeteer-pagina aanmaken/setContent
  // aanroepen — niet andersom. Ontdekt tijdens het testen: als de pagina
  // AL bestaat terwijl er nog gewacht wordt op de (paar seconden durende)
  // HTML-opbouw, loopt de daaropvolgende page.setContent() vrijwel
  // gegarandeerd vast tot puppeteer se eigen navigatie-timeout (30s) —
  // ook al is de uiteindelijke HTML zelf prima in orde. Simpelweg de
  // volgorde omdraaien (pas een pagina aanmaken als de HTML al klaarligt)
  // loste dit volledig op.
  const receiptHtml = await buildReceiptHtml(order, serverBasisUrl);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${receiptHtml}</body></html>`;

  const browser = await pakBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // Voor een thermische bonnenprinter moet de PDF-paginahoogte exact bij
    // de inhoud passen (geen vaste, veel te lange standaardhoogte) — zonder
    // expliciete "height"-optie viel page.pdf() terug op de standaard
    // Letter-hoogte (279mm/11 inch), wat een 80mm-brede maar 279mm-LANGE
    // pagina gaf. Vermoedelijk paste de printer(driver) toen zelf een
    // "fit"-schaling toe op die ongebruikelijke, veel-te-lange pagina —
    // wat de streepjescode (die in de PDF zelf, gemeten, wél gewoon de
    // juiste ~59mm breedte had) op de daadwerkelijke afdruk alsnog te
    // groot liet uitvallen. Opgelost door de daadwerkelijke inhoudshoogte
    // op te meten en die als paginahoogte te gebruiken, met een kleine
    // marge. Elke order krijgt hierdoor zijn EIGEN, precies passende
    // hoogte (i.p.v. 1 gedeelde hoogte voor alle orders bij een bulk-print,
    // wat bij orders met verschillend veel regel-items niet zou kloppen —
    // zie genereerPakbonPdf hieronder, die de losse PDF's per order
    // samenvoegt i.p.v. ze allemaal in 1 puppeteer-paginaformaat te proppen).
    // LET OP: "document.body.scrollHeight" bleek de onderste marge van de
    // pakbon se eigen wrapper-element NIET altijd volledig mee te tellen
    // (marge-collapsing-gedrag) — daardoor liep het allerlaatste stukje
    // (de contact-tekst onderaan) af en toe over naar een overbodige 2e
    // pagina. Meet daarom i.p.v. daarvan de ECHTE onderkant (bottom, incl.
    // marge) van het pakbon-element zelf via getBoundingClientRect().
    // Veiligheidsmarge: gemeld dat een daadwerkelijk geprinte bon boven-
    // en onderaan nog te veel wit overhield, dus eerst verkleind naar
    // +3mm — bleek daarna de contacttekst onderaan regelmatig af te
    // knippen. Getest met oplopende waarden (4/5/6/7/8/10/15/20/25mm): pas
    // vanaf +15mm bleef de contacttekst betrouwbaar volledig zichtbaar (de
    // onderschatting van getBoundingClientRect() is dus groter dan gedacht
    // — vermoedelijk mede door hoe puppeteer tekst-regelafbreking net iets
    // anders meet tijdens de PDF-rendering dan tijdens deze meting). +15mm
    // gebruikt als veilige ondergrens, i.p.v. de eerdere +10mm (die bij dit
    // testgeval OOK al niet voldoende bleek) of de te krappe +3mm.
    const inhoudsHoogtePx = await page.evaluate(() => {
      const el = document.body.firstElementChild;
      return el ? el.getBoundingClientRect().bottom : document.body.scrollHeight;
    });
    const PX_NAAR_MM = 25.4 / 96; // CSS-pixels (96dpi) naar mm
    const paginaHoogteMm = Math.ceil(inhoudsHoogtePx * PX_NAAR_MM) + 15; // veiligheidsmarge onderaan (getest minimum)
    // LET OP: page.pdf() geeft in recente puppeteer-versies een kale
    // Uint8Array terug, GEEN Node Buffer — .toString('base64') daarop zou
    // dan stilzwijgend het verkeerde (kommagescheiden bytewaarden i.p.v.
    // base64) resultaat geven, wat PrintNode terecht afwees met "(request
    // body).content is not valid base64". Daarom hier expliciet naar een
    // echte Buffer omzetten.
    const pdfBuffer = Buffer.from(await page.pdf({
      width: '80mm',
      height: `${paginaHoogteMm}mm`,
      // Expliciet op 0 gezet — anders kan puppeteer een eigen, standaard
      // PDF-paginamarge toevoegen (los van de HTML/CSS se eigen marges),
      // wat bovenaan onnodige witruimte zou geven.
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      printBackground: true
    }));
    return pdfBuffer;
  } finally {
    await page.close();
  }
}

// Zet 1 of meerdere orders om naar 1 PDF-bestand. Elke order krijgt zijn
// eigen, precies op de inhoud afgestemde paginahoogte (zie
// genereerEnkelePakbonPdf hierboven) — bij meerdere orders worden die losse
// PDF's daarna samengevoegd tot 1 bestand (i.p.v. alle orders in 1 gedeeld
// puppeteer-paginaformaat te proppen, wat bij verschillend lange orders niet
// zou kloppen).
async function genereerPakbonPdf(orders, serverBasisUrl) {
  const pdfBuffers = [];
  for (const order of orders) {
    // Bewust NA elkaar (niet Promise.all) — de orders delen dezelfde
    // gedeelde browser-instantie (pakBrowser), dus meerdere pagina's
    // tegelijk zou onnodig veel geheugen gebruiken bij een grote bulk-print.
    pdfBuffers.push(await genereerEnkelePakbonPdf(order, serverBasisUrl));
  }
  if (pdfBuffers.length === 1) return pdfBuffers[0];

  const samengevoegdDoc = await PDFDocument.create();
  for (const buf of pdfBuffers) {
    const bronDoc = await PDFDocument.load(buf);
    const paginas = await samengevoegdDoc.copyPages(bronDoc, bronDoc.getPageIndices());
    paginas.forEach(pagina => samengevoegdDoc.addPage(pagina));
  }
  return Buffer.from(await samengevoegdDoc.save());
}

// Stuurt een al-gegenereerde PDF-buffer naar PrintNode om af te drukken.
async function stuurNaarPrintNode(pdfBuffer, titel) {
  if (!PRINTNODE_API_KEY) {
    throw new Error('PRINTNODE_API_KEY is niet ingesteld in de omgevingsvariabelen (.env) — zie .env.example.');
  }
  if (!PRINTNODE_PRINTER_ID) {
    throw new Error('PRINTNODE_PRINTER_ID is niet ingesteld in de omgevingsvariabelen (.env) — zie .env.example.');
  }
  // PrintNode-authenticatie: HTTP Basic Auth met de API-key als
  // gebruikersnaam en een leeg wachtwoord (zo documenteert PrintNode het zelf).
  const authHeader = 'Basic ' + Buffer.from(PRINTNODE_API_KEY + ':').toString('base64');
  try {
    const response = await axios.post('https://api.printnode.com/printjobs', {
      printerId: parseInt(PRINTNODE_PRINTER_ID, 10),
      title: titel || 'Pakbon',
      contentType: 'pdf_base64',
      content: pdfBuffer.toString('base64'),
      source: 'Shopify order dashboard'
    }, {
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' }
    });
    return response.data; // PrintNode geeft het nieuwe printjob-ID terug
  } catch (e) {
    // PrintNode stuurt bij een 4xx/5xx-fout altijd een JSON-body met een
    // veel specifiekere reden mee (bv. "Printer ID ... not found") — die
    // ging tot nu toe verloren, waardoor alleen de kale, nietszeggende
    // Axios-melding ("Request failed with status code 400") te zien was.
    if (e.response && e.response.data) {
      const detail = typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data);
      throw new Error(`PrintNode gaf een fout terug (status ${e.response.status}): ${detail}`);
    }
    throw e;
  }
}

// Haalt de printers op die daadwerkelijk aan dit PrintNode-account hangen
// (met hun ECHTE, numerieke printer-ID) — handig om te controleren of
// PRINTNODE_PRINTER_ID wel de juiste is. Zie ook de "/api/printnode/printers"-
// route in server/index.js.
async function haalPrintersOp() {
  if (!PRINTNODE_API_KEY) {
    throw new Error('PRINTNODE_API_KEY is niet ingesteld in de omgevingsvariabelen (.env) — zie .env.example.');
  }
  const authHeader = 'Basic ' + Buffer.from(PRINTNODE_API_KEY + ':').toString('base64');
  const response = await axios.get('https://api.printnode.com/printers', {
    headers: { Authorization: authHeader }
  });
  return response.data;
}

// Stuurt elke order als een EIGEN, LOSSE printopdracht naar PrintNode —
// i.p.v. ze samen te voegen tot 1 PDF met meerdere pagina's. Reden: gemeld
// dat bulk-prints met de samengevoegde-PDF-aanpak op de daadwerkelijke
// bonnenprinter een veel te lang bonnetje met extra witruimte gaven, en dat
// niet elk bonnetje afzonderlijk werd afgeknipt — de printer(driver)
// herkende de paginagrenzen binnen 1 PDF blijkbaar niet betrouwbaar als
// "hier stopt bon 1, hier begint bon 2". Losse printopdrachten (zoals een
// kassasysteem dat ook zou doen) laat de printer gewoon na élke opdracht
// z'n eigen, normale afkap-gedrag toepassen, ongeacht of dat via PDF-
// paginagrenzen, een ingebouwde inactiviteits-afkap, of iets anders werkt.
async function printPakbonnenViaPrintNode(orders, serverBasisUrl) {
  const resultaten = [];
  for (const order of orders) {
    // Bewust NA elkaar (niet Promise.all) — zelfde reden als bij het
    // genereren zelf: 1 gedeelde browser-instantie, dus niet onnodig veel
    // pagina's tegelijk open laten staan bij een grote bulk-print.
    const pdfBuffer = await genereerEnkelePakbonPdf(order, serverBasisUrl);
    const titel = `Pakbon #${order.order_number || order.shopify_order_id}`;
    resultaten.push(await stuurNaarPrintNode(pdfBuffer, titel));
  }
  return resultaten;
}

module.exports = { genereerPakbonPdf, stuurNaarPrintNode, printPakbonnenViaPrintNode, haalPrintersOp };
