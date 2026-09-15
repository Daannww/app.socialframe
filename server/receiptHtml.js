// Server-side variant van public/app.js se buildReceiptHtml/vertaalfuncties
// — nodig omdat PrintNode-PDF-generatie (via puppeteer, zie printnode.js)
// op de SERVER draait, niet in de browser. Bewust een LOSSE kopie i.p.v. de
// bestaande browser-functie hergebruiken: app.js is een puur browser-
// script (geen Node-module), dus "gewoon requiren" kan niet zonder een
// risicovolle refactor van de al-werkende, bestaande browser-printflow.
// Bij een wijziging aan de pakbon-inhoud/opmaak: DENK ERAAN OOK
// public/app.js se buildReceiptHtml bij te werken (en andersom) — dit is
// bewust dubbele code, geen gedeelde bron.

const fs = require('fs');
const path = require('path');
const bwipjs = require('bwip-js');
const { fetchMetHerpogingen } = require('./pdf-shared');

const PRODUCT_TRANSLATIONS_NL_DE = [
  [/sepia\s*foto[\s-]?tegeltje/gi, 'Sepia-Fotofliese'],
  [/watercolour\s*tegeltje/gi, 'Aquarell-Fliese'],
  [/aquarel\s*tegeltje/gi, 'Aquarell-Fliese'],
  [/cartoon\s*tegeltje/gi, 'Cartoon-Fliese'],
  [/kleurplaat\s*tegeltje/gi, 'Ausmalbild'],
  [/geboortetegeltje/gi, 'Geburtsfliese'],
  [/delfts\s*blauw\s*tegeltje/gi, 'Delfter Blau-Fliese'],
  [/gepersonaliseerde?\s*lijntekening\s*tegeltje/gi, 'Personalisierte Line-art'],
  [/lijntekening/gi, 'Line-art'],
  [/muziek-?frame/gi, 'Musik-rahmen'],
  [/auto-?frame(\s*specs)?/gi, 'Auto-rahmen'],
  [/baby-?frame/gi, 'Baby-rahmen'],
  [/sound-?frame/gi, 'Sound-Frame'],
  [/magazine-?frame/gi, 'Erinnerungs-rahmen'],
  [/3d[\s-]?gevel[\s-]?frame/gi, '3D-Hausbild'],
  [/map[\s-]?tile|stadsplattegrond\s*tegel/gi, 'Stadtplan-Fliese'],
  [/ontwerp je eigen tegel(tje)?/gi, 'gestalte deine eigene Fliese'],
  [/zelf inkleuren/gi, 'selbst ausmalen'],
  [/een foto die je kunt horen/gi, 'ein Foto, das man hören kann'],
  [/met (uw|jouw) eigen foto/gi, 'mit Ihrem eigenen Foto'],
  [/met eigen foto/gi, 'mit eigenem Foto'],
  [/gepersonaliseerde?/gi, 'Personalisierte'],
  [/tegeltje(s)?/gi, 'Fliese$1'],
  [/tegel(s)?/gi, 'Fliese$1'],
  [/houten[\s-]?houder/gi, 'Holzhalter'],
  [/houten[\s-]?standaard/gi, 'Holzhalter'],
  [/metalen[\s-]?houder/gi, 'Metallhalter'],
  [/led[\s-]?verlichting/gi, 'LED-Beleuchtung'],
  [/fotolijst/gi, 'Bilderrahmen'],
  [/fotocanvas/gi, 'Fotoleinwand'],
  [/sleutelhanger/gi, 'Schlüsselanhänger'],
  [/plaquette/gi, 'Plakette'],
  [/cadeaubon/gi, 'Geschenkgutschein'],
  [/cadeauverpakking/gi, 'Geschenkverpackung'],
  [/met tekst/gi, 'mit Text'],
  [/\bmet\b/gi, 'mit'],
  [/\beigen\b/gi, 'eigenen'],
  [/\bnormaal\b/gi, 'Normal'],
  [/\bklein\b/gi, 'Klein'],
  [/\bgroot\b/gi, 'Groß'],
  [/\bgeen\b/gi, 'Keine'],
  [/\bzwart\b/gi, 'Schwarz'],
  [/\bwit\b/gi, 'Weiß'],
  [/\btransparant\b/gi, 'Transparent']
];

