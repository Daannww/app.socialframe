// Zet een aantal testorders in de database, zodat je het dashboard kan testen
// zonder dat er al echte Shopify orders binnen hoeven te komen.
//
// Gebruik:  npm run seed

const { upsertOrder, updateStatus, listOrders } = require('./db');

const testOrders = [
  {
    shopify_order_id: 'TEST-1001',
    order_number: '1001',
    customer_name: 'Sanne de Vries',
    customer_email: 'sanne.devries@example.com',
    customer_phone: '+31 6 12345678',
    shipping_address: 'Sanne de Vries, Kerkstraat 12, 2801 JK Gouda, Nederland',
    line_items_json: JSON.stringify([
      {
        title: 'Gepersonaliseerde Spotify Code sleutelhanger',
        variant_title: 'Zwart',
        quantity: 1,
        price: '19.95',
        sku: 'SPOT-KEY-BLK',
        properties: [
          { name: 'Spotify link', value: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' }
        ]
      }
    ]),
    spotify_links_json: JSON.stringify(['https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC']),
    photo_links_json: JSON.stringify([]),
    raw_json: '{}',
    shopify_created_at: daysAgo(0, 9, 15)
  },
  {
    shopify_order_id: 'TEST-1002',
    order_number: '1002',
    customer_name: 'Mo el Amrani',
    customer_email: 'mo.elamrani@example.com',
    customer_phone: '+31 6 87654321',
    shipping_address: 'Mo el Amrani, Prinsengracht 45, 1016 GT Amsterdam, Nederland',
    line_items_json: JSON.stringify([
      {
        title: 'Fotolijst met gepersonaliseerde foto',
        variant_title: 'A4',
        quantity: 2,
        price: '34.50',
        sku: 'FOTO-LIJST-A4',
        properties: [
          { name: 'Geuploade foto', value: 'https://picsum.photos/seed/order1002/400/400.jpg' }
        ]
      }
    ]),
    spotify_links_json: JSON.stringify([]),
    photo_links_json: JSON.stringify(['https://picsum.photos/seed/order1002/400/400.jpg']),
    raw_json: '{}',
    shopify_created_at: daysAgo(0, 8, 40)
  },
  {
    shopify_order_id: 'TEST-1003',
    order_number: '1003',
    customer_name: 'Emma Jansen',
    customer_email: 'emma.jansen@example.com',
    customer_phone: '+31 6 11223344',
    shipping_address: 'Emma Jansen, Marktplein 3, 3011 AA Rotterdam, Nederland',
    line_items_json: JSON.stringify([
      {
        title: 'Spotify Code plaquette hout',
        variant_title: 'Eiken',
        quantity: 1,
        price: '29.95',
        sku: 'SPOT-PLAQ-OAK',
        properties: [
          { name: 'Spotify link', value: 'https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M' }
        ]
      },
      {
        title: 'Fotolijst met gepersonaliseerde foto',
        variant_title: 'A5',
        quantity: 1,
        price: '24.50',
        sku: 'FOTO-LIJST-A5',
        properties: [
          { name: 'Geuploade foto', value: 'https://picsum.photos/seed/order1003/400/400.jpg' }
        ]
      }
    ]),
    spotify_links_json: JSON.stringify(['https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M']),
    photo_links_json: JSON.stringify(['https://picsum.photos/seed/order1003/400/400.jpg']),
    raw_json: '{}',
    shopify_created_at: daysAgo(1, 10, 5)
  },
  {
    shopify_order_id: 'TEST-1004',
    order_number: '1004',
    customer_name: 'Lars Bakker',
    customer_email: 'lars.bakker@example.com',
    customer_phone: '+31 6 55667788',
    shipping_address: 'Lars Bakker, Dorpsstraat 88, 3511 KM Utrecht, Nederland',
    line_items_json: JSON.stringify([
      {
        title: 'Standaard cadeaubon',
        variant_title: '€25',
        quantity: 1,
        price: '25.00',
        sku: 'GIFT-25',
        properties: []
      }
    ]),
    spotify_links_json: JSON.stringify([]),
    photo_links_json: JSON.stringify([]),
    raw_json: '{}',
    shopify_created_at: daysAgo(1, 14, 20)
  },
  {
    shopify_order_id: 'TEST-1005',
    order_number: '1005',
    customer_name: 'Fenna Visser',
    customer_email: 'fenna.visser@example.com',
    customer_phone: '+31 6 99887766',
    shipping_address: 'Fenna Visser, Julianastraat 7, 2806 CE Gouda, Nederland',
    line_items_json: JSON.stringify([
      {
        title: 'Gepersonaliseerde Spotify Code sleutelhanger',
        variant_title: 'Rosé goud',
        quantity: 3,
        price: '19.95',
        sku: 'SPOT-KEY-RG',
        properties: [
          { name: 'Spotify link', value: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b' }
        ]
      }
    ]),
    spotify_links_json: JSON.stringify(['https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b']),
    photo_links_json: JSON.stringify([]),
    raw_json: '{}',
    shopify_created_at: daysAgo(2, 9, 0)
  },
  {
    shopify_order_id: 'TEST-1006',
    order_number: '1006',
    customer_name: 'Tim Willems',
    customer_email: 'tim.willems@example.com',
    customer_phone: '+31 6 44556677',
    shipping_address: 'Tim Willems, Molenweg 22, 6511 PL Nijmegen, Nederland',
    line_items_json: JSON.stringify([
      {
        title: 'Fotolijst met gepersonaliseerde foto',
        variant_title: 'A3',
        quantity: 1,
        price: '44.50',
        sku: 'FOTO-LIJST-A3',
        properties: [
          { name: 'Geuploade foto', value: 'https://picsum.photos/seed/order1006/400/400.jpg' }
        ]
      }
    ]),
    spotify_links_json: JSON.stringify([]),
    photo_links_json: JSON.stringify(['https://picsum.photos/seed/order1006/400/400.jpg']),
    raw_json: '{}',
    shopify_created_at: daysAgo(3, 11, 30)
  },
  {
    shopify_order_id: 'TEST-1007',
    order_number: '1007',
    customer_name: 'Noa Peters',
    customer_email: 'noa.peters@example.com',
    customer_phone: '+31 6 22334455',
    shipping_address: 'Noa Peters, Stationsweg 5, 2801 BJ Gouda, Nederland',
    line_items_json: JSON.stringify([
      {
        title: 'Gepersonaliseerd fotocanvas',
        variant_title: '30x30cm',
        quantity: 1,
        price: '39.95',
        sku: 'CANVAS-30',
        properties: [
          { name: '_autopictura_design_link', value: 'https://app.autopictura.com/api/images/design-link/019ff5b5-53a6-722b-85b9-3b81dc246468' },
          { name: '_svg 0', value: 'https://cdn.shopify.com/s/files/1/0543/1132/1781/uploads/82e70ff6a03bcb058b2ddc336eb13c28_favoriete-foto.svg' }
        ]
      }
    ]),
    spotify_links_json: JSON.stringify([]),
    photo_links_json: JSON.stringify([
      'https://app.autopictura.com/api/images/design-link/019ff5b5-53a6-722b-85b9-3b81dc246468',
      'https://cdn.shopify.com/s/files/1/0543/1132/1781/uploads/82e70ff6a03bcb058b2ddc336eb13c28_favoriete-foto.svg'
    ]),
    raw_json: '{}',
    shopify_created_at: daysAgo(0, 13, 10)
  }
];

function daysAgo(days, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// Zet de orders in de database (komen binnen met status "wacht op drukwerkbestand")
testOrders.forEach(o => upsertOrder(o));

// Zet een paar orders alvast op een andere status, zodat je de filters/statussen ook kan testen
const inserted = listOrders();
const byNumber = Object.fromEntries(inserted.map(o => [o.order_number, o]));

if (byNumber['1003']) updateStatus(byNumber['1003'].id, 'wacht op productie');
if (byNumber['1004']) updateStatus(byNumber['1004'].id, 'onjuiste gegevens');
if (byNumber['1006']) updateStatus(byNumber['1006'].id, 'verzonden');

console.log(`${testOrders.length} testorders toegevoegd aan de database.`);
console.log('Statussen: 1003 -> wacht op productie, 1004 -> onjuiste gegevens, 1006 -> verzonden, de rest -> wacht op drukwerkbestand.');
console.log('Order 1007 bevat de autopictura testfoto-link, om de foto-preview/download te testen.');
console.log('Start de server met "npm start" en open het dashboard om te testen.');
