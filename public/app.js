const STATUSES = ['wacht op drukwerkbestand', 'wacht op productie', 'verzonden', 'geannuleerd', 'onjuiste gegevens'];
const PAGE_SIZE = 50;

let currentFilter = '';
let ordersCache = [];
let displayOrders = [];
let searchQuery = '';
let visibleCount = PAGE_SIZE;
let selectedIds = new Set();

const ordersBody = document.getElementById('ordersBody');
const modal = document.getElementById('orderModal');
const modalContent = document.getElementById('modalContent');
const lastSyncEl = document.getElementById('lastSync');
const paginationEl = document.getElementById('pagination');
const selectAllBox = document.getElementById('selectAllBox');
const selectionCountEl = document.getElementById('selectionCount');
const printSelectedBtn = document.getElementById('printSelectedBtn');
const printFilesBtn = document.getElementById('printFilesBtn');
const syncBtn = document.getElementById('syncBtn');
const searchInput = document.getElementById('searchInput');
const bulkStatusSelect = document.getElementById('bulkStatusSelect');
const bulkStatusBtn = document.getElementById('bulkStatusBtn');

function statusClass(status) {
  if (!status) return 'other';
  return status.trim().toLowerCase().replace(/\s+/g, '-');
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

// Subtiel vlaggetje vóór de klantnaam, op basis van het land van het
// verzendadres (via de flag-icons library, zelfde soort CDN-aanpak als
// FontAwesome). Onbekend/leeg land -> gewoon geen vlaggetje, geen foutmelding.
function flagHtml(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '';
  const code = countryCode.toLowerCase();
  return `<span class="fi fi-${code} order-flag" title="${escapeHtml(countryCode.toUpperCase())}"></span>`;
}

async function loadOrders() {
  const url = currentFilter ? `/api/orders?status=${encodeURIComponent(currentFilter)}` : '/api/orders';
  const res = await fetch(url);
  ordersCache = await res.json();
  visibleCount = PAGE_SIZE;
  applySearchFilter();
  lastSyncEl.textContent = 'Laatst geladen: ' + new Date().toLocaleTimeString('nl-NL');
}

function applySearchFilter() {
  const q = searchQuery.trim().toLowerCase();
  if (!q) {
    displayOrders = ordersCache;
  } else {
    displayOrders = ordersCache.filter(o => {
      const haystack = [
        o.customer_name,
        o.shipping_address,
        o.order_number,
        o.shopify_order_id,
        o.customer_email
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }
  visibleCount = PAGE_SIZE;
  renderTable();
}

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  applySearchFilter();
});

function getPageOrders() {
  return displayOrders.slice(0, visibleCount);
}

function renderTable() {
  const pageOrders = getPageOrders();

  if (!pageOrders.length) {
    ordersBody.innerHTML = `<tr><td colspan="8" class="empty-row">Geen orders gevonden</td></tr>`;
    renderLoadMore();
    updateSelectionUI();
    return;
  }

  ordersBody.innerHTML = pageOrders.map(o => `
    <tr data-id="${o.id}">
      <td class="no-row-open"><input type="checkbox" class="row-check" data-id="${o.id}" ${selectedIds.has(o.id) ? 'checked' : ''}></td>
      <td class="no-row-open">#${o.order_number || o.shopify_order_id}</td>
      <td><span class="customer-cell">${flagHtml(o.shipping_country_code)}${escapeHtml(o.customer_name || '-')}</span></td>
      <td>${fmtDate(o.shopify_created_at)}</td>
      <td>${o.spotify_links && o.spotify_links.length ? '<span class="spotify-dot">●</span> ' + o.spotify_links.length : '-'}</td>
      <td>${o.photo_links && o.photo_links.length ? '<i class="fa-solid fa-camera"></i> ' + o.photo_links.length : '-'}</td>
      <td><span class="badge ${statusClass(o.status)}">${escapeHtml(o.status)}</span></td>
      <td><button class="btn btn-secondary open-btn" data-id="${o.id}">Bekijken</button></td>
    </tr>
  `).join('');

  document.querySelectorAll('.open-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openOrder(el.dataset.id);
    });
  });

  document.querySelectorAll('.orders-table tbody tr').forEach(row => {
    row.addEventListener('click', (e) => {
      // Checkbox- en bestelnummer-kolom (voorkant van de rij) openen de order
      // NIET meer — alleen de rest van de rij (klant, datum, status, etc.)
      // blijft klikbaar om de order te openen. Het vinkje zelf werkt gewoon
      // door via zijn eigen 'change'-listener hieronder.
      if (e.target.closest('.no-row-open') || e.target.classList.contains('open-btn')) return;
      openOrder(row.dataset.id);
    });
  });

  document.querySelectorAll('.row-check').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
      updateSelectionUI();
    });
  });

  renderLoadMore();
  updateSelectionUI();
}

function renderLoadMore() {
  const remaining = displayOrders.length - visibleCount;
  if (remaining <= 0) {
    paginationEl.innerHTML = '';
    return;
  }
  const nextBatch = Math.min(PAGE_SIZE, remaining);
  paginationEl.innerHTML = `
    <button class="btn btn-primary load-more-btn" id="loadMoreBtn">
      <span class="load-more-icon"><i class="fa-solid fa-chevron-down"></i></span> Laad meer resultaten (${nextBatch})
    </button>
  `;
  document.getElementById('loadMoreBtn').addEventListener('click', () => {
    visibleCount += PAGE_SIZE;
    renderTable();
  });
}

function updateSelectionUI() {
  selectionCountEl.textContent = `${selectedIds.size} geselecteerd`;
  printSelectedBtn.disabled = selectedIds.size === 0;
  printFilesBtn.disabled = selectedIds.size === 0;
  bulkStatusBtn.disabled = selectedIds.size === 0 || !bulkStatusSelect.value;

  const pageOrders = getPageOrders();
  const allOnPageSelected = pageOrders.length > 0 && pageOrders.every(o => selectedIds.has(o.id));
  selectAllBox.checked = allOnPageSelected;
  selectAllBox.indeterminate = !allOnPageSelected && pageOrders.some(o => selectedIds.has(o.id));
}

