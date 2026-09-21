const { Resend } = require('resend');

let resendClient = null;
function getResendClient() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

function buildTweeFactorEmailHtml(code) {
  return `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1a1a1a;">
    <h1 style="font-size: 18px; margin-bottom: 4px;">Inlogverificatie</h1>
    <p style="font-size: 15px; line-height: 1.6;">
      Gebruik onderstaande code om in te loggen op het order dashboard.
      Deze code is 10 minuten geldig.
    </p>
    <div style="text-align: center; margin: 28px 0;">
      <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; font-family: monospace;">${code}</span>
    </div>
    <p style="font-size: 13px; line-height: 1.6; color: #6b7280;">
      Heb je deze code niet zelf aangevraagd? Dan heeft iemand anders je
      wachtwoord geraden — verander in dat geval je wachtwoord.
    </p>
  </div>
  `;
}

// Geeft true terug bij succes. Gooit een duidelijke fout als Resend niet
// (correct) is ingesteld — de aanroeper vangt dit af.
async function stuurTweeFactorCode(code) {
  const client = getResendClient();
  if (!client) {
    throw new Error('RESEND_API_KEY is niet ingesteld in .env — kan geen verificatiecode versturen.');
  }
  const naarAdres = process.env.TWO_FACTOR_EMAIL;
  if (!naarAdres) {
    throw new Error('TWO_FACTOR_EMAIL is niet ingesteld in .env — kan geen verificatiecode versturen.');
  }
  const fromAddress = process.env.REVIEW_EMAIL_FROM || 'Socialframe <info@socialframe.nl>';

  await client.emails.send({
    from: fromAddress,
    to: naarAdres,
    subject: `Inlogcode: ${code}`,
    html: buildTweeFactorEmailHtml(code)
  });
}

// Is 2FA-per-e-mail geconfigureerd? (RESEND_API_KEY + TWO_FACTOR_EMAIL
// moeten allebei ingesteld zijn) — zo niet, dan slaat het inloggen deze
// stap gewoon over (geen brekende verandering voor wie dit nog niet heeft
// ingesteld).
function tweeFactorIsGeconfigureerd() {
  return Boolean(process.env.RESEND_API_KEY && process.env.TWO_FACTOR_EMAIL);
}

module.exports = { stuurTweeFactorCode, tweeFactorIsGeconfigureerd, buildTweeFactorEmailHtml };
