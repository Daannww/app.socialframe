const { Resend } = require('resend');

let resendClient = null;
function getResendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

// Haalt alleen de voornaam uit de volledige klantnaam, voor een persoonlijkere
// aanhef ("Hoi Marleen" i.p.v. "Hoi Marleen Da Silva Dias").
function firstName(fullName) {
  if (!fullName) return '';
  return fullName.trim().split(/\s+/)[0];
}

function buildReviewEmailHtml(order) {
  const naam = firstName(order.customer_name) || 'daar';
  const reviewUrl = process.env.TRUSTPILOT_REVIEW_URL || '#';

  return `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
    <h1 style="font-size: 20px; margin-bottom: 4px;">Hoi ${naam},</h1>
    <p style="font-size: 15px; line-height: 1.6;">
      We hopen dat je super blij bent met je Socialframe®! We zijn benieuwd
      hoe we het gedaan hebben — zou je een paar minuutjes willen nemen om een
      review achter te laten? Dat helpt ons enorm, en andere klanten ook om de
      juiste keuze te maken.
    </p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${reviewUrl}" style="background:#000000; color:#ffffff; text-decoration:none; padding: 14px 28px; border-radius: 6px; font-weight: bold; display: inline-block;">
        Laat een review achter
      </a>
    </div>
    <p style="font-size: 13px; line-height: 1.6; color: #6b7280;">
      Bedankt voor je bestelling bij Socialframe®!<br>
      Heb je vragen of opmerkingen? Stuur een mail naar
      <a href="mailto:info@socialframe.nl" style="color:#6b7280;">info@socialframe.nl</a>.
    </p>
  </div>
  `;
}

// Verstuurt de review-mail voor 1 order. Geeft true terug bij succes.
async function sendReviewEmail(order) {
  const client = getResendClient();
  if (!client) {
    throw new Error('RESEND_API_KEY is niet ingesteld in .env — kan geen mail versturen.');
  }
  const fromAddress = process.env.REVIEW_EMAIL_FROM || 'Socialframe <info@socialframe.nl>';

  await client.emails.send({
    from: fromAddress,
    to: order.customer_email,
    subject: 'Hoe bevalt je Socialframe? We horen het graag ⭐',
    html: buildReviewEmailHtml(order)
  });
}

module.exports = { sendReviewEmail, buildReviewEmailHtml, firstName };
