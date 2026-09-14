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
const { buildReceiptHtml } = require('./receiptHtml');

const PRINTNODE_API_KEY = process.env.PRINTNODE_API_KEY;
const PRINTNODE_PRINTER_ID = process.env.PRINTNODE_PRINTER_ID;

let gedeeldeBrowser = null;
async function pakBrowser() {
  // 1 gedeelde, langlevende browser-instantie hergebruiken i.p.v. voor elke
  // pakbon een nieuwe Chrome-instantie op te starten (dat kost, zeker bij
  // een bulk-print van meerdere orders tegelijk, onnodig veel tijd/geheugen).
  if (!gedeeldeBrowser || !gedeeldeBrowser.isConnected()) {
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

// Zet 1 of meerdere orders om naar 1 PDF-bestand (bij meerdere orders: 1
// pagina per order, zelfde "page-break-after"-aanpak als de browser-versie).
async function genereerPakbonPdf(orders, serverBasisUrl) {
  const browser = await pakBrowser();
  const page = await browser.newPage();
  try {
    const receiptsHtml = orders.map(o => buildReceiptHtml(o, serverBasisUrl)).join('\n');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${receiptsHtml}</body></html>`;
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ width: '80mm', printBackground: true });
    return pdfBuffer;
  } finally {
    await page.close();
  }
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

// Gemaksfunctie: 1 of meerdere orders direct naar de PrintNode-printer sturen.
async function printPakbonnenViaPrintNode(orders, serverBasisUrl) {
  const pdfBuffer = await genereerPakbonPdf(orders, serverBasisUrl);
  const titel = orders.length === 1
    ? `Pakbon #${orders[0].order_number || orders[0].shopify_order_id}`
    : `Pakbonnen (${orders.length} orders)`;
  return stuurNaarPrintNode(pdfBuffer, titel);
}

module.exports = { genereerPakbonPdf, stuurNaarPrintNode, printPakbonnenViaPrintNode, haalPrintersOp };
