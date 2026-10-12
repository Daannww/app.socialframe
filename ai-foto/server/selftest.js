// Zelftest met een nep-fal (geen kosten, geen internet nodig).
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/aifoto-');
process.env.ADMIN_PASSWORD = 'pw'; process.env.PUBLIC_BASE_URL = 'http://localhost:4599'; process.env.FAL_KEY = 'x';
const sharp = require('sharp'); const http = require('http'); const assert = require('assert');
const fal = require('./fal'); const calls = [];
let imgUrlBuf;
fal.run = async (model, input) => { calls.push({ model, input }); return { images: [{ url: 'http://localhost:4598/fake.jpg' }] }; };
const app = require('./index');
require('./db').setSetting('max_attempts', '4'); require('./db').setSetting('max_attempts_ip', '12');

(async () => {
  imgUrlBuf = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#c0392b' } }).jpeg().toBuffer();
  const fake = http.createServer((q, r) => { r.setHeader('content-type', 'image/jpeg'); r.end(imgUrlBuf); }).listen(4598);
  const srv = app.listen(4599);
  const B = 'http://localhost:4599', auth = { Authorization: 'Basic ' + Buffer.from('a:pw').toString('base64') };
  const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#2980b9' } }).jpeg().toBuffer();

  assert.equal((await fetch(B + '/admin/api/state')).status, 401);
  const setVariants = (n) => fetch(B + '/admin/api/settings', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ variants: n }) });
  await setVariants(1);
  const d = await (await fetch(B + '/admin/api/designs', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test', slug: 'Aquarel', prompt: 'maak er een aquarel van', prompt_with_text: 'aquarel met de tekst {{tekst}}', active: true, products: 'ander-product' }) })).json();
  assert(d.id);
  assert.equal((await (await fetch(B + '/api/designs?product=x')).json()).designs.length, 0);          // andere product-lijst
  assert.equal((await (await fetch(B + '/api/designs?product=ander-product')).json()).designs.length, 1);
  const bySlug = await (await fetch(B + '/api/designs?product=x&styles=popart,aquarel')).json();       // metafield wint
  assert.equal(bySlug.designs.length, 1); assert(bySlug.designs[0].allows_text);
  assert.equal((await (await fetch(B + '/api/designs?styles=popart')).json()).designs.length, 0);

  async function gen(profile, orientation, client, text) {
    const fd = new FormData(); fd.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'f.jpg');
    Object.entries({ design_id: d.id, profile, orientation, client_id: client }).forEach(([k, v]) => fd.append(k, v));
    if (text !== undefined) fd.append('text', text);
    const r = await fetch(B + '/api/generate', { method: 'POST', body: fd }); const j = await r.json();
    if (!r.ok) return { status: r.status, ...j };
    for (;;) { await new Promise((s) => setTimeout(s, 300)); const s = await (await fetch(B + '/api/jobs/' + j.job_id)).json();
      if (s.status === 'done' || s.status === 'error') return s; }
  }
  const t = await gen('tegel', 'landscape', 'client-aaaa1111');
  assert.equal(t.status, 'done', JSON.stringify(t));
  let m = await sharp(Buffer.from(await (await fetch(t.print_url)).arrayBuffer())).metadata();
  assert.equal(m.width, 1600); assert.equal(m.height, 1600); assert.equal(m.density, 300);
  assert.equal(calls[0].input.aspect_ratio, '1:1');
  assert(calls[0].input.image_url.startsWith('data:image/jpeg;base64,'));
  // 1024 < 1600 -> upscaler moet erbij zijn gekomen
  assert.equal(calls[1].model, 'fal-ai/clarity-upscaler');

  const p = await gen('poster', 'landscape', 'client-aaaa1111');
  m = await sharp(Buffer.from(await (await fetch(p.print_url)).arrayBuffer())).metadata();
  assert.equal(m.width, 2800); assert.equal(m.height, 2000);
  const pp = await gen('poster', 'portrait', 'client-aaaa1111');
  m = await sharp(Buffer.from(await (await fetch(pp.print_url)).arrayBuffer())).metadata();
  assert.equal(m.width, 2000); assert.equal(m.height, 2800);
  const p3 = await gen('tegel', 'landscape', 'client-aaaa1111', 'Mama "en" <b>Papa</b>');
  assert.equal(p3.status, 'done');
  assert.equal(p3.text, 'Mama en b Papa /b'); // aanhalingstekens en < > worden spaties
  const prompts = calls.filter((c) => c.input.prompt).map((c) => c.input.prompt);
  const lastPrompt = prompts[prompts.length - 1];
  assert(lastPrompt.startsWith('aquarel met de tekst "') && !lastPrompt.includes('<'), lastPrompt);
  assert.equal(prompts[prompts.length - 2], 'maak er een aquarel van'); // zonder tekst: gewone prompt
  // herbestelling: geschiedenis + hergebruik
  const hist = await (await fetch(B + '/api/history?client_id=client-aaaa1111&profile=tegel')).json();
  assert(hist.items.length >= 2);
  const wrong = await fetch(B + '/api/reuse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: hist.items[0].job_id, client_id: 'client-zzzz9999' }) });
  assert.equal(wrong.status, 404);                                                                    // andermans afbeelding kan niet
  const ok = await (await fetch(B + '/api/reuse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_id: hist.items[0].job_id, client_id: 'client-aaaa1111' }) })).json();
  assert(ok.print_url && ok.reuse_count === 1);
  const delBad = await fetch(B + '/api/jobs/' + hist.items[0].job_id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 'client-zzzz9999' }) });
  assert.equal(delBad.status, 404);                                                                    // andermans ontwerp kun je niet verwijderen
  const delOk = await fetch(B + '/api/jobs/' + hist.items[hist.items.length - 1].job_id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: 'client-aaaa1111' }) });
  assert.equal(delOk.status, 200);
  const hist2 = await (await fetch(B + '/api/history?client_id=client-aaaa1111&profile=tegel')).json();
  assert.equal(hist2.items.length, hist.items.length - 1);                                             // verdwenen uit de lijst
  const p4 = await gen('tegel', 'landscape', 'client-aaaa1111'); // 5e poging, limiet 4
  assert.equal(p4.status, 429);
  const bad = new FormData(); bad.append('photo', new Blob(['niet een foto']), 'f.txt');
  bad.append('design_id', d.id); bad.append('client_id', 'client-bbbb2222');
  assert.equal((await fetch(B + '/api/generate', { method: 'POST', body: bad })).status, 400);
  // Twee varianten: klant moet kiezen, pas daarna is er een printbestand/herbestelling
  await setVariants(2);
  const before = calls.length;
  const two = await gen('tegel', 'landscape', 'client-cccc3333');
  assert.equal(two.status, 'done'); assert.equal(two.variants.length, 2);
  assert.equal(two.print_url, null); assert.equal(two.chosen, null);
  assert.equal(calls.filter((c) => c.input.prompt).length - calls.slice(0, before).filter((c) => c.input.prompt).length, 2);
  const h0 = await (await fetch(B + '/api/history?client_id=client-cccc3333&profile=tegel')).json();
  assert.equal(h0.items.length, 0);                                                                   // nog niet gekozen = niet in geschiedenis
  const post = (u, b) => fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal((await post('/api/jobs/' + two.job_id + '/choose', { client_id: 'client-zzzz9999', index: 1 })).status, 404);
  assert.equal((await post('/api/jobs/' + two.job_id + '/choose', { client_id: 'client-cccc3333', index: 5 })).status, 400);
  const pick = await (await post('/api/jobs/' + two.job_id + '/choose', { client_id: 'client-cccc3333', index: 1 })).json();
  m = await sharp(Buffer.from(await (await fetch(pick.print_url)).arrayBuffer())).metadata();
  assert.equal(m.width, 1600);
  const h1 = await (await fetch(B + '/api/history?client_id=client-cccc3333&profile=tegel')).json();
  assert.equal(h1.items.length, 1);
  console.log('ALLE TESTS OK');
  srv.close(); fake.close(); process.exit(0);
})().catch((e) => { console.error('FOUT', e); process.exit(1); });