function translateProductText(text, isGerman) {
  if (!isGerman || !text) return text;
  let result = text;
  PRODUCT_TRANSLATIONS_NL_DE.forEach(([pattern, replacement]) => {
    result = result.replace(pattern, replacement);
  });
  return result;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

// Genereert de streepjescode volledig server-side (bwip-js, geen DOM/CDN
// nodig) — in tegenstelling tot de browser-printflow (die JsBarcode via een
// CDN-script in het printvenster laadt) kan puppeteer niet zomaar op een
// externe CDN vertrouwen (in sommige serveromgevingen geblokkeerd/onbetrouwbaar
// — hier zelfs al ontdekt tijdens het bouwen: een 403 vanaf cdnjs.cloudflare.com
// binnen een puppeteer-sessie). Dus bewust een andere, DOM-vrije aanpak dan
// de browser-versie. Geeft lege string terug bij een ongeldig/leeg
// ordernummer (i.p.v. een fout te gooien), zelfde gedrag als de browser-versie.
function orderBarcodeSvg(orderNumber) {
  if (!orderNumber) return '';
  try {
    const ruweSvg = bwipjs.toSVG({
      bcid: 'code128',
      text: String(orderNumber),
      scale: 2,
      height: 10,
      includetext: true,
      textxalign: 'center'
    });
    // BELANGRIJK: bwip-js se toSVG() geeft alleen een "viewBox" mee, GEEN
    // expliciete width/height-attributen. Een inline <svg> zonder die
    // attributen valt terug op de browser-standaardgrootte (300x150px) —
    // wat op een 80mm-brede pakbon veel te groot is (ontdekt doordat de
    // gebruiker een veel te grote streepjescode op de daadwerkelijk
    // geprinte bon kreeg). Hier expliciet naar 100% breedte (van de
    // omliggende, wél op maat gezette container) gezet, met behoud van de
    // eigen beeldverhouding via "height:auto".
    return ruweSvg.replace('<svg ', '<svg style="width:100%; height:auto; display:block;" ');
  } catch (e) {
    return ''; // ongeldig ordernummer voor een streepjescode -> gewoon weglaten
  }
}

// Logo als base64 data-URI ingebed (i.p.v. een "/logo.svg"-verwijzing zoals
// de browser-versie doet) — puppeteer heeft namelijk geen "window.location.origin"
// om zo'n relatieve URL tegen op te lossen, en dit voorkomt sowieso een
// extra netwerk-rondje tijdens het renderen.
function logoDataUri(isGerman) {
  const bestandsnaam = isGerman ? 'logo-de.svg' : 'logo.svg';
  const pad = path.join(__dirname, '..', 'public', bestandsnaam);
  if (!fs.existsSync(pad)) return '';
  const svgInhoud = fs.readFileSync(pad, 'utf8');
  return 'data:image/svg+xml;base64,' + Buffer.from(svgInhoud).toString('base64');
}

// Haalt een foto server-side op en zet 'm om naar een base64 data-URI, i.p.v.
// te verwijzen naar de "/api/photo-preview"-route via een URL. Nodig omdat
// puppeteer (in tegenstelling tot de browser van een ingelogde gebruiker)
// GEEN sessie-cookie heeft — een verwijzing naar die route (die achter de
// inlog-vereiste zit) gaf daardoor altijd "Foto kon niet geladen worden".
// Geeft null terug bij een fout (dan wordt de foto gewoon weggelaten i.p.v.
// een kapot/leeg plaatje te tonen).
async function fotoAlsDataUri(url) {
  try {
    // Expliciete timeout (i.t.t. de meeste andere fetchMetHerpogingen-
    // aanroepen in dit project, waar een langzame-maar-uiteindelijk-lukkende
    // download best oké is): een pakbon moet snel gegenereerd kunnen worden,
    // dus een trage/onbereikbare fotolink mag die niet minutenlang ophouden.
    // Ontdekt tijdens het testen: zonder eigen timeout kon 1 onbereikbare
    // foto-URL (i.c.m. de 3 ingebouwde herpogingen) de HELE PDF-generatie
    // laten vastlopen tot puppeteer se eigen 30s-navigatietimeout.
    const response = await fetchMetHerpogingen(url, { responseType: 'arraybuffer', timeout: 5000 });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    return `data:${contentType};base64,${Buffer.from(response.data).toString('base64')}`;
  } catch (e) {
    return null;
  }
}

// serverBasisUrl: wordt niet meer gebruikt voor de foto's zelf (die worden nu
// als base64 ingebed, zie fotoAlsDataUri hierboven), alleen nog als parameter
// aangehouden voor API-consistentie/toekomstig gebruik.
async function buildReceiptHtml(order, serverBasisUrl) {
  const isGerman = (order.shipping_country_code || '').toUpperCase() === 'DE';
  const t = isGerman ? {
    pakbon: 'LIEFERSCHEIN',
    datum: 'Datum',
    artikel: 'Artikel',
    aantal: 'Menge',
    geenItems: 'Keine Artikel',
    contact: 'Hast du Fragen und/oder Anmerkungen? Schreib uns eine E-Mail an info@socialframe.nl',
    fotoNietGeladen: '[Foto konnte nicht geladen werden]'
  } : {
    pakbon: 'PAKBON',
    datum: 'Datum',
    artikel: 'Artikel',
    aantal: 'Aantal',
    geenItems: 'Geen items',
    contact: 'Heb je vragen en/of opmerkingen? Stuur een mail naar info@socialframe.nl',
    fotoNietGeladen: '[Foto kon niet geladen worden]'
  };

  const itemRows = (order.line_items || []).map(li => {
    const isCadeautjeInpakken = /cadeautje\s*inpakken/i.test(li.title || '');
    const propsHtml = isCadeautjeInpakken ? '' : (li.properties || [])
      .filter(p => !/autopictura/i.test(p.name) && !/autopictura/i.test(p.value))
      .map(p => `${escapeHtml(p.name)}: ${escapeHtml(p.value)}`)
      .join('<br>');

    const qty = Number(li.quantity || 0).toFixed(2).replace('.', ',');

    const displayTitle = translateProductText(li.title, isGerman);
    const displayVariant = translateProductText(li.variant_title, isGerman);

    const isGiftWrap = /cadeauverpakking/i.test(li.title || '');
    const rowStyle = isGiftWrap
      ? 'border:2px solid black; font-weight:800; font-size:14px; padding:6px;'
      : '';
    const qtyStyle = isGiftWrap
      ? 'text-align:right; vertical-align:top; border:2px solid black; border-left:none; font-weight:800; font-size:14px; padding:6px;'
      : 'text-align:right; vertical-align:top;';

    return `
      <tr>
        <td style="word-break:break-all; ${rowStyle}">
          ${isGiftWrap ? '🎁 ' : ''}${escapeHtml(displayTitle)}${displayVariant ? ' – ' + escapeHtml(displayVariant) : ''}${propsHtml ? '<br>' + propsHtml : ''}<br>
        </td>
        <td style="${qtyStyle}">${qty}</td>
      </tr>
      <tr>
        <td colspan="2" style="border-bottom:1px dotted black;"></td>
      </tr>
    `;
  }).join('') || `
      <tr><td colspan="2">${t.geenItems}</td></tr>
      <tr><td colspan="2" style="border-bottom:1px dotted black;"></td></tr>
    `;

  const allPhotoLinks = order.photo_links || [];
  const autopicturaPhotos = allPhotoLinks.filter(l => /autopictura/i.test(l));
  const otherPhotos = allPhotoLinks.filter(l => !/autopictura/i.test(l));
  const photosForReceipt = [...autopicturaPhotos, ...(otherPhotos.length ? [otherPhotos[0]] : [])];

  // Server-side ophalen en als base64 inbedden (zie fotoAlsDataUri hierboven)
  // i.p.v. een <img src="..."> die naar de (achter-inlog-zittende) "/api/
  // photo-preview"-route verwijst — puppeteer heeft geen sessie-cookie, dus
  // zo'n verwijzing gaf altijd "Foto kon niet geladen worden".
  const dataUris = await Promise.all(photosForReceipt.map(fotoAlsDataUri));
  const photoHtml = dataUris.filter(Boolean).map(dataUri => `
    <div style="text-align:center; margin-top:10px;">
      <img src="${dataUri}" alt="Foto product" style="width:45mm; max-height:45mm; object-fit:cover; border:1px solid black;">
    </div>
  `).join('');
  const nietGeladenCount = dataUris.filter(u => !u).length;
  const nietGeladenHtml = nietGeladenCount > 0
    ? `<div style="font-size:10px; color:#900; text-align:center; margin-top:6px;">${t.fotoNietGeladen}</div>`
    : '';

  const addressLines = (order.shipping_address || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

  return `
    <div style="font-family:Arial, 'Liberation Sans', 'DejaVu Sans', sans-serif; font-size:12px; margin:0 5mm 3mm 5mm;">
      <div style="text-align:center; margin-top:0; padding:6px 0; border-bottom:1px dotted black; border-top:1px dotted black;">
        <img src="${logoDataUri(isGerman)}" alt="Socialframe" style="height:44px; width:auto;">
      </div>
      <div style="font-weight:800; text-align:center; margin-top:10px; font-size:20px;">#${escapeHtml(order.order_number || order.shopify_order_id)}</div>
      <div style="font-weight:bold; text-align:center; margin-top:20px;">
        <table style="width:100%;">
          <tbody><tr>
            <td style="text-align:center; font-weight:bold; border-bottom:1px dotted black; border-top:1px dotted black; padding:5px;">${t.pakbon}</td>
          </tr></tbody>
        </table>
      </div>

      <div style="margin-top:10px; border-bottom:1px dotted black; padding:5px 0;">${t.datum}: ${fmtDate(order.shopify_created_at)}</div>

      <div style="margin-top:20px;">${escapeHtml(order.customer_name || '-')}</div>
      ${addressLines.map(line => `<div style="margin-top:5px;">${escapeHtml(line)}</div>`).join('') || '<div style="margin-top:5px;">-</div>'}

      ${order.note ? `
      <div style="margin-top:15px; padding:8px; border:2px solid black; font-weight:800; text-align:left;">
        ${isGerman ? 'NOTIZ' : 'NOTITIE'}: ${escapeHtml(order.note)}
      </div>
      ` : ''}

      ${order.size_override ? `
      <div style="margin-top:15px; padding:8px; border:2px solid black; text-align:center; font-weight:800;">
        ${isGerman ? 'FORMAT GEÄNDERT AUF' : 'FORMAAT AANGEPAST NAAR'} ${order.size_override}cm
      </div>
      ` : ''}

      <div style="margin-top:20px; text-align:left;">
        <table style="width:100%; text-align:left; font-size:12px;">
          <tbody>
            <tr>
              <th style="border-bottom:1px dotted black;">${t.artikel}</th>
              <th style="border-bottom:1px dotted black; text-align:right;">${t.aantal}</th>
            </tr>
            ${itemRows}
          </tbody>
        </table>
      </div>

      ${photoHtml}
      ${nietGeladenHtml}

      ${order.order_number ? `
      <div style="text-align:center; margin:8px auto 4px auto;"><div style="display:inline-block; width:60mm;">${orderBarcodeSvg(order.order_number)}</div></div>
      ` : ''}

      <div style="margin-top:10px; text-align:center;">${t.contact}</div>
    </div>
  `;
}

module.exports = { buildReceiptHtml, escapeHtml, fmtDate, translateProductText };
