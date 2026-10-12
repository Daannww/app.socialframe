// Minimale fal.ai queue-client (REST). Geen extra dependency nodig.
const BASE = 'https://queue.fal.run';

function headers() {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY ontbreekt (zet hem als variabele op de server)');
  return { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json' };
}

async function run(model, input, { timeoutMs = 240000, pollMs = 1500 } = {}) {
  const sub = await fetch(`${BASE}/${model}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
  if (!sub.ok) throw new Error(`fal submit ${sub.status}: ${(await sub.text()).slice(0, 300)}`);
  const job = await sub.json();
  const statusUrl = job.status_url || `${BASE}/${model}/requests/${job.request_id}/status`;
  const resultUrl = job.response_url || `${BASE}/${model}/requests/${job.request_id}`;
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error('fal timeout');
    await new Promise((r) => setTimeout(r, pollMs));
    const st = await fetch(statusUrl, { headers: headers() });
    if (!st.ok) throw new Error(`fal status ${st.status}`);
    const s = await st.json();
    if (s.status === 'COMPLETED') break;
    if (s.status === 'FAILED' || s.error) throw new Error('fal mislukt: ' + JSON.stringify(s.error || s).slice(0, 300));
  }
  const res = await fetch(resultUrl, { headers: headers() });
  if (!res.ok) throw new Error(`fal result ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Haalt de eerste afbeeldings-URL uit de uiteenlopende output-vormen van fal-modellen.
function firstImageUrl(out) {
  if (!out) return null;
  if (out.images && out.images[0]) return out.images[0].url || out.images[0];
  if (out.image) return out.image.url || out.image;
  if (out.output && out.output.url) return out.output.url;
  return null;
}

module.exports = { run, firstImageUrl };
