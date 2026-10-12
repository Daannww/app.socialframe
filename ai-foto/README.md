# Socialframe AI-foto service

Klant uploadt een foto op de productpagina, kiest een ontwerp, krijgt het AI-resultaat te zien en bestelt.
Wij krijgen een drukklaar bestand (tegel 1600x1600 px = 300 dpi op 13x13 cm; poster 2800x2000 px, 100 dpi op 70x50 cm).

## Starten
1. `npm install`
2. Variabelen (zie `.env.example`) zetten: `FAL_KEY`, `ADMIN_PASSWORD`, `PUBLIC_BASE_URL`, `ALLOWED_ORIGINS`, `DATA_DIR`.
3. `npm start`  → beheer op `/admin` (gebruikersnaam mag alles zijn, wachtwoord = `ADMIN_PASSWORD`).
4. Railway: nieuwe service uit deze map, **volume mounten op `/data`** en `DATA_DIR=/data` zetten (database, originelen en resultaten staan daar).
5. Plak `widget/hw-ai-foto.liquid` als Custom Liquid op de productpagina en vul het service-adres in.

## Ordergegevens
Bij de bestelling komen drie line item properties mee:
- `AI afbeelding` (preview-link, zichtbaar voor klant)
- `AI ontwerp` (naam van het ontwerp)
- `_AI drukbestand` (link naar het drukklare JPG, verborgen voor klant, begint met `_`)
Het ordersysteem moet `_AI drukbestand` downloaden en als printbestand gebruiken.

## Test
`npm test` draait een volledige test met een nep-fal (geen kosten).
