const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');

const PT_PER_CM = 72 / 2.54; // PostScript/PDF-punten per centimeter

// Posterly levert de foto's aan mét een stuk canvas/rand eromheen — het
// volledige aangeleverde beeld staat voor 170mm fysiek, en het gevraagde
// formaat (10x10 of 13x13cm) moet daar precies uit het midden uitgeknipt
// worden. Werkt proportioneel (percentage van de pixelmaten), dus onafhankelijk
// van de daadwerkelijke resolutie waarin Posterly de foto aanlevert.
const POSTERLY_FULL_CANVAS_MM = 170;

async function cropPosterlyCanvas(inputBuffer, targetMm) {
  // EXIF-rotatie eerst toepassen en "bakken" in een nieuwe buffer, zodat de
  // daarna opgevraagde afmetingen (en dus de crop-berekening) kloppen.
  const rotatedBuffer = await sharp(inputBuffer).rotate().toBuffer();
  const metadata = await sharp(rotatedBuffer).metadata();
  const fraction = targetMm / POSTERLY_FULL_CANVAS_MM;
  const cropWidth = Math.round(metadata.width * fraction);
  const cropHeight = Math.round(metadata.height * fraction);
  const left = Math.round((metadata.width - cropWidth) / 2);
  const top = Math.round((metadata.height - cropHeight) / 2);
  return sharp(rotatedBuffer).extract({ left, top, width: cropWidth, height: cropHeight }).toBuffer();
}

// Zet een afbeelding (buffer, bv. jpg/png) om naar een print-klaar PDF-bestand op
// het opgegeven fysieke drukformaat (in centimeters), met de foto er als JPEG
// (op de opgegeven dpi) volledig beeldvullend in ingebed. PDF is tegenwoordig het
// meest universeel ondersteunde drukwerkformaat en wordt hier met pdf-lib
// opgebouwd — een pure JS-library, dus zonder afhankelijkheid van een losse
// PostScript-renderer om te weten dat de opbouw klopt.
async function imageBufferToPrintPdf(inputBuffer, { widthCm = 10, heightCm = 10, dpi = 300 } = {}) {
  const targetPxWidth = Math.round((widthCm / 2.54) * dpi);
  const targetPxHeight = Math.round((heightCm / 2.54) * dpi);

  // Foto naar de exacte pixelmaten voor het gevraagde formaat + dpi, als JPEG.
  const jpegBuffer = await sharp(inputBuffer)
    .rotate() // houd rekening met EXIF orientatie
    .resize({ width: targetPxWidth, height: targetPxHeight, fit: 'fill' })
    // Doorzichtige pixels expliciet tegen een WITTE achtergrond "pletten" i.p.v.
    // .removeAlpha() (die het kanaal gewoon weghaalt zonder te pletten, en dus
    // de vaak-verborgen onderliggende RGB-waarden van transparante pixels
    // blootlegt — bij veel PNG's toevallig zwart, ook al is de pixel zelf
    // onzichtbaar). Zelfde bug als ontdekt bij het muziekframe.
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColourspace('srgb')
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const widthPt = widthCm * PT_PER_CM;
  const heightPt = heightCm * PT_PER_CM;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([widthPt, heightPt]);
  const jpegImage = await pdfDoc.embedJpg(jpegBuffer);
  page.drawImage(jpegImage, { x: 0, y: 0, width: widthPt, height: heightPt });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { imageBufferToPrintPdf, cropPosterlyCanvas, POSTERLY_FULL_CANVAS_MM };
