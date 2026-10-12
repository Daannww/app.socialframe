// Zelftest met een nep-fal (geen kosten, geen internet nodig).
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/aifoto-');
process.env.ADMIN_PASSWORD = 'pw'; process.env.PUBLIC_BASE_URL = 'http://localhost:4599'; process.env.FAL_KEY = 'x';
const sharp = require('sharp'); const http = require('http'); const assert = require('assert');
const fal = require('./fal'); const calls = [];
let imgUrlBuf;
fal.run = async (model, input) => { calls.push({ model, input }); return { images: [{ url: 'http://localhost:4598/fake.jpg' }] }; };
const app = require('./index');

(async () => {
  imgUrlBuf = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#c0392b' } }).jpeg().toBuffer();
  const fake = http.createServer((q, r) => { r.setHeader('content-type', 'image/jpeg'); r.end(imgUrlBuf); }).listen(4598);
  const srv = app.listen(4599);
  const B = 'http://localhost:4599', auth = { Authorization: 'Basic ' + Buffer.from('a:pw').toString('base64') };
  const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#2980b9' } }).jpeg().toBuffer();

  assert.equal((await fetch(B + '/admin/api/state')).status, 401);
  const d = await (await fetch(B + '/admin/api/designs', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test', prompt: 'maak er een aquarel van', active: true, products: '*' }) })).json();
  assert(d.id);
  const list = await (await fetch(B + '/api/designs?product=x')).json();
  assert.equal(list.designs.length, 1);

  async function gen(profile, orientation, client) {
    const fd = new FormData(); fd.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'f.jpg');
    Object.entries({ design_id: d.id, profile, orientation, client_id: client }).forEach(([k, v]) => fd.append(k, v));
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
  const p3 = await gen('tegel', 'landscape', 'client-aaaa1111');
  assert.equal(p3.status, 'done');
  const p4 = await gen('tegel', 'landscape', 'client-aaaa1111'); // 5e poging, limiet 4
  assert.equal(p4.status, 429);
  const bad = new FormData(); bad.append('photo', new Blob(['niet een foto']), 'f.txt');
  bad.append('design_id', d.id); bad.append('client_id', 'client-bbbb2222');
  assert.equal((await fetch(B + '/api/generate', { method: 'POST', body: bad })).status, 400);
  console.log('ALLE TESTS OK');
  srv.close(); fake.close(); process.exit(0);
})().catch((e) => { console.error('FOUT', e); process.exit(1); });