selectAllBox.addEventListener('change', () => {
  const pageOrders = getPageOrders();
  if (selectAllBox.checked) {
    pageOrders.forEach(o => selectedIds.add(o.id));
  } else {
    pageOrders.forEach(o => selectedIds.delete(o.id));
  }
  renderTable();
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Escaped tekst zodat het veilig in een onclick="...'...'..." attribuut past
function jsEscape(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '\\n');
}

// Zet een telefoonnummer om naar het internationale cijfers-formaat dat wa.me
// verwacht (geen spaties/haakjes/streepjes/plusteken). Nederlandse nummers die
// met een 0 beginnen (bv. 06...) worden omgezet naar de 31-landcode.
function phoneToWhatsAppDigits(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    digits = digits.slice(1);
  } else if (digits.startsWith('0')) {
    digits = '31' + digits.slice(1); // aanname: Nederlands nummer
  }
  return digits || null;
}

// Kopieert tekst naar het klembord en geeft kort visuele feedback op het geklikte element
window.copyText = function (el, text) {
  navigator.clipboard.writeText(text).then(() => {
    const original = el.dataset.originalHtml !== undefined ? el.dataset.originalHtml : el.innerHTML;
    el.dataset.originalHtml = original;
    el.classList.add('copied-flash');
    const label = el.tagName === 'STRONG' ? `<i class="fa-solid fa-check"></i> Gekopieerd` : `<i class="fa-solid fa-check"></i> Gekopieerd`;
    el.innerHTML = label;
    setTimeout(() => {
      el.innerHTML = el.dataset.originalHtml;
      el.classList.remove('copied-flash');
    }, 900);
  }).catch(() => {
    alert('Kopiëren naar klembord is niet gelukt (mogelijk geen HTTPS/localhost).');
  });
};

// Forceert een browser-download van tekstinhoud (bv. SVG) als bestand
function downloadTextAsFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { blob, url };
}

let currentOpenOrderId = null;
let currentUserRole = 'admin'; // wordt bij het laden van de pagina bijgewerkt vanuit /api/session

async function openOrder(id) {
  const res = await fetch(`/api/orders/${id}`);
  const order = await res.json();
  currentOpenOrderId = order.id;
  renderModal(order);
  modal.classList.remove('hidden');
}

// Navigeert naar de vorige/volgende order binnen de huidige (gefilterde/gezochte)
// lijst, ongeacht hoeveel er al met "Laad meer resultaten" zijn ingeladen.
function openAdjacentOrder(direction) {
  if (currentOpenOrderId === null || displayOrders.length === 0) return;
  const index = displayOrders.findIndex(o => o.id === currentOpenOrderId);
  if (index === -1) return;
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= displayOrders.length) return; // aan het begin/einde van de lijst
  openOrder(displayOrders[newIndex].id);
}

