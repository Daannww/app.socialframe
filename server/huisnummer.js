// Controle op een ontbrekend huisnummer in het verzendadres.
//
// - mistHuisnummer(addr): true als nergens in address1 / address2 / plaats een cijfer staat (de postcode telt niet mee).
//   Het huisnummer staat soms ergens anders ingevuld (achter de plaatsnaam, in adresregel 2), dan is er niets aan de hand.
// - zoekVoorstel(): heeft dezelfde klant (zelfde e-mailadres) eerder besteld naar dezelfde postcode + straat, dan stellen we
//   het huisnummer van die eerdere bestelling voor (alleen een tip in het dashboard, het adres zelf wijzigt niet).
// - controleerAdres(): zet de uitkomst in de orders-tabel (kolommen adres_check / adres_voorstel / adres_mail_at) en mailt
//   bij een NIEUWE order automatisch de klant (Resend) als er geen huisnummer is en er ook geen voorstel is.
const { db } = require('./db');

for (const kolom of ['adres_check TEXT', 'adres_voorstel TEXT', 'adres_mail_at TEXT']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${kolom}`); } catch (e) { /* bestaat al */ }
}

const heeftCijfer = (s) => /\d/.test(String(s || ''));

function mistHuisnummer(addr) {
  if (!addr || !String(addr.address1 || '').trim()) return false; // geen verzendadres (bv. afhalen / digitaal)
  const plaats = String(addr.city || '').replace(String(addr.zip || ''), '');
  return !(heeftCijfer(addr.address1) || heeftCijfer(addr.address2) || heeftCijfer(plaats));
}

const normPostcode = (z) => String(z || '').replace(/\s+/g, '').toUpperCase();
const alleenLetters = (s) => String(s || '').toLowerCase().replace(/[^a-zà-ÿ]/g, '');

// Eerdere bestelling van dezelfde klant naar dezelfde postcode + straat mét huisnummer.
function zoekVoorstel(orderId, email, addr) {
  if (!email || !addr) return null;
  const rijen = db.prepare(
    "SELECT raw_json FROM orders WHERE id != ? AND LOWER(customer_email) = LOWER(?) ORDER BY shopify_created_at DESC LIMIT 10"
  ).all(orderId, email);
  const straat = alleenLetters(addr.address1);
  for (const r of rijen) {
    let a;
    try { a = (JSON.parse(r.raw_json) || {}).shipping_address; } catch { continue; }
    if (!a || mistHuisnummer(a)) continue;
    if (normPostcode(a.zip) !== normPostcode(addr.zip) || !normPostcode(addr.zip)) continue;
    const s = alleenLetters(a.address1);
    if (straat && s && (s === straat || s.includes(straat) || straat.includes(s))) {
      return [a.address1, a.address2].filter(Boolean).join(', ');
    }
  }
  return null;
}

function mailTekst(order, addr) {
  const voornaam = String(order.customer_name || '').trim().split(/\s+/)[0] || '';
  const nummer = order.order_number || order.shopify_order_id;
  const nl = ['NL', 'BE', ''].includes(String(addr.country_code || '').toUpperCase());
  if (nl) {
    return {
      subject: `Huisnummer ontbreekt bij je bestelling #${nummer}`,
      html: `<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height:1.6; font-size:15px;">
        <p>Hoi ${voornaam},</p>
        <p>Bedankt voor je bestelling! Bij het verwerken zagen we dat het huisnummer nog ontbreekt in het verzendadres
        (<em>${[addr.address1, addr.address2, [addr.zip, addr.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</em>).</p>
        <p>Zou je op deze mail willen reageren met je huisnummer, zodat we je bestelling correct kunnen verzenden?</p>
        <p>Alvast bedankt!<br>Socialframe®</p></div>`
    };
  }
  return {
    subject: `House number missing for your order #${nummer}`,
    html: `<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height:1.6; font-size:15px;">
      <p>Hi ${voornaam},</p>
      <p>Thank you for your order! While processing it we noticed the house number is missing from your shipping address
      (<em>${[addr.address1, addr.address2, [addr.zip, addr.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</em>).</p>
      <p>Could you reply to this email with your house number so we can ship your order correctly?</p>
      <p>Thank you!<br>Socialframe®</p></div>`
  };
}

async function stuurMail(order, addr) {
  if (!process.env.RESEND_API_KEY) return { verstuurd: false, reden: 'RESEND_API_KEY niet ingesteld' };
  const { Resend } = require('resend');
  const client = new Resend(process.env.RESEND_API_KEY);
  const { subject, html } = mailTekst(order, addr);
  const res = await client.emails.send({
    from: process.env.REVIEW_EMAIL_FROM || 'Socialframe <info@socialframe.nl>',
    to: order.customer_email,
    replyTo: 'info@socialframe.nl',
    subject,
    html
  });
  if (res && res.error) throw new Error(res.error.message || 'Resend-fout');
  return { verstuurd: true };
}

// raw: de ruwe Shopify-order, mapped: uitkomst van mapOrder, isNew: alleen dan wordt er (eventueel) gemaild.
async function controleerAdres(raw, mapped, isNew) {
  const row = db.prepare('SELECT id, status, adres_mail_at FROM orders WHERE shopify_order_id = ?').get(mapped.shopify_order_id);
  if (!row) return;
  const addr = raw.shipping_address || null;
  if (!mistHuisnummer(addr)) {
    db.prepare("UPDATE orders SET adres_check = NULL, adres_voorstel = NULL WHERE id = ?").run(row.id);
    return;
  }
  const voorstel = zoekVoorstel(row.id, mapped.customer_email, addr);
  db.prepare("UPDATE orders SET adres_check = 'huisnummer_ontbreekt', adres_voorstel = ? WHERE id = ?").run(voorstel, row.id);
  if (!isNew || voorstel || row.adres_mail_at || row.status === 'verzonden' || row.status === 'geannuleerd' || !mapped.customer_email) return;
  try {
    const r = await stuurMail(mapped, addr);
    if (r.verstuurd) {
      db.prepare("UPDATE orders SET adres_mail_at = datetime('now') WHERE id = ?").run(row.id);
      console.log('[adres] huisnummer-mail verstuurd voor order', mapped.order_number);
    } else {
      console.log('[adres] huisnummer ontbreekt bij order', mapped.order_number, '- geen mail verstuurd:', r.reden);
    }
  } catch (e) {
    console.error('[adres] mail mislukt voor order', mapped.order_number + ':', e.message);
  }
}

// Eenmalig per serverstart: bestaande, nog niet verzonden orders markeren (nooit mailen).
function markeerBestaandeOrders() {
  const rijen = db.prepare("SELECT id, customer_email, raw_json FROM orders WHERE status NOT IN ('verzonden','geannuleerd')").all();
  const set = db.prepare('UPDATE orders SET adres_check = ?, adres_voorstel = ? WHERE id = ?');
  let n = 0;
  for (const r of rijen) {
    let addr = null;
    try { addr = (JSON.parse(r.raw_json) || {}).shipping_address || null; } catch { continue; }
    if (mistHuisnummer(addr)) { set.run('huisnummer_ontbreekt', zoekVoorstel(r.id, r.customer_email, addr), r.id); n++; }
    else set.run(null, null, r.id);
  }
  return n;
}

module.exports = { mistHuisnummer, controleerAdres, markeerBestaandeOrders };
