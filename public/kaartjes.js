// --- Tabblad "Kaartjes": handgeschreven kaartjes voor de schrijfmachine ---
//
// Het voorbeeld hieronder tekent precies dezelfde pennenstreken als de
// schrijfagent op de Mac (zelfde lijn-lettertypes, zelfde regels voor
// afbreken, verkleinen en centreren — zie schrijfmachine/handschrift.py en
// kaart_layout.py). Alleen de kleine "menselijke" variaties per letter
// laten we in het voorbeeld weg.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let info = null;            // { sjablonen, lettertypes, agent }
  let teksten = [];           // opgeslagen teksten
  let orders = [];            // voor het kiezen van een bestelling
  let gekozenOrder = null;
  let verversTimer = null;
  let voorbeeldTimer = null;
  let geladen = false;
  const fontCache = {};
  const FONT_VERSIE = 2; // ophogen als de lijn-lettertypes in public/schrijffonts veranderen

  // ---------- Uitgelogd? ----------
  // Na 7 dagen (of na uitloggen in een ander tabblad) is de sessie verlopen.
  // Dan stuurt de server 401 (API) of een doorverwijzing naar /login (bestanden).
  // In plaats van vage foutmeldingen tonen we dan één duidelijke melding.
  class Uitgelogd extends Error {}
  let uitgelogdGemeld = false;

  function controleerSessie(res) {
    if (res.status === 401 || res.redirected || /\/login(\?|$)/.test(res.url || '')) {
      toonUitgelogd();
      throw new Uitgelogd('Je bent uitgelogd');
    }
  }

  function toonUitgelogd() {
    if (uitgelogdGemeld) return;
    uitgelogdGemeld = true;
    clearInterval(verversTimer);
    verversTimer = null;
    const balk = document.createElement('div');
    balk.className = 'kaart-uitgelogd-balk';
    balk.innerHTML = '<span><i class="fa-solid fa-right-to-bracket"></i> Je bent uitgelogd (sessie verlopen). Log opnieuw in om verder te gaan.</span>' +
      '<a class="btn btn-primary" href="/login">Opnieuw inloggen</a>';
    const kop = $('kaartjesView').querySelector('.kaartjes-kop');
    kop.parentNode.insertBefore(balk, kop.nextSibling);
    $('kaartVoorbeeld').textContent = 'Log opnieuw in om het voorbeeld te zien.';
  }

  // ---------- Lijn-lettertypes (SVG-fonts) ----------

  function parsePad(d) {
    const tokens = d.match(/[MLCZmlcz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    const strokes = [];
    let cur = [];
    let cmd = null;
    let i = 0;
    const flush = () => { if (cur.length > 1) strokes.push(cur); cur = []; };
    while (i < tokens.length) {
      const t = tokens[i];
      if (/^[MLCZmlcz]$/.test(t)) {
        cmd = t.toUpperCase();
        i++;
        if (cmd === 'Z' && cur.length) { cur.push(cur[0]); flush(); }
        continue;
      }
      const need = { M: 2, L: 2, C: 6 }[cmd] || 0;
      if (!need) { i++; continue; }
      const n = [];
      while (n.length < need && i < tokens.length && !/^[MLCZmlcz]$/.test(tokens[i])) n.push(parseFloat(tokens[i++]));
      if (n.length < need) break;
      if (cmd === 'M') { flush(); cur = [[n[0], n[1]]]; cmd = 'L'; }
      else if (cmd === 'L') cur.push([n[0], n[1]]);
      else if (cmd === 'C') {
        const p0 = cur[cur.length - 1];
        const steps = 8;
        for (let s = 1; s <= steps; s++) {
          const u = s / steps, mu = 1 - u;
          cur.push([
            mu * mu * mu * p0[0] + 3 * mu * mu * u * n[0] + 3 * mu * u * u * n[2] + u * u * u * n[4],
            mu * mu * mu * p0[1] + 3 * mu * mu * u * n[1] + 3 * mu * u * u * n[3] + u * u * u * n[5]
          ]);
        }
      }
    }
    flush();
    return strokes;
  }

  async function laadFont(naam) {
    if (fontCache[naam]) return fontCache[naam];
    // ?v=… zorgt dat de browser na een update van de lettertypes de nieuwe versie ophaalt
    const res = await fetch(`/schrijffonts/${encodeURIComponent(naam)}.svg?v=${FONT_VERSIE}`, { cache: 'no-cache' });
    controleerSessie(res);
    if (!res.ok) throw new Error('Lettertype ' + naam + ' niet gevonden');
    const doc = new DOMParser().parseFromString(await res.text(), 'image/svg+xml');
    const fontEl = doc.querySelector('font');
    const face = doc.querySelector('font-face');
    if (!fontEl || !face) throw new Error('Lettertype ' + naam + ' kon niet gelezen worden');
    const font = {
      defaultAdv: parseFloat(fontEl.getAttribute('horiz-adv-x') || '500'),
      xheight: parseFloat(face.getAttribute('x-height') || '300') || 300,
      glyphs: {}
    };
    doc.querySelectorAll('glyph').forEach(g => {
      const u = g.getAttribute('unicode');
      if (u == null || [...u].length !== 1) return;
      font.glyphs[u] = {
        adv: parseFloat(g.getAttribute('horiz-adv-x') || font.defaultAdv),
        strokes: parsePad(g.getAttribute('d') || '')
      };
    });
    fontCache[naam] = font;
    return font;
  }

  // Emoji-hartjes worden een met de hand getekend hartje (zelfde vorm als op de
  // machine, zie hartje() in schrijfmachine/handschrift.py); emoji-hulptekens
  // (kleurvariant e.d.) tekenen niets.
  const HARTJES = new Set(['\u2764', '\u2665', '\u2661', '\u2763', '💕', '💖', '💗', '💓', '💞', '💘', '💝', '💟',
    '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '🩷', '🩵', '🩶', '😍', '🥰']);
  const ONZICHTBAAR = new Set(['\ufe0f', '\ufe0e', '\u200d']);

  function hartje(xheight) {
    const s = (xheight * 1.5) / 29;
    const marge = xheight * 0.15;
    const pts = [];
    const n = 48;
    for (let i = 0; i <= n; i++) {
      const t = (Math.PI * 2 * i) / n;
      const x = 16 * Math.pow(Math.sin(t), 3);
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      pts.push([marge + (x + 16) * s, (y + 17) * s]);
    }
    return { adv: 32 * s + 2 * marge, strokes: [pts] };
  }

  function glyph(font, ch) {
    if (font.glyphs[ch]) return font.glyphs[ch];
    if (ONZICHTBAAR.has(ch)) return { adv: 0, strokes: [] };
    if (HARTJES.has(ch)) return hartje(font.xheight);
    const basis = ch.normalize('NFKD')[0];
    return font.glyphs[basis] || { adv: font.defaultAdv, strokes: [] };
  }

  function meet(font, tekst, xh) {
    const k = xh / font.xheight;
    let som = 0;
    for (const ch of tekst) som += glyph(font, ch).adv;
    return som * k;
  }

  function afbreken(font, tekst, xh, breed) {
    const regels = [];
    tekst.split('\n').forEach(alinea => {
      if (!alinea.trim()) { regels.push(''); return; }
      let cur = '';
      alinea.split(/\s+/).filter(Boolean).forEach(w => {
        const poging = (cur + ' ' + w).trim();
        if (meet(font, poging, xh) <= breed || !cur) cur = poging;
        else { regels.push(cur); cur = w; }
      });
      regels.push(cur);
    });
    return regels;
  }

  function schrijfRegel(font, tekst, x, y, xh) {
    const k = xh / font.xheight;
    const uit = [];
    let cx = 0;
    for (const ch of tekst) {
      const g = glyph(font, ch);
      g.strokes.forEach(st => uit.push(st.map(([gx, gy]) => [x + (gx + cx) * k, y - gy * k])));
      cx += g.adv;
    }
    return uit;
  }

  // Zelfde logica als text_block() in handschrift.py
  function tekstBlok(font, tekst, x, y, w, h, xh, { regelFactor = 3.4, minXh = 1.6, breekAf = true, centreer = false } = {}) {
    const wEff = w / 1.07;
    const start = xh;
    let regels, lh;
    for (;;) {
      lh = xh * regelFactor;
      const heel = !breekAf && xh > start * 0.70;
      regels = heel ? tekst.split('\n') : afbreken(font, tekst, xh, wEff);
      const breedste = Math.max(0, ...regels.map(r => meet(font, r, xh)));
      if ((regels.length * lh <= h && breedste <= wEff) || xh <= minXh) break;
      xh *= 0.95;
    }
    const uit = [];
    let by = y + xh * 2.2;
    if (centreer) {
      const inhoud = xh * 2.2 + (regels.length - 1) * lh + xh * 1.2;
      by += Math.max(0, (h - inhoud) / 2);
    }
    regels.forEach(r => {
      if (r) {
        const lx = centreer ? x + Math.max(0, (w - meet(font, r, xh)) / 2) : x;
        uit.push(...schrijfRegel(font, r, lx, by, xh));
      }
      by += lh;
    });
    return uit;
  }

  function maakStreken(font, sjabloon, tekst, adresRegels) {
    if (sjabloon.type === 'ansichtkaart') {
      const W = sjabloon.breed, H = sjabloon.hoog, m = sjabloon.marge;
      const split = W * 0.52;
      const st = tekstBlok(font, tekst, m, m, split - m - 5, H - 2 * m, 2.6);
      st.push([[split, m + 6], [split + 0.6, H - m - 4]]);
      const pw = 20, ph = 24, x0 = W - m - pw, y0 = m;
      st.push([[x0, y0], [x0 + pw, y0], [x0 + pw, y0 + ph], [x0, y0 + ph], [x0, y0]]);
      const ax = split + 5, ay = H * 0.42;
      const adres = adresRegels.filter(r => r && r.trim()).join('\n');
      st.push(...tekstBlok(font, adres, ax, ay, W - m - ax, H - m - ay, 2.9, { regelFactor: 3.6, breekAf: false }));
      return st;
    }
    const { breed: W, hoog: H, marge: m } = sjabloon;
    return tekstBlok(font, tekst, m, m, W - 2 * m, H - 2 * m, sjabloon.letterhoogte || 3.5, { centreer: sjabloon.centreren !== false });
  }

  // ---------- Formulier ----------
  function voornaamVan(naam) { return (naam || '').trim().split(/\s+/)[0] || ''; }

  function definitieveTekst() {
    const naam = $('kaartNaam').value.trim();
    return $('kaartTekst').value
      .replace(/\{voornaam\}/gi, voornaamVan(naam))
      .replace(/\{naam\}/gi, naam);
  }

  function adresRegels() {
    const naam = $('kaartNaam').value.trim();
    const regels = $('kaartAdres').value.split('\n').map(r => r.trim()).filter(Boolean);
    return naam ? [naam, ...regels] : regels;
  }

  function huidigSjabloon() { return info.sjablonen[$('kaartSjabloon').value]; }

  async function tekenVoorbeeld() {
    const doel = $('kaartVoorbeeld');
    if (!info) return;
    const sj = huidigSjabloon();
    $('kaartAdresWrap').classList.toggle('hidden', sj.type !== 'ansichtkaart');
    $('kaartMaat').textContent = `(${sj.breed} × ${sj.hoog} mm)`;
    try {
      const font = await laadFont($('kaartLettertype').value);
      const streken = maakStreken(font, sj, definitieveTekst(), adresRegels());
      const pad = streken.map(s => 'M' + s.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L')).join('');
      doel.innerHTML = `<svg viewBox="-2 -2 ${sj.breed + 4} ${sj.hoog + 4}" xmlns="http://www.w3.org/2000/svg" aria-label="Voorbeeld van het kaartje">
        <rect x="0" y="0" width="${sj.breed}" height="${sj.hoog}" fill="#fffdf7" stroke="#c9ccd1" stroke-width="0.3" stroke-dasharray="1.5 1"/>
        <path d="${pad}" fill="none" stroke="#1b2a5e" stroke-width="0.32" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    } catch (e) {
      if (!(e instanceof Uitgelogd)) doel.textContent = 'Kon voorbeeld niet maken: ' + e.message;
    }
  }

  function planVoorbeeld() {
    clearTimeout(voorbeeldTimer);
    voorbeeldTimer = setTimeout(tekenVoorbeeld, 120);
  }

  function vulTeksten(selecteerId) {
    const sel = $('kaartTekstKeuze');
    sel.innerHTML = '<option value="">— Opgeslagen teksten —</option>' +
      teksten.map(t => `<option value="${t.id}">${esc(t.naam)}</option>`).join('');
    if (selecteerId) sel.value = String(selecteerId);
  }

  async function laadOrders() {
    try {
      const res = await fetch('/api/orders');
      if (!res.ok) return;
      orders = (await res.json()).slice(0, 300);
      $('kaartOrderLijst').innerHTML = orders.map(o =>
        `<option value="#${esc(o.order_number || o.id)} – ${esc(o.customer_name || '')}"></option>`).join('');
    } catch (e) { /* niet erg: dan gewoon zonder bestelling */ }
  }

  function kiesOrder() {
    const waarde = $('kaartOrder').value;
    const m = waarde.match(/^#?\s*([^\s–-]+)/);
    gekozenOrder = null;
    if (!m) return;
    const o = orders.find(x => String(x.order_number || x.id).replace(/^#/, '') === m[1].replace(/^#/, ''));
    if (!o) return;
    gekozenOrder = o;
    $('kaartNaam').value = o.customer_name || '';
    const delen = (o.shipping_address || '').split(',').map(s => s.trim()).filter(Boolean);
    // sommige (oudere) orders hebben de naam al vooraan in het adres staan
    if (delen.length && o.customer_name && delen[0].toLowerCase() === o.customer_name.trim().toLowerCase()) delen.shift();
    // land weglaten voor Nederland (staat niet op een Nederlandse kaart)
    if (delen.length && /^(netherlands|nederland)$/i.test(delen[delen.length - 1])) delen.pop();
    $('kaartAdres').value = delen.join('\n');
    planVoorbeeld();
  }

  // ---------- Wachtrij ----------
  const STATUS = {
    concept: ['Bewaard', 'other'],
    wachtrij: ['In wachtrij', 'wacht-op-productie'],
    bezig: ['Wordt geschreven…', 'kaart-bezig'],
    klaar: ['Geschreven', 'verzonden'],
    fout: ['Mislukt', 'onjuiste-gegevens'],
    gestopt: ['Gestopt', 'geannuleerd']
  };
  let bezigJob = null;

  async function laadJobs() {
    try {
      const [jr, ir] = await Promise.all([fetch('/api/schrijfmachine/jobs'), fetch('/api/schrijfmachine/info')]);
      controleerSessie(jr);
      controleerSessie(ir);
      if (!jr.ok || !ir.ok) return;
      const jobs = await jr.json();
      const nieuweInfo = await ir.json();
      info.agent = nieuweInfo.agent;
      info.wachtrij = nieuweInfo.wachtrij;
      toonAgent();
      toonKaartKlaar();
      toonBezig(jobs.find(x => x.status === 'bezig') || null);
      const body = $('kaartJobs');
      if (!jobs.length) {
        body.innerHTML = '<tr><td colspan="6" class="empty-row">Nog geen kaartjes.</td></tr>';
        return;
      }
      body.innerHTML = jobs.map(j => {
        let [label, cls] = STATUS[j.status] || [j.status, 'other'];
        if (j.status === 'bezig') {
          if (j.gepauzeerd) label = 'Gepauzeerd';
          else if (j.opdracht === 'pauze') label = 'Pauzeert…';
          else if (j.opdracht === 'stop') label = 'Stopt…';
          else if (j.voortgang != null) label = `Wordt geschreven… ${j.voortgang}%`;
        }
        const sj = info.sjablonen[j.sjabloon];
        const acties = [];
        if (['concept', 'klaar', 'fout', 'gestopt'].includes(j.status)) {
          acties.push(`<button class="btn btn-primary btn-klein" data-actie="schrijf" data-id="${j.id}" title="Leg het kaartje in de machine en schrijf"><i class="fa-solid fa-pen-nib"></i> ${j.status === 'concept' ? 'Schrijven' : 'Nog een keer'}</button>`);
        }
        if (j.status === 'wachtrij') acties.push(`<button class="btn btn-secondary btn-klein" data-actie="pauze" data-id="${j.id}">Uit wachtrij</button>`);
        acties.push(`<button class="btn btn-secondary btn-klein" data-actie="laad" data-id="${j.id}" title="Tekst en instellingen in het formulier laden"><i class="fa-solid fa-pen-to-square"></i></button>`);
        if (j.status !== 'bezig') acties.push(`<button class="inventory-delete-btn" data-actie="verwijder" data-id="${j.id}" title="Verwijderen"><i class="fa-solid fa-trash"></i></button>`);
        return `<tr>
          <td>${j.order_number ? '#' + esc(j.order_number) : '—'}</td>
          <td>${esc(j.naam || '—')}</td>
          <td>${esc(sj ? sj.naam : j.sjabloon)}<div class="kaartjes-klein">${esc(j.lettertype)}</div></td>
          <td class="kaartjes-tekstcel" title="${esc(j.tekst)}">${esc(j.tekst.replace(/\n+/g, ' · '))}</td>
          <td><span class="badge ${cls}">${label}</span>${j.fout ? `<div class="kaartjes-fout">${esc(j.fout)}</div>` : ''}</td>
          <td class="kaartjes-acties">${acties.join('')}</td>
        </tr>`;
      }).join('');
      body._jobs = jobs;
    } catch (e) { /* volgende ronde opnieuw */ }
  }

  function toonAgent() {
    const el = $('agentStatus');
    const a = info.agent || {};
    if (!a.token_ingesteld) {
      el.className = 'agent-status offline';
      el.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> SCHRIJF_AGENT_TOKEN niet ingesteld op Railway';
    } else if (a.online) {
      el.className = 'agent-status online';
      el.innerHTML = '<i class="fa-solid fa-circle"></i> Schrijfmachine verbonden';
    } else {
      el.className = 'agent-status offline';
      el.innerHTML = '<i class="fa-regular fa-circle"></i> Schrijfmachine niet verbonden' +
        (a.laatst_gezien ? ` <span class="kaartjes-klein">(laatst gezien ${esc(new Date(a.laatst_gezien.replace(' ', 'T') + 'Z')
          .toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))})</span>` : '');
    }
  }

  // Balk voor het kaartje dat nu geschreven wordt: voortgang + Pauze/Verder + Stop
  function toonBezig(job) {
    bezigJob = job;
    $('kaartBezigBalk').classList.toggle('hidden', !job);
    if (!job) {
      // niets meer bezig: terug naar rustig verversen
      if (verversTimer && verversTimer._snel) { clearInterval(verversTimer); verversTimer = setInterval(laadJobs, 4000); }
      return;
    }
    const wie = [job.order_number ? '#' + job.order_number : '', job.naam || ''].filter(Boolean).join(' ') || 'Kaartje';
    let staat = `wordt geschreven (${job.voortgang || 0}%)`;
    if (job.gepauzeerd) staat = `gepauzeerd bij ${job.voortgang || 0}% — pen staat omhoog`;
    else if (job.opdracht === 'pauze') staat = 'pauzeert na deze pennenstreek…';
    else if (job.opdracht === 'stop') staat = 'stopt na deze pennenstreek en rijdt terug naar de hoek…';
    $('kaartBezigTekst').textContent = `${wie}: ${staat}`;
    $('kaartVoortgang').style.width = (job.voortgang || 0) + '%';
    const pauzeKnop = $('kaartPauzeKnop');
    const gepauzeerd = job.gepauzeerd || job.opdracht === 'pauze';
    pauzeKnop.innerHTML = gepauzeerd ? '<i class="fa-solid fa-play"></i> Verder' : '<i class="fa-solid fa-pause"></i> Pauze';
    pauzeKnop.disabled = job.opdracht === 'stop';
    $('kaartStopKnop').disabled = job.opdracht === 'stop';
    // tijdens het schrijven vaker verversen
    if (verversTimer && verversTimer._snel !== true) {
      clearInterval(verversTimer); verversTimer = setInterval(laadJobs, 1500); verversTimer._snel = true;
    }
  }

  async function geefOpdracht(opdracht) {
    if (!bezigJob) return;
    try {
      await post(`/api/schrijfmachine/jobs/${bezigJob.id}/opdracht`, { opdracht });
      await laadJobs();
    } catch (e) { alert(e.message); }
  }

  // Banner "volgende kaartje ligt klaar": er staat iets in de wachtrij, maar de
  // machine wacht tot er een nieuw kaartje is neergelegd.
  function toonKaartKlaar() {
    const w = info.wachtrij || {};
    const toon = w.aantal > 0 && !w.bezig && !w.kaart_klaar;
    $('kaartKlaarBalk').classList.toggle('hidden', !toon);
    if (toon) {
      $('kaartKlaarTekst').textContent = `${w.aantal} kaartje${w.aantal === 1 ? '' : 's'} in de wachtrij. Leg een nieuw kaartje in de machine en bevestig.`;
    }
  }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    controleerSessie(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Onbekende fout');
    return data;
  }

  async function maakJob(direct) {
    const tekst = definitieveTekst().trim();
    if (!tekst) { alert('Vul eerst een tekst in.'); return; }
    if (/\{(voornaam|naam)\}/i.test($('kaartTekst').value) && !$('kaartNaam').value.trim()) {
      if (!confirm('De tekst gebruikt {voornaam}/{naam}, maar er is geen naam ingevuld. Toch doorgaan?')) return;
    }
    const knop = direct ? $('kaartSchrijf') : $('kaartBewaar');
    knop.disabled = true;
    try {
      await post('/api/schrijfmachine/jobs', {
        order_id: gekozenOrder ? gekozenOrder.id : null,
        order_number: gekozenOrder ? String(gekozenOrder.order_number || '') : null,
        naam: $('kaartNaam').value.trim(),
        adres: huidigSjabloon().type === 'ansichtkaart' ? adresRegels() : [],
        tekst,
        sjabloon: $('kaartSjabloon').value,
        lettertype: $('kaartLettertype').value,
        direct
      });
      if (direct && info.wachtrij && (info.wachtrij.bezig || info.wachtrij.aantal)) {
        alert('Er wordt al een kaartje geschreven of er staat er een klaar. Dit kaartje komt in de wachtrij; zodra het vorige klaar is leg je een nieuw kaartje neer en druk je op "Volgende kaartje ligt klaar".');
      } else if (direct && info.agent && !info.agent.online) {
        alert('Het kaartje staat in de wachtrij, maar de schrijfmachine is nu niet verbonden. Start de schrijfagent op de Mac, dan wordt het daarna geschreven.');
      }
      await laadJobs();
    } catch (e) {
      alert('Kon kaartje niet aanmaken: ' + e.message);
    } finally {
      knop.disabled = false;
    }
  }

  async function jobActie(e) {
    const knop = e.target.closest('[data-actie]');
    if (!knop) return;
    const id = knop.dataset.id;
    const actie = knop.dataset.actie;
    try {
      if (actie === 'schrijf') await post(`/api/schrijfmachine/jobs/${id}/status`, { status: 'wachtrij' });
      else if (actie === 'pauze') await post(`/api/schrijfmachine/jobs/${id}/status`, { status: 'concept' });
      else if (actie === 'verwijder') {
        if (!confirm('Dit kaartje verwijderen?')) return;
        const res = await fetch(`/api/schrijfmachine/jobs/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error);
      } else if (actie === 'laad') {
        const j = ($('kaartJobs')._jobs || []).find(x => String(x.id) === String(id));
        if (j) {
          $('kaartNaam').value = j.naam || '';
          $('kaartAdres').value = (j.adres || []).slice(j.naam ? 1 : 0).join('\n');
          $('kaartSjabloon').value = j.sjabloon;
          $('kaartLettertype').value = j.lettertype;
          $('kaartTekst').value = j.tekst;
          $('kaartTekstKeuze').value = '';
          planVoorbeeld();
          $('kaartjesView').scrollIntoView({ behavior: 'smooth' });
        }
        return;
      }
      await laadJobs();
    } catch (err) {
      alert(err.message);
    }
  }

  // ---------- Opstarten ----------
  async function initialiseer() {
    const [ir, tr] = await Promise.all([fetch('/api/schrijfmachine/info'), fetch('/api/schrijfmachine/teksten')]);
    info = await ir.json();
    teksten = await tr.json();

    $('kaartSjabloon').innerHTML = Object.entries(info.sjablonen)
      .map(([id, s]) => `<option value="${id}">${esc(s.naam)}</option>`).join('');
    $('kaartLettertype').innerHTML = info.lettertypes.map(l => `<option>${esc(l)}</option>`).join('');

    // laatste keuzes onthouden (alleen gemak, per browser)
    try {
      const s = localStorage.getItem('kaart_sjabloon'); if (s && info.sjablonen[s]) $('kaartSjabloon').value = s;
      const l = localStorage.getItem('kaart_lettertype'); if (l && info.lettertypes.includes(l)) $('kaartLettertype').value = l;
    } catch (e) { /* geen opslag beschikbaar */ }

    vulTeksten();
    if (teksten.length) {
      $('kaartTekstKeuze').value = String(teksten[0].id);
      $('kaartTekst').value = teksten[0].tekst;
    }

    ['kaartNaam', 'kaartAdres', 'kaartTekst'].forEach(id => $(id).addEventListener('input', planVoorbeeld));
    ['kaartSjabloon', 'kaartLettertype'].forEach(id => $(id).addEventListener('change', () => {
      try { localStorage.setItem('kaart_' + (id === 'kaartSjabloon' ? 'sjabloon' : 'lettertype'), $(id).value); } catch (e) { /* */ }
      planVoorbeeld();
    }));
    $('kaartOrder').addEventListener('change', kiesOrder);
    $('kaartTekstKeuze').addEventListener('change', () => {
      const t = teksten.find(x => String(x.id) === $('kaartTekstKeuze').value);
      if (t) { $('kaartTekst').value = t.tekst; planVoorbeeld(); }
    });
    $('kaartTekstOpslaan').addEventListener('click', async () => {
      const huidig = teksten.find(x => String(x.id) === $('kaartTekstKeuze').value);
      const naam = prompt('Naam voor deze tekst (bestaande naam = overschrijven):', huidig ? huidig.naam : '');
      if (!naam || !naam.trim()) return;
      try {
        teksten = await post('/api/schrijfmachine/teksten', { naam: naam.trim(), tekst: $('kaartTekst').value });
        const nieuw = teksten.find(x => x.naam === naam.trim());
        vulTeksten(nieuw && nieuw.id);
      } catch (e) { alert('Kon tekst niet opslaan: ' + e.message); }
    });
    $('kaartTekstVerwijder').addEventListener('click', async () => {
      const t = teksten.find(x => String(x.id) === $('kaartTekstKeuze').value);
      if (!t) { alert('Kies eerst een opgeslagen tekst.'); return; }
      if (!confirm(`Opgeslagen tekst "${t.naam}" verwijderen?`)) return;
      const res = await fetch(`/api/schrijfmachine/teksten/${t.id}`, { method: 'DELETE' });
      teksten = await res.json();
      vulTeksten();
    });
    $('kaartSchrijf').addEventListener('click', () => maakJob(true));
    $('kaartBewaar').addEventListener('click', () => maakJob(false));
    $('kaartJobs').addEventListener('click', jobActie);
    $('kaartPauzeKnop').addEventListener('click', () => {
      if (!bezigJob) return;
      geefOpdracht(bezigJob.gepauzeerd || bezigJob.opdracht === 'pauze' ? 'hervat' : 'pauze');
    });
    $('kaartStopKnop').addEventListener('click', () => {
      if (!bezigJob) return;
      if (confirm('Stoppen met dit kaartje? De machine maakt de huidige pennenstreek af, tilt de pen op en rijdt terug naar de hoek.')) geefOpdracht('stop');
    });
    $('kaartKlaarKnop').addEventListener('click', async () => {
      try { await post('/api/schrijfmachine/kaart-klaar'); await laadJobs(); } catch (e) { alert(e.message); }
    });
    geladen = true;
  }

  window.kaartjesOpenen = async function () {
    try {
      if (!geladen) await initialiseer();
      laadOrders();
      tekenVoorbeeld();
      await laadJobs();
      clearInterval(verversTimer);
      verversTimer = setInterval(laadJobs, 4000);
    } catch (e) {
      $('kaartVoorbeeld').textContent = 'Kon kaartjes niet laden: ' + e.message;
    }
  };

  window.kaartjesVerlaten = function () {
    clearInterval(verversTimer);
    verversTimer = null;
  };
})();