function renderModal(order) {
  const lineItemsHtml = (order.line_items || []).map(li => `
    <div class="line-item">
      <div class="title copyable" onclick="copyText(this, '${jsEscape(li.title + (li.variant_title ? ' – ' + li.variant_title : ''))}')" title="Klik om te kopiëren">${escapeHtml(li.title)} ${li.variant_title ? '– ' + escapeHtml(li.variant_title) : ''}</div>
      <div class="meta">
        <span class="copyable" onclick="copyText(this, '${jsEscape(String(li.quantity))}')" title="Klik om te kopiëren">Aantal: ${li.quantity}</span> &nbsp;•&nbsp;
        <span class="copyable" onclick="copyText(this, '${jsEscape('€' + li.price)}')" title="Klik om te kopiëren">€${li.price}</span> &nbsp;•&nbsp;
        <span class="copyable" onclick="copyText(this, '${jsEscape(li.sku || '')}')" title="Klik om te kopiëren">SKU: ${escapeHtml(li.sku || '-')}</span>
      </div>
      ${li.properties && li.properties.length ? `<div class="props">${li.properties.map(p => `<span class="copyable" onclick="copyText(this, '${jsEscape(p.name + ': ' + p.value)}')" title="Klik om te kopiëren">${escapeHtml(p.name)}: ${escapeHtml(p.value)}</span>`).join('<br>')}</div>` : ''}
    </div>
  `).join('') || '<p>Geen items gevonden</p>';

  const musicFrameLineItems = (order.line_items || []).filter(li => /muziek[\s-]?frame|music[\s-]?frame|valentijn[\s-]?frame|valentine?s?[\s-]?frame|musik[\s-]?rahmen|valentins?[\s-]?rahmen/i.test(li.title || ''));
  // Houd rekening met aantal (quantity): 2x hetzelfde besteld = 2 losse knoppen/bestanden
  const musicFrameCount = musicFrameLineItems.reduce((sum, li) => sum + (li.quantity && li.quantity > 0 ? li.quantity : 1), 0);
  const musicFrameHtml = musicFrameCount > 0
    ? `<div style="display:flex; flex-direction:column; gap:8px;">${
        Array.from({ length: musicFrameCount }, (_, idx) => `
      <button class="btn btn-primary" onclick="downloadMusicFramePdf(${order.id}, ${idx}, this)">
        <i class="fa-solid fa-download"></i> Download muziekframe-bestand${musicFrameCount > 1 ? ` (${idx + 1})` : ''}
      </button>
    `).join('')
      }</div>`
    : '';

  const autoFrameLineItems = (order.line_items || []).filter(li => /auto[\s-]?frame|auto[\s-]?rahmen/i.test(li.title || ''));
  const autoFrameCount = autoFrameLineItems.reduce((sum, li) => sum + (li.quantity && li.quantity > 0 ? li.quantity : 1), 0);
  const autoFrameHtml = autoFrameCount > 0
    ? `<div style="display:flex; flex-direction:column; gap:8px;">${
        Array.from({ length: autoFrameCount }, (_, idx) => `
      <button class="btn btn-primary" onclick="downloadAutoFramePdf(${order.id}, ${idx}, this)">
        <i class="fa-solid fa-download"></i> Download auto-frame-bestand${autoFrameCount > 1 ? ` (${idx + 1})` : ''}
      </button>
    `).join('')
      }</div>`
    : '';

  // "Tegeltje met tekst": gebruikt het server-berekende texttile_items-veld
  // (i.p.v. hier zelf opnieuw met een regex te gokken) — blijft zo
  // automatisch in sync zodra er in texttile.js nieuwe ontwerpen bijkomen.
  const tegelTekstItems = order.texttile_items || [];
  const tegelTekstHtml = tegelTekstItems.length > 0
    ? `<div style="display:flex; flex-direction:column; gap:8px;">${
        tegelTekstItems.map((item, idx) => `
      <button class="btn btn-primary" onclick="downloadTegelTekstPdf(${order.id}, ${idx}, this)">
        <i class="fa-solid fa-download"></i> Download tegeltje-bestand${tegelTekstItems.length > 1 ? ` (${idx + 1})` : ''}${item.kleur ? ` — ${escapeHtml(item.kleur)}` : ''}
      </button>
    `).join('')
      }</div>`
    : '';

  // Sound-Frame: zelfde aanpak — server-berekend soundframe_items-veld gebruiken.
  const soundFrameItems = order.soundframe_items || [];
  const soundFrameHtml = soundFrameItems.length > 0
    ? `<div style="display:flex; flex-direction:column; gap:8px;">${
        soundFrameItems.map((item, idx) => `
      <button class="btn btn-primary" onclick="downloadSoundFramePdf(${order.id}, ${idx}, this)">
        <i class="fa-solid fa-download"></i> Download soundframe-bestand${soundFrameItems.length > 1 ? ` (${idx + 1})` : ''}
      </button>
    `).join('')
      }</div>`
    : '';

  const spotifyHtml = (order.spotify_links || []).map((link, idx) => `
    <div class="spotify-link-row" data-link="${escapeHtml(link)}">
      <a href="${escapeHtml(link)}" target="_blank" rel="noopener" class="copyable" onclick="event.preventDefault(); copyText(this, '${jsEscape(link)}')" title="Klik om te kopiëren">${escapeHtml(link)}</a>
      <div class="spotify-actions">
        <button class="btn btn-spotify" onclick="generateSpotifyCode(${order.id}, ${idx}, this)"><i class="fa-solid fa-download"></i> Create Spotify Code (SVG)</button>
        <button class="btn btn-qr" onclick="generateQrCode(${order.id}, ${idx}, this)"><i class="fa-solid fa-download"></i> Create QR Code (SVG)</button>
      </div>
      <div class="code-preview" id="spotify-preview-${order.id}-${idx}"></div>
      <div class="code-preview" id="qr-preview-${order.id}-${idx}"></div>
    </div>
  `).join('') || '<p>Geen Spotify link gevonden in deze order</p>';

  // Formaat (10x10 of 13x13) PER TEGEL-LINK apart — komt al correct per regel
  // bepaald uit de backend (extractTileItemsFromOrder in shopify.js), zodat
  // een order met bv. 1x 10x10 + 1x 13x13 niet per ongeluk allebei hetzelfde
  // formaat krijgt. Handmatige override (voor de hele order) heeft voorrang.
  const tileItemsInOrder = order.tile_items || [];
  const sizeForLink = (link) => {
    if (order.size_override === '13x13') return true;
    if (order.size_override === '10x10') return false;
    const match = tileItemsInOrder.find(t => t.link === link);
    return match ? match.is13x13 : false;
  };
  const baseFilename = String(order.order_number || order.shopify_order_id).replace(/[\\/:*?"<>|]/g, '-');

  const autopicturaLinksInOrder = (order.photo_links || []).filter(l => /autopictura/i.test(l));
  // "Gepersonaliseerde foto tegel"-uploads en Posterly-links tellen mee als
  // "tegel-link" voor de drukwerkbestand-knop, precies zoals bij autopictura
  // (zelfde knop, zelfde doorlopende nummering bij meerdere) — zie ook
  // appendPrintFilesToArchive in index.js, die deze alle drie al samenvoegt.
  const fotoTegelLinksInOrder = order.foto_tegel_links || [];
  const posterlyLinksInOrder = order.posterly_links || [];
  const tileLinksInOrder = [...autopicturaLinksInOrder, ...fotoTegelLinksInOrder, ...posterlyLinksInOrder];
  const multipleAutopictura = tileLinksInOrder.length > 1;

  // SVG-bestanden altijd bovenaan tonen in de Foto's-lijst, de rest erna in
  // de volgorde waarin ze gevonden zijn.
  const sortedPhotoLinks = [...(order.photo_links || [])].sort((a, b) => {
    const aIsSvg = /\.svg(\?|$)/i.test(a);
    const bIsSvg = /\.svg(\?|$)/i.test(b);
    if (aIsSvg && !bIsSvg) return -1;
    if (!aIsSvg && bIsSvg) return 1;
    return 0;
  });

  const photoHtml = sortedPhotoLinks.map((link) => {
    const isTileLink = tileLinksInOrder.includes(link);
    const tileIndex = isTileLink ? tileLinksInOrder.indexOf(link) + 1 : null;
    const is13x13 = isTileLink ? sizeForLink(link) : false;
    const sizeCm = is13x13 ? 13 : 10;
    const printFilename = baseFilename + (multipleAutopictura ? ` ${tileIndex}` : '') + (is13x13 ? ' groot' : '') + '.pdf';
    // Drukwerkbestand (PDF) downloaden is alleen voor het admin-account —
    // het pakbon-account krijgt voor tegel-links dus geen downloadknop.
    const isAdminOnlyBlocked = isTileLink && currentUserRole !== 'admin';
    const downloadHref = isTileLink
      ? `/api/print-files/single-pdf?link=${encodeURIComponent(link)}&widthCm=${sizeCm}&heightCm=${sizeCm}&filename=${encodeURIComponent(printFilename)}`
      : `/api/download?url=${encodeURIComponent(link)}`;
    const downloadLabel = isTileLink
      ? `<i class="fa-solid fa-download"></i> Download drukwerkbestand (PDF, ${sizeCm}×${sizeCm}cm)`
      : '<i class="fa-solid fa-download"></i> Download het bestand';

    return `
    <div class="spotify-link-row" data-link="${escapeHtml(link)}">
      <a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(link)}</a>
      <div class="code-preview">
        <img src="/api/photo-preview?url=${encodeURIComponent(link)}" alt="Foto van klant" onerror="this.replaceWith(Object.assign(document.createElement('p'), {textContent: 'Kon de foto niet laden'}))">
      </div>
      <div class="spotify-actions">
        ${isAdminOnlyBlocked ? '' : `<a class="btn btn-qr" href="${downloadHref}">${downloadLabel}</a>`}
      </div>
    </div>
  `;
  }).join('') || '<p>Geen foto gevonden in deze order</p>';

  const singleStatus = 'wacht op productie';
  const alreadyInStatus = order.status === singleStatus;
  const statusButtons = `
    <button class="btn btn-status" onclick="setStatus(${order.id}, '${singleStatus}')" ${alreadyInStatus ? 'disabled' : ''}>
      ${alreadyInStatus ? '<i class="fa-solid fa-check"></i> Wacht op productie' : 'Zet naar: Wacht op productie'}
    </button>
  `;

  // Alleen de voornaam gebruiken voor de aanhef (i.p.v. de volledige naam)
  const firstName = (order.customer_name || '').trim().split(' ')[0] || '';

  const mailtoHref = order.customer_email
    ? `mailto:${encodeURIComponent(order.customer_email)}?subject=${encodeURIComponent('Huisnummer ontbreekt bij bestelling #' + (order.order_number || order.shopify_order_id))}&body=${encodeURIComponent(`Hoi ${firstName},\n\nBedankt voor je bestelling! Bij het verwerken zagen we dat het huisnummer nog ontbreekt in het adres. Zou je dit aan ons willen doorgeven zodat we je bestelling correct kunnen verzenden?\n\nSocialframe®`)}`
    : null;

  const waDigits = phoneToWhatsAppDigits(order.customer_phone);
  const whatsappHref = waDigits
    ? `https://wa.me/${waDigits}?text=${encodeURIComponent(`Hoi ${firstName}, bedankt voor je bestelling! Bij het verwerken zagen we dat het huisnummer nog ontbreekt. Zou je dit even willen doorgeven? Alvast bedankt! - Socialframe`)}`
    : null;

  // Adresregels los weergeven i.p.v. één lange regel, voor de leesbaarheid in de popup
  const popupAddressLines = (order.shipping_address || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

  // Alleen regels tonen voor velden die daadwerkelijk een waarde hebben — geen
  // kaal streepje meer bij bv. een ontbrekend telefoonnummer.
  const contactLines = [];
  if (order.customer_name) {
    contactLines.push(`<strong class="copyable" onclick="copyText(this, '${jsEscape(order.customer_name)}')" title="Klik om te kopiëren">${escapeHtml(order.customer_name)}</strong>`);
  }
  if (order.customer_email) {
    contactLines.push(`<span class="copyable" onclick="copyText(this, '${jsEscape(order.customer_email)}')" title="Klik om te kopiëren">${escapeHtml(order.customer_email)}</span>`);
  }
  if (order.customer_phone) {
    contactLines.push(`<span class="copyable" onclick="copyText(this, '${jsEscape(order.customer_phone)}')" title="Klik om te kopiëren">${escapeHtml(order.customer_phone)}</span>`);
  }
  const contactHtml = contactLines.length ? contactLines.join('<br>') : '<span>-</span>';

  // Naam + volledig adres als 1 blok, voor als je alles in 1x wil kopiëren (bv. voor een verzendlabel)
  const fullAddressText = [order.customer_name, ...popupAddressLines].filter(Boolean).join('\n');

  modalContent.innerHTML = `
    <h2 class="copyable" onclick="copyText(this, '${jsEscape(String(order.order_number || order.shopify_order_id))}')" title="Klik om te kopiëren">Order #${escapeHtml(order.order_number || order.shopify_order_id)}</h2>

    <div class="modal-section">
      <h3>Klantgegevens</h3>
      <p>${contactHtml}</p>
      <div class="address-lines">
        ${popupAddressLines.length
          ? popupAddressLines.map(line => `<div class="copyable" onclick="copyText(this, '${jsEscape(line)}')" title="Klik om te kopiëren">${escapeHtml(line)}</div>`).join('')
          : '<div>-</div>'
        }
      </div>
      <div class="contact-actions">
        ${fullAddressText ? `<button type="button" class="btn btn-secondary" onclick="copyText(this, '${jsEscape(fullAddressText)}')" title="Klik om te kopiëren"><i class="fa-solid fa-copy"></i> Kopieer naam + adres</button>` : ''}
        ${mailtoHref ? `<a class="btn btn-secondary" href="${mailtoHref}"><i class="fa-solid fa-envelope"></i> Vraag huisnummer per e-mail</a>` : ''}
        ${whatsappHref ? `<a class="btn btn-whatsapp" href="${whatsappHref}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> Vraag huisnummer via WhatsApp</a>` : ''}
      </div>
    </div>

    <div class="modal-section">
      <h3>Cart details</h3>
      ${lineItemsHtml}
    </div>

    ${tileLinksInOrder.length > 0 ? `
    <div class="modal-section">
      <h3>Formaat</h3>
      ${(() => {
        const distinctSizes = new Set(tileItemsInOrder.map(t => t.is13x13));
        const isMixed = !order.size_override && distinctSizes.size > 1;
        const effectiveIs13x13 = order.size_override === '13x13' ? true
          : order.size_override === '10x10' ? false
          : (distinctSizes.size === 1 ? distinctSizes.has(true) : null);
        const huidigTekst = isMixed
          ? 'gemengd (per tegel verschillend formaat)'
          : (effectiveIs13x13 ? '13x13cm' : '10x10cm');
        return `
        <p>Huidig: <strong>${huidigTekst}</strong> — ${order.size_override ? 'handmatig aangepast' : 'automatisch, op basis van de bestelling'}</p>
        ${isMixed ? '<p style="color:var(--muted); font-size:13px;">Deze order heeft tegels van verschillend formaat. Onderstaande knoppen zetten ALLE tegels in deze order naar hetzelfde formaat.</p>' : ''}
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn ${effectiveIs13x13 === false ? 'btn-primary' : 'btn-secondary'}" onclick="setSizeOverride(${order.id}, '10x10')" ${effectiveIs13x13 === false ? 'disabled' : ''}>Zet naar 10x10cm</button>
          <button class="btn ${effectiveIs13x13 === true ? 'btn-primary' : 'btn-secondary'}" onclick="setSizeOverride(${order.id}, '13x13')" ${effectiveIs13x13 === true ? 'disabled' : ''}>Zet naar 13x13cm</button>
          ${order.size_override ? `<button class="btn btn-secondary" onclick="setSizeOverride(${order.id}, null)">Terug naar automatisch</button>` : ''}
        </div>
        `;
      })()}
    </div>
    ` : ''}

    ${musicFrameHtml ? `
    <div class="modal-section">
      <h3>Muziekframe / Valentijnframe</h3>
      ${musicFrameHtml}
    </div>
    ` : ''}

    ${autoFrameHtml ? `
    <div class="modal-section">
      <h3>Auto-frame</h3>
      ${autoFrameHtml}
    </div>
    ` : ''}

    ${tegelTekstHtml ? `
    <div class="modal-section">
      <h3>Tegeltje met tekst</h3>
      ${tegelTekstHtml}
    </div>
    ` : ''}

    ${soundFrameHtml ? `
    <div class="modal-section">
      <h3>Sound-Frame</h3>
      ${soundFrameHtml}
    </div>
    ` : ''}

    <div class="modal-section">
      <h3>Notitie</h3>
      <textarea id="noteInput-${order.id}" class="note-textarea" placeholder="Bijzonderheden over deze order... (verschijnt ook op de pakbon, onder het adres)">${escapeHtml(order.note || '')}</textarea>
      <button class="btn btn-secondary" onclick="saveNote(${order.id}, this)"><i class="fa-solid fa-floppy-disk"></i> Notitie opslaan</button>
    </div>

    <div class="modal-section">
      <h3>Link voor code</h3>
      ${spotifyHtml}
    </div>

    <div class="modal-section">
      <h3>Foto's</h3>
      ${photoHtml}
    </div>

    <div class="modal-section">
      <h3>Status wijzigen</h3>
      <div class="status-actions">${statusButtons}</div>
    </div>

    <div class="modal-section">
      <button class="btn btn-primary" onclick="printSingleOrder(${order.id})"><i class="fa-solid fa-print"></i> Print pakbon voor deze order</button>
    </div>
  `;

  window._currentSpotifyLinks = order.spotify_links || [];
}

window.saveNote = async function (orderId, btn) {
  const textarea = document.getElementById(`noteInput-${orderId}`);
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Bezig...';
  try {
    const res = await fetch(`/api/orders/${orderId}/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: textarea.value })
    });
    if (!res.ok) throw new Error('Server gaf een fout terug');
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Opgeslagen';
    setTimeout(() => { btn.innerHTML = originalLabel; }, 1500);
  } catch (e) {
    alert('Kon notitie niet opslaan: ' + e.message);
    btn.innerHTML = originalLabel;
  } finally {
    btn.disabled = false;
  }
};

