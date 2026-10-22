// Zet een drukbestand (vierkant) in de tegel-foto (server/assets/tegel-mockup.png), zodat het er als een echt tegeltje uitziet.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DIR = path.join(__dirname, 'assets');
const BOX = { left: 265, top: 244, width: 801, height: 785 };   // witte vlak van de tegel in de mockup (met licht perspectief)

async function tegelMockup(printPath, { width = 1336, quality = 90 } = {}) {
  const mock = path.join(DIR, 'tegel-mockup.png'), mask = path.join(DIR, 'tegel-mask.png');
  const art = await sharp(printPath).resize(BOX.width, BOX.height, { fit: 'fill' }).flatten({ background: '#ffffff' }).toBuffer();
  const maskBuf = await sharp(mask).extract(BOX).greyscale().raw().toBuffer();
  // kunstwerk met masker als alpha (alleen binnen het witte tegelvlak), daarna "multiply" zodat schaduw en randen van de foto blijven
  const layer = await sharp(art).removeAlpha().joinChannel(maskBuf, { raw: { width: BOX.width, height: BOX.height, channels: 1 } }).png().toBuffer();
  let out = sharp(mock).removeAlpha().composite([{ input: layer, left: BOX.left, top: BOX.top, blend: 'multiply' }]);
  if (width && width !== 1336) {   // sharp resized vóór het samenvoegen: eerst samenvoegen op volle grootte, dan pas verkleinen
    const full = await out.png().toBuffer();
    return sharp(full).resize(width).webp({ quality }).toBuffer();
  }
  return out.webp({ quality }).toBuffer();
}
module.exports = { tegelMockup };
