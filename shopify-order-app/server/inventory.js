// Standaard voorraadartikelen. Volgorde hier bepaalt ook de volgorde in het
// "Voorraad"-tabblad.
const DEFAULT_INVENTORY_ITEMS = [
  'Tegeltjes 10x10',
  'Tegeltjes 13x13',
  'Metalen houder',
  'Lijst 10x10',
  'Lijst 13x13cm'
];

// Matching-regels: voor elk voorraadartikel een functie die bepaalt of de
// tekst van een besteld product (titel + variant + eigenschappen) daarbij
// hoort. Simpele keyword-matching — pas dit aan als de herkenning een keer
// niet klopt met hoe jullie producten heten in Shopify.
const INVENTORY_RULES = [
  { name: 'Tegeltjes 10x10', test: (text) => /tegel/i.test(text) && /10\s*x\s*10/i.test(text) },
  { name: 'Tegeltjes 13x13', test: (text) => /tegel/i.test(text) && /13\s*x\s*13/i.test(text) },
  { name: 'Metalen houder', test: (text) => /metalen[\s-]?houder/i.test(text) },
  { name: 'Lijst 10x10', test: (text) => /lijst/i.test(text) && /10\s*x\s*10/i.test(text) },
  { name: 'Lijst 13x13cm', test: (text) => /lijst/i.test(text) && /13\s*x\s*13/i.test(text) }
];

// Bepaalt, voor een order met line_items, hoeveel van elk voorraadartikel
// er verbruikt is. Geeft een object terug zoals { 'Tegeltjes 10x10': 2 }.
// `items` is de actuele lijst voorraadartikelen (uit de database, dus ook
// eventueel zelf toegevoegde artikelen). Voor de standaardartikelen gebruikt
// dit de slimme regels hierboven; voor zelf toegevoegde artikelen wordt er
// simpelweg gekeken of de artikelnaam letterlijk in de producttekst voorkomt.
function computeDeductionsForOrder(order, items) {
  const deductions = {};
  const itemNames = items ? items.map(i => i.name) : DEFAULT_INVENTORY_ITEMS;

  (order.line_items || []).forEach(li => {
    const text = [
      li.title,
      li.variant_title,
      ...(li.properties || []).map(p => `${p.name} ${p.value}`)
    ].join(' ');

    itemNames.forEach(name => {
      const rule = INVENTORY_RULES.find(r => r.name === name);
      const matches = rule ? rule.test(text) : text.toLowerCase().includes(name.toLowerCase());
      if (matches) {
        deductions[name] = (deductions[name] || 0) + (li.quantity || 1);
      }
    });
  });

  return deductions;
}

module.exports = { DEFAULT_INVENTORY_ITEMS, INVENTORY_RULES, computeDeductionsForOrder };