window.setSizeOverride = async function (orderId, override) {
  try {
    const res = await fetch(`/api/orders/${orderId}/size-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ override })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Server gaf een fout terug');
    }
    // Popup herladen zodat de knoppen, bestandsnamen en pakbon-preview meteen
    // de nieuwe waarde tonen.
    await openOrder(orderId);
  } catch (e) {
    alert('Kon formaat niet aanpassen: ' + e.message);
  }
};

window.downloadMusicFramePdf = async function (orderId, idx, btn) {
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Bezig...';
  try {
    const res = await fetch(`/api/print-files/musicframe-pdf?orderId=${orderId}&itemIndex=${idx}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Server gaf een fout terug');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `muziekframe-order-${orderId}-${idx + 1}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('Kon muziekframe-bestand niet genereren: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
};

window.downloadAutoFramePdf = async function (orderId, idx, btn) {
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Bezig...';
  try {
    const res = await fetch(`/api/print-files/autoframe-pdf?orderId=${orderId}&itemIndex=${idx}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Server gaf een fout terug');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `autoframe-order-${orderId}-${idx + 1}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('Kon auto-frame-bestand niet genereren: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
};

window.downloadTegelTekstPdf = async function (orderId, idx, btn) {
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Bezig...';
  try {
    const res = await fetch(`/api/print-files/texttile-pdf?orderId=${orderId}&itemIndex=${idx}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Server gaf een fout terug');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tegeltje-met-tekst-order-${orderId}-${idx + 1}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('Kon tegeltje-bestand niet genereren: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
};

window.downloadSoundFramePdf = async function (orderId, idx, btn) {
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Bezig...';
  try {
    const res = await fetch(`/api/print-files/soundframe-pdf?orderId=${orderId}&itemIndex=${idx}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Server gaf een fout terug');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `soundframe-order-${orderId}-${idx + 1}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('Kon soundframe-bestand niet genereren: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
};

window.generateSpotifyCode = async function (orderId, idx, btn) {
  const link = window._currentSpotifyLinks[idx];
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Bezig...';
  try {
    const res = await fetch(`/api/spotify-code-svg?link=${encodeURIComponent(link)}`);
    if (!res.ok) throw new Error('Server gaf een fout terug');
    const svgText = await res.text();

    // Preview tonen (inline svg, scherp op elk formaat)
    const previewEl = document.getElementById(`spotify-preview-${orderId}-${idx}`);
    previewEl.innerHTML = svgText;

    // Direct downloaden en opslaan
    downloadTextAsFile(svgText, `spotify-code-order-${orderId}-${idx + 1}.svg`, 'image/svg+xml');
  } catch (e) {
    alert('Kon Spotify code niet genereren: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
};

window.generateQrCode = async function (orderId, idx, btn) {
  const link = window._currentSpotifyLinks[idx];
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Bezig...';
  try {
    const res = await fetch(`/api/qr-code-svg?data=${encodeURIComponent(link)}`);
    if (!res.ok) throw new Error('Server gaf een fout terug');
    const svgText = await res.text();

    const previewEl = document.getElementById(`qr-preview-${orderId}-${idx}`);
    previewEl.innerHTML = svgText;

    downloadTextAsFile(svgText, `qr-code-order-${orderId}-${idx + 1}.svg`, 'image/svg+xml');
  } catch (e) {
    alert('Kon QR code niet genereren: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
};

window.setStatus = async function (orderId, status) {
  await fetch(`/api/orders/${orderId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  modal.classList.add('hidden');
  loadOrders();
};

document.getElementById('modalClose').addEventListener('click', () => modal.classList.add('hidden'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

document.addEventListener('keydown', (e) => {
  if (modal.classList.contains('hidden')) return;

  if (e.key === 'Escape') {
    modal.classList.add('hidden');
    return;
  }

  // Pijltjestoetsen: navigeer naar de vorige/volgende order in de huidige lijst.
  // Niet ingrijpen als de gebruiker aan het typen is in een invoerveld binnen de popup.
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    e.preventDefault();
    openAdjacentOrder(1);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    e.preventDefault();
    openAdjacentOrder(-1);
  }
});

document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = 'Synchroniseren...';
  try {
    await fetch('/api/sync', { method: 'POST' });
    await loadOrders();
    await checkLowStock();
  } catch (e) {
    alert('Synchronisatie mislukt: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Nu synchroniseren';
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (e) {
    // ook bij een fout gewoon doorsturen naar het inlogscherm
  }
  window.location.href = '/login';
});

printFilesBtn.addEventListener('click', async () => {
  if (selectedIds.size === 0) {
    alert('Selecteer eerst één of meer orders om drukwerkbestanden voor te maken.');
    return;
  }
  const original = printFilesBtn.innerHTML;
  printFilesBtn.disabled = true;
  printFilesBtn.textContent = 'Bestanden voorbereiden...';
  try {
    const ids = Array.from(selectedIds).join(',');
    const res = await fetch(`/api/print-files/pdf-zip?ids=${encodeURIComponent(ids)}`);
    const contentType = res.headers.get('content-type') || '';

    if (!res.ok || contentType.includes('application/json')) {
      const data = await res.json();
      throw new Error(data.error || 'Onbekende fout bij ophalen drukwerkbestanden');
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tegeltjes.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('Kon drukwerkbestanden niet downloaden: ' + e.message);
  } finally {
    printFilesBtn.disabled = selectedIds.size === 0;
    printFilesBtn.innerHTML = original;
  }
});

const ordersView = document.getElementById('ordersView');
const inventoryView = document.getElementById('inventoryView');
const searchBarWrap = document.getElementById('searchBarWrap');

// Hamburger-menu (alleen relevant op mobiel — op desktop blijft alles gewoon
// altijd zichtbaar, zie de @media-regel in style.css). Klapt de statusfilters
// + knoppenrij (drukwerkbestanden/sync/uitloggen) samen open/dicht.
const mobileMenuToggle = document.getElementById('mobileMenuToggle');
const topbarRight = document.getElementById('topbarRight');
const filtersEl = document.querySelector('.filters');
if (mobileMenuToggle) {
  mobileMenuToggle.addEventListener('click', () => {
    topbarRight.classList.toggle('mobile-open');
    filtersEl.classList.toggle('mobile-open');
  });
}

const selectionBarWrap = document.getElementById('selectionBarWrap');

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (btn.dataset.status === '__voorraad__') {
      ordersView.classList.add('hidden');
      searchBarWrap.classList.add('hidden');
      selectionBarWrap.classList.add('hidden');
      inventoryView.classList.remove('hidden');
      // Order-gerelateerde knoppen/tekst horen niet thuis op een pure voorraadpagina
      printFilesBtn.classList.add('hidden');
      syncBtn.classList.add('hidden');
      lastSyncEl.classList.add('hidden');
      loadInventory();
      return;
    }

    ordersView.classList.remove('hidden');
    searchBarWrap.classList.remove('hidden');
    selectionBarWrap.classList.remove('hidden');
    inventoryView.classList.add('hidden');
    printFilesBtn.classList.remove('hidden');
    syncBtn.classList.remove('hidden');
    lastSyncEl.classList.remove('hidden');

    currentFilter = btn.dataset.status;
    // Selectie leegmaken bij het wisselen van tabblad, anders kan er iets
    // geselecteerd blijven staan dat je niet meer ziet op het nieuwe tabblad.
    selectedIds.clear();
    loadOrders();
  });
});

// --- Voorraad ---
const LOW_STOCK_THRESHOLD = 50;

async function loadInventory() {
  const container = document.getElementById('inventoryItems');
  try {
    const res = await fetch('/api/inventory');
    const items = await res.json();
    container.innerHTML = items.map(item => `
      <div class="inventory-row">
        <label for="inv-${item.id}">${escapeHtml(item.name)}${item.stock < (item.low_stock_threshold || LOW_STOCK_THRESHOLD) ? '<span class="inventory-low-label">Bijna op</span>' : ''}</label>
        <input type="number" id="inv-${item.id}" data-id="${item.id}" value="${item.stock}" min="0" class="${item.stock < (item.low_stock_threshold || LOW_STOCK_THRESHOLD) ? 'low-stock' : ''}">
        <button type="button" class="inventory-delete-btn" onclick="deleteInventoryItem(${item.id}, '${jsEscape(item.name)}')" title="Artikel verwijderen"><i class="fa-solid fa-trash"></i></button>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = '<p>Kon voorraad niet laden.</p>';
  }
  checkLowStock();
}

window.deleteInventoryItem = async function (id, name) {
  if (!confirm(`Artikel "${name}" verwijderen uit de voorraad?`)) return;
  try {
    await fetch(`/api/inventory/${id}`, { method: 'DELETE' });
    await loadInventory();
  } catch (e) {
    alert('Kon artikel niet verwijderen: ' + e.message);
  }
};

document.getElementById('addInventoryBtn').addEventListener('click', async () => {
  const nameInput = document.getElementById('newInventoryName');
  const stockInput = document.getElementById('newInventoryStock');
  const name = nameInput.value.trim();
  if (!name) {
    alert('Vul een naam in voor het nieuwe artikel.');
    return;
  }
  const btn = document.getElementById('addInventoryBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Bezig...';
  try {
    const res = await fetch('/api/inventory/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stock: Number(stockInput.value) || 0 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Onbekende fout');
    nameInput.value = '';
    stockInput.value = '0';
    await loadInventory();
  } catch (e) {
    alert('Kon artikel niet toevoegen: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

document.getElementById('saveInventoryBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveInventoryBtn');
  const inputs = document.querySelectorAll('#inventoryItems input[data-id]');
  const items = Array.from(inputs).map(input => ({ id: Number(input.dataset.id), stock: Number(input.value) }));

  btn.disabled = true;
  btn.textContent = 'Bezig...';
  try {
    await fetch('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    });
    await loadInventory();
  } catch (e) {
    alert('Kon voorraad niet opslaan: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Opslaan';
  }
});

// Toont een waarschuwing in de zwarte balk bovenin als er artikelen bijna op zijn
async function checkLowStock() {
  const el = document.getElementById('stockWarning');
  try {
    const res = await fetch('/api/inventory');
    const items = await res.json();
    const low = items.filter(item => item.stock < (item.low_stock_threshold || LOW_STOCK_THRESHOLD));
    if (low.length === 0) {
      el.classList.add('hidden');
      return;
    }
    el.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> ' +
      low.map(item => `Voorraad van ${escapeHtml(item.name)} is bijna op (${item.stock} over)`).join(' • ');
    el.classList.remove('hidden');
  } catch (e) {
    el.classList.add('hidden');
  }
}

printSelectedBtn.addEventListener('click', () => printOrders(Array.from(selectedIds), printSelectedBtn, '<i class="fa-solid fa-print"></i> Print pakbonnen', true));

window.printSingleOrder = function (orderId) {
  printOrders([orderId], null, null, false);
};

bulkStatusSelect.addEventListener('change', () => {
  bulkStatusBtn.disabled = selectedIds.size === 0 || !bulkStatusSelect.value;
});

bulkStatusBtn.addEventListener('click', async () => {
  const status = bulkStatusSelect.value;
  if (!status || selectedIds.size === 0) return;

  const ids = Array.from(selectedIds);
  bulkStatusBtn.disabled = true;
  bulkStatusBtn.textContent = 'Bezig...';
  try {
    await fetch('/api/orders/bulk-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, status })
    });
    selectedIds.clear();
    bulkStatusSelect.value = '';
    await loadOrders();
  } catch (e) {
    alert('Kon status niet in bulk wijzigen: ' + e.message);
  } finally {
    bulkStatusBtn.disabled = true;
    bulkStatusBtn.innerHTML = 'Toepassen';
  }
});

async function printOrders(ids, btn, defaultLabel, autoAdvanceStatus = false) {
  if (!ids || ids.length === 0) return;
  const originalLabel = btn ? btn.innerHTML : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Bonnen voorbereiden...';
  }

  try {
    // Volledige orderdetails ophalen — uitsluitend voor de meegegeven order-ids, verder niets.
    // Elke response wordt gecontroleerd: een verlopen sessie (bv. na een
    // server-herstart met een nieuwe SESSION_SECRET) geeft een 401 terug —
    // zonder deze check zou dat stilzwijgend als een lege/kapotte order
    // behandeld worden, en print je pakbonnen zonder klantgegevens/foto's.
    const orders = await Promise.all(ids.map(async id => {
      const res = await fetch(`/api/orders/${id}`);
      if (res.status === 401) {
        throw new Error('Je bent niet (meer) ingelogd — waarschijnlijk is de sessie verlopen (bv. na een server-herstart). Herlaad de pagina, log opnieuw in, en probeer het dan nogmaals.');
      }
      if (!res.ok) {
        throw new Error(`Kon order ${id} niet ophalen (serverfout, status ${res.status}).`);
      }
      return res.json();
    }));

    // Oudste eerst printen, nieuwste als laatste — zo komt de nieuwste
    // bestelling ook echt als laatste (dus bovenop de stapel) uit de printer.
    orders.sort((a, b) => new Date(a.shopify_created_at || 0) - new Date(b.shopify_created_at || 0));

    const receiptsHtml = orders.map(buildReceiptHtml).join('\n');

    // Geen breedte/hoogte meegeven -> browser opent dit als nieuw tabblad
    // i.p.v. een apart (popup-)venster.
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <!DOCTYPE html>
      <html lang="nl">
      <head>
        <meta charset="UTF-8">
        <title>Pakbonnen</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.12.3/JsBarcode.all.min.js"><\/script>
        <style>
          @page {
            size: 80mm auto;
            margin: 1cm 0;
          }
          body { margin: 0; }
          table { border-collapse: collapse; width: 100%; }
          th, td { padding: 2px 0; }
          .order-barcode { display: block; margin: 8px auto 4px; }
        </style>
      </head>
      <body>
        ${receiptsHtml}
      </body>
      </html>
    `);
    printWindow.document.close();

    // Wachten tot eventuele foto's/JsBarcode geladen zijn voor we het printvenster openen
    printWindow.onload = () => {
      // Elk streepjescode-element vullen o.b.v. het ordernummer in het data-attribuut
      if (printWindow.JsBarcode) {
        printWindow.document.querySelectorAll('.order-barcode').forEach(el => {
          try {
            printWindow.JsBarcode(el, el.dataset.orderNumber, {
              format: 'CODE128',
              width: 1,
              height: 24,
              fontSize: 10,
              margin: 0,
              background: 'transparent'
            });
          } catch (e) {
            // Ongeldig/leeg ordernummer -> gewoon geen streepjescode voor deze order
          }
        });
      }
      setTimeout(() => printWindow.print(), 400);
    };

    // Bij bulk printen: orders die op "wacht op productie" stonden automatisch naar "verzonden" zetten
    if (autoAdvanceStatus) {
      const toAdvance = orders.filter(o => o.status === 'wacht op productie');
      if (toAdvance.length > 0) {
        await Promise.all(toAdvance.map(o => fetch(`/api/orders/${o.id}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'verzonden' })
        })));
        selectedIds.clear();
        await loadOrders();
      }
    }
  } catch (e) {
    alert('Kon pakbonnen niet voorbereiden: ' + e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalLabel || defaultLabel;
    }
  }
}

// Woordenlijst met veelvoorkomende Nederlandse termen in productnamen, om de
// producttitel/variant op de Duitse pakbon ook te vertalen. Dit is een simpele
// woord-voor-woord/frase-vervanging (geen echte vertaalservice) — langere,
// specifiekere zinnen staan bovenaan zodat die eerst matchen. Kom je een term
// tegen die niet vertaald wordt, laat het weten dan voeg ik 'm toe.
const PRODUCT_TRANSLATIONS_NL_DE = [
  // Specifieke productnamen/zinnen eerst — dit zijn de officiële Duitse
  // termen zoals ze ook echt op socialframe.de gebruikt worden, dus deze
  // gaan vóór de losse woord-voor-woord fallback-regels hieronder.
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

function buildReceiptHtml(order) {
  // Duitse klanten (herkend aan het land van het verzendadres) krijgen de
  // pakbon in het Duits — de rest (bv. Nederland/België) blijft Nederlands.
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
    const propsHtml = (li.properties || [])
      .filter(p => !/autopictura/i.test(p.name) && !/autopictura/i.test(p.value)) // alle autopictura-teksten weglaten van het bonnetje
      .map(p => `${escapeHtml(p.name)}: ${escapeHtml(p.value)}`)
      .join('<br>');

    const qty = Number(li.quantity || 0).toFixed(2).replace('.', ',');

    const displayTitle = translateProductText(li.title, isGerman);
    const displayVariant = translateProductText(li.variant_title, isGerman);

    // Cadeauverpakking wordt vaak vergeten bij het inpakken — laat deze regel
    // in de artikelenlijst zelf opvallen (dikker omrand, groter, vet), i.p.v.
    // 'm hetzelfde te laten ogen als een gewoon artikel. Herkenning op de
    // ORIGINELE (Nederlandse) titel, ongeacht of de pakbon zelf in het Duits
    // wordt weergegeven.
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

  // Op de pakbon: alle autopictura-previews tonen, maar van overige
  // (niet-autopictura) bestanden alleen de eerste/bovenste — anders wordt de
  // pakbon onnodig lang als er meerdere design-previews in de order zitten.
  const allPhotoLinks = order.photo_links || [];
  const autopicturaPhotos = allPhotoLinks.filter(l => /autopictura/i.test(l));
  const otherPhotos = allPhotoLinks.filter(l => !/autopictura/i.test(l));
  const photosForReceipt = [...autopicturaPhotos, ...(otherPhotos.length ? [otherPhotos[0]] : [])];

  const photoHtml = photosForReceipt.map(link => `
    <div style="text-align:center; margin-top:10px;">
      <img src="/api/photo-preview?url=${encodeURIComponent(link)}" alt="Foto product" style="width:45mm; max-height:45mm; object-fit:cover; border:1px solid black;" onerror="this.outerHTML='<div style=&quot;font-size:10px; color:#900; text-align:center;&quot;>${t.fotoNietGeladen}</div>'">
    </div>
  `).join('');

  // Adresregels los weergeven (net als het bestaande Socialframe-sjabloon): elk
  // onderdeel van het opgeslagen adres op zijn eigen regel.
  const addressLines = (order.shipping_address || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

  const logoFile = isGerman ? 'logo-de.svg' : 'logo.svg';

  return `
    <div style="page-break-after:always; font-family:arial; font-size:12px; margin:0 5mm 10mm 5mm;">
      <div style="text-align:center; margin-top:0; padding:6px 0; border-bottom:1px dotted black; border-top:1px dotted black;">
        <img src="${window.location.origin}/${logoFile}" alt="Socialframe" style="height:44px; width:auto;">
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

      ${order.order_number ? `
      <svg class="order-barcode" data-order-number="${escapeHtml(String(order.order_number))}"></svg>
      ` : ''}

      <div style="margin-top:10px; text-align:center;">${t.contact}</div>
    </div>
  `;
}

// Het pakbon-account krijgt geen toegang tot drukwerkbestanden downloaden —
// die knop verbergen we dan, en zetten eerst de rol vast voordat de orders
// geladen worden (zodat de popup nooit even kort de verkeerde knop toont).
async function initSessionAndLoad() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    if (data.role) {
      currentUserRole = data.role;
      if (data.role !== 'admin') printFilesBtn.style.display = 'none';
    }
  } catch (e) {
    // val terug op currentUserRole = 'admin' (default); server blokkeert sowieso
    // niet-toegestane acties, dus dit is puur een UI-vangnet
  }
  loadOrders();
  checkLowStock();
}
initSessionAndLoad();
// Ververs de lijst elke 60 seconden in de browser (de server synchroniseert zelf elke 5 min met Shopify)
setInterval(loadOrders, 60000);
// Ook de voorraadwaarschuwing periodiek verversen, voor het geval de achtergrond-sync
// (elke 5 min) intussen voorraad heeft afgeboekt
setInterval(checkLowStock, 60000);
