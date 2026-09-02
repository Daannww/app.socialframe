# Shopify Order Dashboard

Een dashboard dat automatisch elke 5 minuten nieuwe Shopify orders ophaalt,
Spotify-links in de bestelling herkent en daar een Spotify Code / QR code
van kan maken, en waarmee je de status van orders kan wijzigen.

## Functies

- **Automatische sync**: elke 5 minuten worden nieuwe **openstaande** Shopify
  orders opgehaald (afgehandelde/gearchiveerde en geannuleerde orders worden
  niet opgehaald).
- **Nieuwe orders** krijgen automatisch status `wacht op drukwerkbestand` —
  behalve als de order **uitsluitend** uit producten bestaat met "Tegeltje met
  tekst" in de titel én er ook daadwerkelijk **geen enkele foto/ontwerp-link**
  gevonden is; die gaan direct naar `wacht op productie`. Zit er een
  foto/ontwerp-link bij (ongeacht wat er in de titel staat — dus ook bij een
  titel als "Tegeltje met tekst en foto" of "... personaliseerbaar met eigen
  foto"), of zit er ook maar 1 ander product in de order, dan geldt gewoon de
  normale standaardstatus. Deze regel staat in `determineInitialStatus` in
  `server/shopify.js`.
- **Automatisch opruimen**: elke nacht om 03:00 (en 1x bij het opstarten van de
  server) worden orders ouder dan 30 dagen uit de lokale database verwijderd,
  zodat de server niet onbeperkt blijft groeien. Instelbaar via
  `ORDER_RETENTION_DAYS` in `.env`.
- **Drukwerkbestanden-export op verzoek**: naast de bulk-downloadknop in het
  dashboard, staat er ook een los endpoint klaar
  (`/api/print-files/run-scheduled-export`, admin-only) dat alle
  drukwerkbestanden verzamelt van orders die op status
  `wacht op drukwerkbestand` staan en een autopictura-link hebben — precies
  zoals de handmatige `⬇ Drukwerkbestanden (PDF)`-knop, maar dan voor alle
  openstaande orders in die status i.p.v. een selectie. Het resultaat wordt
  niet naar de browser gedownload (dat kan niet zomaar automatisch), maar
  opgeslagen als zip-bestand in de map `exports/` in de projectmap. **Er is
  bewust geen automatische planning meer aan gekoppeld** (voorheen elke dag om
  12:00) — dit wordt nu alleen handmatig getriggerd. Wil je dit gebruiken: open
  het dashboard in de browser (zodat je ingelogd bent), open de Developer
  Tools (Console-tabblad), en typ:
  `fetch('/api/print-files/run-scheduled-export', {method:'POST'})`.
- **Orderoverzicht** met filter op status. Vóór de klantnaam staat een subtiel
  vlaggetje van het land van het verzendadres (via de gratis
  [flag-icons](https://github.com/lipis/flag-icons)-library) — bij een
  onbekend/leeg land wordt er gewoon geen vlaggetje getoond.
- **Popup met orderdetails**: klantgegevens + alle cart/line item details.
- Als er een **Spotify link** in de order zit (bijv. in een custom veld / notitie
  bij het product), verschijnen er twee knoppen:
  - **Create Spotify Code (SVG)** – downloadt direct een scanbare Spotify-code als SVG.
  - **Create QR Code (SVG)** – downloadt direct een QR-code van de link als SVG.
- In de popup kan je de status wijzigen naar `wacht op productie`.
- **Notitie per order**: in de popup staat een vrij notitieveld ("bijzonderheden") boven de sectie "Link voor code" — vul je die in, dan verschijnt de notitie ook automatisch op de pakbon, **direct onder het adres en boven de artikellijst** (zodat 'ie meteen opvalt), in een duidelijk zichtbaar vak.
- **Streepjescode op de pakbon**: onderaan elke pakbon, direct boven de contactregel, staat een subtiele streepjescode (CODE128) van het ordernummer — gegenereerd via de gratis [JsBarcode](https://lindell.me/JsBarcode/)-library (CDN, dus vereist internettoegang in de browser op het moment van printen). Lukt het genereren een keer niet (bv. geen internet), dan blijft dat vakje gewoon leeg — de rest van de pakbon print dan nog gewoon door.
- **Twee soorten accounts**: een **admin**-account (volledige toegang) en een
  **pakbon**-account (voor bv. de computer waarop alleen pakbonnen worden
  geprint) — die laatste ziet de knop **⬇ Drukwerkbestanden (PDF)** niet en
  kan er ook niet via een directe link bij; dat is zowel in het dashboard als
  aan de serverkant geblokkeerd. Beide accounts kunnen wel gewoon orders
  bekijken, pakbonnen printen en statussen wijzigen. Instelbaar via
  `PAKBON_USER` / `PAKBON_PASS` in `.env`.
- **Voorraadbeheer**: apart tabblad "Voorraad" (achteraan de statustabbladen)
  waar je zelf het aantal op voorraad invult, standaard voor: Tegeltjes 10x10,
  Tegeltjes 13x13, Metalen houder, Lijst 10x10, Lijst 13x13cm. Onderaan kan je
  zelf **nieuwe artikelen toevoegen** (naam + startaantal) en bestaande
  artikelen **verwijderen** (prullenbak-icoontje per rij). Bij elke **nieuwe**
  bestelling wordt automatisch herkend welk(e) artikel(en) daarin zitten (op
  basis van de producttekst) en wordt het bestelde aantal van de voorraad
  afgetrokken. Zakt een artikel onder de 50 stuks (standaarddrempel,
  instelbaar per artikel), dan verschijnt er een waarschuwing in de zwarte
  balk bovenin ("Voorraad van X is bijna op").
  De 5 standaardartikelen gebruiken slimme matching-regels (in
  `server/inventory.js`, bv. "tegel" + "10x10" samen) — zelf toegevoegde
  artikelen worden herkend zodra de naam die je intypt letterlijk (ongeacht
  hoofdletters) in de producttekst voorkomt, dus kies een naam die overeenkomt
  met hoe het product in Shopify heet.
- De hele applicatie is beveiligd met een eigen, gestyled **inlogscherm**
  (met logo) — geen kaal browser-inlogvenstertje meer. Rechtsboven op het
  dashboard staat een **🚪 Uitloggen**-knop.
- **Laad meer resultaten**: er worden standaard 50 orders getoond; staat er meer,
  dan verschijnt onderaan de knop **↻ Laad meer resultaten (X)** om handmatig
  de volgende 50 te laden (blijft klikbaar totdat alles geladen is).
- **Bovenin** kan je makkelijk filteren/selecteren op status (alle / wacht op
  drukwerkbestand / wacht op productie / verzonden / geannuleerd / onjuiste gegevens).
- **Selecteren + bulk printen**: vink orders aan (of "alles op deze pagina") en klik op
  **Print pakbonnen** om voor alle geselecteerde orders (tot 50 tegelijk) pakbonnetjes
  te printen in een smal bonformaat (80mm, zoals een restaurantbonnetje/thermische printer).
  Er wordt uitsluitend geprint wat je hebt aangevinkt. Orders die op dat moment
  op status `wacht op productie` staan, worden na het bulk printen automatisch
  naar `verzonden` gezet (orders met een andere status blijven ongewijzigd).
  Dit geldt niet voor het losse **Print pakbon voor deze order**-knopje in de
  popup — dat wijzigt de status niet automatisch.
- **Zoekbalk bovenin**: zoek snel op klantnaam, verzendadres, e-mailadres of het
  Shopify-ordernummer — filtert direct de tabel, ook binnen een geselecteerde status.
- **Individueel selecteren + los printen**: elke order heeft een eigen checkbox voor
  bulk-acties, én in de popup van elke order staat een eigen knop
  **🖨️ Print pakbon voor deze order** om precies die ene bestelling te printen.
- **Foto's in de popup**: staat er een geüploade foto bij een order, dan zie je
  in de popup een preview. Bij een gewone foto-link staat er een knop
  **⬇ Download het bestand** (het originele bestand). Bij een **autopictura-link**
  staat er in plaats daarvan **⬇ Download drukwerkbestand (PDF, 10×10cm of
  13×13cm)** — deze downloadt meteen een print-klare PDF op het juiste
  fysieke formaat (300dpi), net als de bulk-knop bovenin. Foto's worden altijd
  via de server zelf opgehaald (`/api/photo-preview`) i.p.v. rechtstreeks door
  de browser bij autopictura/Shopify — dit voorkomt dat foto's op sommige
  computers/netwerken niet laden, en zorgt dat ook de pakbon-print betrouwbaar
  de besteldfoto toont.
- **Bulk statuswijziging**: selecteer meerdere (of alle) orders, kies rechtsboven
  een status in het dropdown-menu en klik op **Toepassen** om ze allemaal in
  één keer naar die status te zetten.
- **🔁 Orders herberekenen**: de sync is incrementeel — na de allereerste keer
  worden bestaande orders niet opnieuw bij Shopify opgehaald, alleen nieuwe.
  Verbeter je de mapping/detectielogica (in `server/shopify.js`, bijvoorbeeld
  het adres of de Spotify/foto-herkenning), dan zou die verbetering normaal
  alleen voor nieuwe orders gelden. Deze knop herberekent adres, klantgegevens,
  items en Spotify-/foto-links voor **alle bestaande orders** op basis van de
  al opgeslagen Shopify-data — zonder opnieuw bij Shopify te hoeven ophalen.
  De status van elke order blijft hierbij ongewijzigd.
- **Spotify Code & QR-code als SVG**: beide knoppen genereren een SVG-bestand
  (witte achtergrond, zwarte streepjes) en downloaden dat direct naar de
  computer van de gebruiker, zonder tussenstap.
- **Kopieerbare tekst**: klik op een tekst in de cart details of klantgegevens
  (titel, aantal, prijs, SKU, eigenschappen, naam, adres, etc.) om die direct
  naar het klembord te kopiëren — je ziet kort "✓ Gekopieerd" ter bevestiging.
- **E-mail naar klant**: in de popup staat onder de klantgegevens een knop
  **✉ Stuur klant e-mail** — deze opent je eigen mailprogramma met het
  e-mailadres van de klant en een kant-en-klare (aanpasbare) tekst, handig
  als bijvoorbeeld het huisnummer ontbreekt.
- **Popup sluit automatisch** na een statuswijziging, en kan ook gesloten
  worden met de **Esc-toets**. In de popup staat nu nog maar één statusknop:
  **Wacht op productie**.
- **Pakbon**: elke tekst (veldnaam óf waarde) die "autopictura" bevat, wordt niet
  afgedrukt op het bonnetje (de bijbehorende fotopreview blijft wel gewoon staan);
  Spotify-links en overige links blijven wél zichtbaar op het bonnetje. De
  status staat niet meer op de pakbon. Bovenaan staat gecentreerd het
  **Socialframe-logo** (`public/logo.svg`), daaronder het ordernummer, en de
  tekst **PAKBON**. Zitten er meerdere niet-autopictura foto's/bestanden in
  een order (bv. meerdere design-previews), dan wordt op de pakbon alleen de
  eerste/bovenste getoond — alle autopictura-previews blijven wél allemaal
  zichtbaar.
- **Duitse pakbon**: is het verzendadres van een order Duitsland (herkend aan
  de landcode `DE` uit Shopify), dan wordt de pakbon automatisch in het Duits
  opgebouwd — "LIEFERSCHEIN" i.p.v. "PAKBON", "Menge" i.p.v. "Aantal", de
  contactregel onderaan in het Duits, etc. Andere landen (bv. Nederland,
  België) blijven gewoon de Nederlandse pakbon krijgen. De vaste teksten staan
  in `buildReceiptHtml` in `public/app.js` (het object `t`) — voeg daar zelf
  een taal aan toe als er vaker in een andere taal geleverd wordt. **De
  producttitel/variant zelf** (die rechtstreeks uit Shopify komt, dus in het
  Nederlands) wordt bij een Duitse order ook vertaald, via een woordenlijst
  (`PRODUCT_TRANSLATIONS_NL_DE`, ook in `public/app.js`) — dit is
  frase-/woord-vervanging, geen echte vertaalservice. De termen zijn
  overgenomen van de officiële Duitse website (socialframe.de), dus die
  komen overeen met hoe klanten de producten daar al kennen. Kom je een
  producttitel tegen die niet (goed) vertaald wordt, stuur die door dan
  voeg ik 'm toe aan de lijst.
- **Logo**: het Socialframe-logo staat linksboven op het dashboard (naast
  "Order Dashboard") en bovenaan elk pakbonnetje. Wil je een ander logo
  gebruiken, vervang dan gewoon `public/logo.svg` door je eigen SVG-bestand
  met dezelfde naam. Op **Duitse** pakbonnen (verzendadres met landcode `DE`)
  wordt automatisch `public/logo-de.svg` gebruikt in plaats van het gewone
  logo — dat is het officiële Socialframe.de-logo.
- **Favicon & app-icoon**: het "sf"-beeldmerk wordt gebruikt als favicon
  (browsertabblad) en als icoon wanneer iemand het dashboard op een
  iPhone/Android-toestel "toevoegt aan beginscherm" — inclusief eigen
  appnaam ("Socialframe") via `public/site.webmanifest`. Alle formaten
  (`favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`,
  `apple-touch-icon.png`, `android-chrome-192x192.png`,
  `android-chrome-512x512.png`) staan al klaar in `public/` — wil je dit ooit
  vervangen door een ander logo, genereer dan nieuwe bestanden met exact
  diezelfde namen en formaten.
- **Drukwerkbestanden in 1x downloaden**: vink de gewenste orders aan in de tabel
  en klik dan bovenin op **⬇ Drukwerkbestanden (PDF)** — deze knop werkt alleen
  op je **huidige selectie** (staat uitgeschakeld zolang er niets is aangevinkt).
  Alles komt gebundeld in één zip-bestand, met deze mapstructuur (geldt ook
  voor de handmatige export via `/api/print-files/run-scheduled-export`,
  zie hierboven):
  ```
  {datum van vandaag}/
  ├── tegels/
  │   ├── 1007.pdf
  │   └── groot/
  │       └── 1008 groot.pdf
  └── muziekframe/
      ├── 1055 muziekframe.pdf
      ├── klein/
      │   └── 1056 klein.pdf
      └── Dik/
          └── 1057 dik.pdf
  ```
  Van elke geselecteerde order wordt voor **elke** autopictura-link een aparte
  foto omgezet naar een print-klaar `.pdf`-bestand op het exacte fysieke
  drukformaat (10×10cm of 13×13cm, 300dpi). Elk bestand heet naar het
  ordernummer (bv. `1007.pdf`); staan er meerdere autopictura-links in één
  order, dan krijgt elk bestand een nummer erachter (bv. `1007 1.pdf`,
  `1007 2.pdf`). Verder krijgt de naam `groot` achter zich (en komt in de
  submap `groot/` terecht) als in de bestelling "13x13" voorkomt. Wordt er
  geen 13x13 gevonden, dan wordt aangenomen dat het een standaard (10x10)
  formaat is. Elke order waarvoor minstens 1 drukwerkbestand lukt, wordt
  automatisch naar status `wacht op productie` gezet.
- **"Gepersonaliseerde foto tegel"**: dit product heeft geen autopictura-
  ontwerplink, maar gewoon een kale foto-upload (eigenschap "Kies jouw
  foto"). Zo'n foto wordt automatisch **op dezelfde manier** verwerkt als een
  autopictura-tegeltje: een print-klare PDF, foto tekengebied-vullend op het
  juiste formaat (10x10 of 13x13cm, 300dpi, o.b.v. dezelfde detectie/submap-
  logica hierboven), zowel bij de bulk-download, de geplande export, als de
  losse downloadknop in de popup. De herkenning (producttitel + veldnaam)
  staat in `isFotoTegelLineItem`/`extractFotoTegelPhotoUrls` in
  `server/shopify.js` — dit is gebaseerd op een inschatting van de exacte
  Shopify-tekst, dus geef door als de herkenning een keer niet klopt, dan
  stel ik de regex bij.
- **Posterly-orders**: orders die via de Posterly-app binnenkomen hebben een
  eigenschap `_print_file` met een link naar `cdn.posterlyapp.io` — die
  herkenning is dus gebaseerd op de eigenschap zelf, niet op de producttitel
  (werkt dus op elk product waar Posterly gebruikt wordt). Deze foto's bevatten
  nog canvas/een rand eromheen: het aangeleverde beeld staat voor **170mm**
  fysiek, en daaruit wordt precies het gevraagde formaat (100x100mm, of
  130x130mm bij "13x13") **uit het midden bijgeknipt** vóór het beeldvullend
  in het drukwerkbestand komt — zie `cropPosterlyCanvas` in
  `server/printfile.js`. De 170mm-aanname staat daar als losse constante
  (`POSTERLY_FULL_CANVAS_MM`) — mocht die ooit niet meer kloppen (bv. Posterly
  wijzigt hun canvasformaat), pas 'm daar dan aan. Werkt op dezelfde 3 plekken
  als hierboven (bulk-download, geplande export, losse downloadknop).
- **Formaat handmatig aanpassen (10x10 ↔ 13x13)**: wil een klant achteraf toch
  een ander formaat, open dan de order-popup — bij orders met een
  autopictura-tegeltje staat daar een sectie **"Formaat"** met knoppen om het
  formaat vast te zetten op 10x10cm of 13x13cm (of terug naar "automatisch",
  op basis van de besteltekst zoals Shopify die aanlevert). Deze handmatige
  keuze heeft **altijd voorrang** boven wat er in de bestelling zelf staat, en
  geldt zowel voor het drukwerkbestand (juiste formaat + juiste submap) als
  voor de pakbon (een duidelijk zichtbaar "FORMAAT AANGEPAST NAAR ...cm"-vak).
- **Muziek-/Valentijnframe-drukwerkbestanden**: orders met een product waarvan
  de titel "Muziek-frame" of "Valentijn-frame" bevat, krijgen automatisch een
  eigen drukwerkbestand (200x300mm PDF, met foto, Regel 1/2, hartje, tijdlijn,
  iconenrij en eventueel een QR-/Spotify-code) — dit gebeurt **samen** met de
  hierboven beschreven bulk-download, de handmatige export, én los per
  order via een knop in de popup ("Download muziekframe-bestand"). Bestelt een
  klant 2x hetzelfde frame, dan komen er 2 losse bestanden. Staat er "klein" of
  "dik" bij de titel/variant (net als "13x13" bij de tegeltjes), dan komt het
  bestand in een eigen submap terecht (`klein/1055 klein.pdf` resp.
  `Dik/1055 dik.pdf`) — het PDF-formaat zelf verandert niet, alleen de
  bestandsnaam/locatie in de zip. De precieze opmaak en de herkenning van de
  klant-ingevulde velden staan in `server/musicframe.js`
  — zie de code-comments daar voor hoe je dit kan aanpassen (bv. een nieuwe
  productvariant, of een net iets andere veldnaam in Shopify herkennen).
  De Montserrat-fontbestanden (`server/fonts/Montserrat-Regular.ttf` en
  `Montserrat-Bold.ttf`) zitten al bij het project — geen verdere actie nodig.
  **Emoji** (ook Apple-emoji, of van elk ander toestel) in Regel 1/2 worden
  automatisch herkend en als kleine plaatjes getekend via
  [Twemoji](https://github.com/twitter/twemoji) (gratis, open-source) — dit
  vereist dat de server bij het genereren van het bestand internettoegang
  heeft. Lukt het ophalen van een specifieke emoji een keer niet (bv. geen
  internet op dat moment), dan wordt die ene emoji overgeslagen en blijft de
  rest van de tekst gewoon staan — het bestand mislukt er niet door.
  **Hebreeuwse tekst** (bv. bestelling 655, waar dit een leeg bestand
  opleverde) wordt automatisch herkend en rechts-naar-links getekend (zowel
  de woordvolgorde als de letters binnen elk woord worden omgedraaid, want
  Hebreeuws leest andersom en de tekencode tekent altijd links-naar-rechts).
  Vereist een apart lettertype — Montserrat heeft geen Hebreeuwse glyphs —
  namelijk **Noto Sans Hebrew** (`server/fonts/NotoSansHebrew-Regular.ttf`
  en `NotoSansHebrew-Bold.ttf`, zitten al bij het project). Mocht dit
  bestand ooit ontbreken (bv. bij een schone install zonder deze fontmap),
  dan blijft Hebreeuwse tekst leeg (met een duidelijke waarschuwing in de
  server-log) i.p.v. een crash of half-onzichtbare tekst te veroorzaken — de
  rest van het bestand (foto, hartje, overige tekst) wordt gewoon compleet
  gegenereerd. Dezelfde Hebreeuws-ondersteuning geldt ook voor auto-frame en
  Sound-Frame hieronder (gedeelde code in `server/pdf-shared.js`).
- **Auto-frame-drukwerkbestanden**: orders met een product waarvan de titel
  "Auto-frame" bevat, krijgen automatisch een eigen drukwerkbestand (200x300mm
  PDF, met foto op eigen beeldverhouding, een titel ("Merk en type auto") en 4
  velden met eigen icoontjes: Motor, PK, snelheid, naam) — beschikbaar in
  zwarte of witte tekst, met of zonder QR-code (geen Spotify-code-optie bij
  dit product). Zonder QR-code staan de 4 velden in 2 kolommen van 2; mét
  QR-code schuiven ze automatisch naar 1 kolom van 4, met de QR-code ernaast.
  Werkt op dezelfde 3 plekken als het muziekframe (bulk-download, geplande
  export, losse downloadknop in de popup — "Download auto-frame-bestand"),
  inclusief dezelfde "klein"/"dik"-submap-logica en hetzelfde foto-protocol
  (eigen beeldverhouding behouden, 1%-gele print-markering alleen over de
  foto). De opmaak zelf staat in `server/autoframe.js`, en is 1-op-1 gemeten
  uit een door de klant aangeleverd voorbeeldbestand — de herkenning van de
  klant-ingevulde *veldnamen* (in `extractAutoFrameData` in `server/shopify.js`)
  is wel nog een inschatting; geef door als die een keer niet klopt.
  De 4 icoontjes (zwart én wit) staan als losse PNG-bestanden in
  `server/autoframe-assets/`.
- **"Tegeltje met tekst"-drukwerkbestanden (standaardproduct, géén
  personalisatie)**: dit is een familie van vaste, voorgedefinieerde
  tegeltjes (100x100mm) — de klant kiest alleen de **tegelkleur** (9 opties:
  Wit, Rose, Beige, Marineblauw, Grijs, Blauw, Zwart, Donker groen, Licht
  groen), de tekst zelf ligt al vast per productvariant. Werkt op dezelfde 3
  plekken als de andere producten (bulk-download, geplande export, losse
  downloadknop in de popup — "Download tegeltje-bestand"), met bestelnummer
  + gekozen kleur in de bestandsnaam (bv. `1099 Marineblauw.pdf`), in een
  eigen submap `tegels/gekleurd/` — net als de 13x13-foto-tegels in
  `tegels/groot/` terechtkomen, staan deze tekst-tegeltjes gebundeld onder
  dezelfde `tegels/`-hoofdmap in plaats van een aparte hoofdmap.
  **Tekstkleur-regel** (bevestigd met de opdrachtgever): bij tegelkleur Wit
  of Beige wordt de hoofdtekst zwart, bij alle 7 overige kleuren wit. Een
  eventuele 2e/accentkleur (bv. "GOUD") blijft altijd die vaste accentkleur,
  ongeacht de gekozen tegelkleur.
  Elk afzonderlijk ontwerp (tekst + lay-out + eigen lettertype + eigen
  hartje) staat als eigen item in de `TEGEL_TEKST_ONTWERPEN`-lijst in
  `server/texttile.js`, herkend aan een kenmerkende zin in de producttitel —
  voeg hier een nieuw item toe zodra er een referentiebestand +
  voorbeeldbestelling is van een volgend tegeltje. Momenteel bekend:
  - **"Jij bent goud"** — lettertype Playfair Display (Medium + Black
    Italic, gratis via Google Fonts, bestanden zitten al in het project).
    "GOUD" is de accentregel (altijd goud, ongeacht tegelkleur).
  - **"Altijd fijn om bij Oma te zijn"** — lettertype **Blastered**
    (Pizzadude.dk, een betaald lettertype) — `Blastered-Regular.otf` zit al
    bij het project, geen verdere actie nodig. Geen aparte accentregel — de
    kenmerkende bordeauxrode kleur zit alleen in het (met de hand getekende)
    hartje.
  - **"Wat je in je hart bewaart"** — lettertype **Minion Pro Semibold**
    (Adobe) — `MinionPro-Semibold.otf` zit al bij het project. Geen aparte
    accentregel — het (dunne, open) hartje is goud.
  - **"Liefde neemt nooit afscheid"** — hergebruikt het al aanwezige
    Blastered-lettertype. Geen aparte accentregel — het (dunne, open)
    hartje heeft hier bewust GEEN vaste kleur (i.t.t. de andere ontwerpen):
    het volgt dezelfde zwart/wit-regel als de hoofdtekst
    (`volgtHoofdtekstkleur: true` bij dit ontwerp in `server/texttile.js`),
    anders zou het op een zwarte tegel onzichtbaar worden.
  - **"Altijd fijn om bij Opa & Oma te zijn"** — hergebruikt zowel het
    Blastered-lettertype als het bordeauxrode hartje (identiek pad + kleur)
    van "Altijd fijn om bij Oma te zijn" hierboven, alleen 3 tekstregels
    i.p.v. 2 (en het hartje dus ietsje lager). **Let op de volgorde** in
    `TEGEL_TEKST_ONTWERPEN`: dit ontwerp moet VÓÓR "Altijd fijn om bij Oma te
    zijn" in de lijst staan, want die laatste se herkenningsregex
    (`/altijd\s*fijn.*oma/i`) zou een "Opa & Oma"-titel ook matchen (bevat
    immers ook "oma") — `.find()` pakt altijd de eerste match.
  - **"Huisje vol liefde"** — lettertype **Blooming Elegant Hand**
    (`BloomingElegantHand.otf`, zit al bij het project) — een schrijfletter-
    achtig lettertype waarbij kleine letters er zelf al hoofdletter-achtig
    uitzien (dus "Huisje"/"vol"/"liefde" precies zo overnemen, niet zelf naar
    hoofdletters omzetten). Hergebruikt hetzelfde bordeauxrode hartje als de
    Oma-/Opa & Oma-ontwerpen (identiek pad + kleur, weer een ander
    ankerpunt).
  - **"Beste vriendin met definitie"** — woordenboek-stijl lay-out (titel +
    dun lijntje + "zelfstandig naamwoord" + 5 genummerde regels). **LINKS
    uitgelijnd** i.p.v. gecentreerd (`xMm` per regel in plaats van het
    automatisch-centreren van de andere ontwerpen) en **geen hartje**. Het
    lijntje onder de titel (`ontwerp.lijn`) volgt gewoon de hoofdtekst-kleur
    (geen aparte accentkleur). Titel in **Bodoni Moda Bold**, ondertitel in
    **Bodoni Moda Regular**, de 5 genummerde regels in **Playfair Display
    Medium Italic** — alle 3 bestanden zitten al bij het project, geen
    verdere actie nodig.
  - **"In dit huis plassen we zittend, bedankt."** — hergebruikt het
    al aanwezige Blastered-lettertype (net als de Oma-/Opa & Oma-/Liefde-
    ontwerpen), maar **links uitgelijnd** i.p.v. gecentreerd en **geen
    hartje** (net als "Beste vriendin met definitie").
  - **"Opa met definitie"** — zelfde woordenboek-stijl als "Beste vriendin
    met definitie" (titel + dun lijntje + cursief-ogende ondertitel + een
    genummerde lijst, links uitgelijnd, geen hartje), hergebruikt dezelfde
    Bodoni Moda-lettertypebestanden. **Let op**: in het referentiebestand
    was de genummerde lijst technisch ingebed als het macOS-systeemfont
    "Khmer MN" — de letters zien er zelf gewoon Bodoni-achtig en rechtop
    uit (geen Khmer-schrift), dus vrijwel zeker een verkeerd-geëxporteerde
    fallback in het originele bestand. Aangenomen dat dit gewoon Bodoni
    Moda Regular moet zijn — laat het weten als dat toch niet blijkt te
    kloppen. De nummering in het referentiebestand zelf sloeg per ongeluk
    "2" over (1, 3, 4, 5) — inmiddels rechtgezet naar netjes doorlopend
    1, 2, 3, 4.
  **Belangrijk**: een "Tegeltje met tekst"-order krijgt alleen automatisch
  status "wacht op drukwerkbestand" als het ontwerp herkend wordt — een nog
  onbekende tekst-variant valt terug op het oude gedrag ("wacht op
  productie", geen bestand wordt gegenereerd).
  De "witte" tekstkleur (bij de 7 tegelkleuren die geen zwarte tekst krijgen)
  gebruikt dezelfde 1%-gele CMYK-truc als de rest van het project — nooit
  letterlijk #FFFFFF.
- **Sound-Frame-drukwerkbestanden** (`server/soundframe.js`, 100x100mm):
  dezelfde opties als het muziekframe (Regel 1/2, Begintijd/Eindtijd tijdlijn,
  Positie Bolletje Tijdlijn, Kleur van het hartje, Foto-filter — herkend via
  dezelfde soort eigenschap-matching), maar met een compleet andere opmaak:
  de foto vult de **VOLLEDIGE 100x100mm tegel** (afgeronde hoeken, cover-fit
  — snijdt bij tot vierkant i.p.v. de eigen beeldverhouding te behouden), met
  titel/artiest/hartje/tijdlijn er **overheen** getekend i.p.v. eronder. Geen
  achtergrondkleur-keuze en geen Spotify-/QR-code-optie (alleen "Kies hier de
  stijl van jouw Socialframe.": Zwart/Wit, bepaalt zowel de tekstkleur als de
  kleur van de play-knop).
  **Let op — belangrijke correctie na de eerste versie**: het aangeleverde
  referentiebestand bleek een gestileerde PREVIEW te zijn (kleiner kaartje
  van ~63,5x63,5mm met witruimte eromheen, bedoeld voor social media), GEEN
  1-op-1 drukklaar bestand — alle posities in `soundframe.js` zijn daarom
  PROPORTIONEEL herschaald naar de volledige 100x100mm (zie de constanten
  bovenaan het bestand: `KAART_SIZE_MM = 100`, met elders in het bestand
  overal dezelfde herschalings-logica).
  - **Afgeronde hoeken**: nieuwe techniek (`embedPhotoRounded` in
    `pdf-shared.js`) — de foto wordt als PNG (met echte alpha-transparantie
    in de afgeronde hoeken) i.p.v. JPEG ingebed, want JPEG ondersteunt geen
    transparantie. Dezelfde Y+8%-kleurbalans-correctie als embedPhoto blijft
    behouden, alleen zonder het JPEG-hercompressie-vangnet (niet nodig, PNG
    is lossless).
  - **Afspeelknoppen + tijdlijn**: ECHTE vectorvormen — hergebruikt de
    bestaande iconen (shuffle/vorige/afspelen/volgende/herhalen) uit
    `server/musicframe-paths.js`, herschaald met een experimenteel bepaalde
    factor (`ICOON_SCHAAL` in `server/soundframe.js`) om in het Sound-Frame-
    kaartje te passen — scherper op elke printresolutie dan de aanvankelijk
    gebruikte, aangeleverde raster-overlay (die is inmiddels niet meer nodig/
    aanwezig).
  - **Play-knop**: een gevulde cirkel MET EEN ECHT TRANSPARANT GAT in de
    vorm van het driehoekje (`maakPlayknopMetGat` in `server/soundframe.js`)
    — dus NIET een ondoorzichtig driehoekje erbovenop getekend (dat was de
    eerste, foute versie), maar een uitsparing waar de foto gewoon doorheen
    zichtbaar blijft, zoals in het referentiebestand. Gebouwd via een SVG met
    `fill-rule="evenodd"` (cirkel + geneste driehoek, gerenderd met sharp/
    librsvg — dat geeft echte alfa-transparantie in het "gat", geen kwestie
    van een verkeerde vulkleur).
  - **Hartje**: een echt hart-icoon (niet een benaderende cirkel) —
    `server/soundframe-assets/hart-masker.png` is een grijswaarden-
    luminantiemasker (uit het referentiebestand gehaald, dezelfde techniek
    als een PDF-SMask) dat tijdens het genereren dynamisch wordt ingekleurd
    (rood/zwart/wit) via sharp se `joinChannel` — LET OP: dit is expliciet
    ANDERS dan een normaal alfakanaal, `composite(...,{blend:'dest-in'})`
    werkt hier niet (behandelt een grijswaardenbeeld als ondoorzichtig, geen
    maskering).
  - Komt in de bulk-export in een eigen map `soundframe/` terecht (net als
    muziekframe/auto-frame hun eigen map hebben), met "soundframe" in de
    bestandsnaam.
- **Achtergrondkleur (muziekframe én auto-frame)**: 4 opties — "Wit" (subtiele
  1%-gele CMYK-truc, C0 M0 Y1 K0, i.p.v. puur wit), "Zwart" (diepzwart),
  "Marmerwit" en "Marmerzwart" (echte marmertextuur, beeldvullend over de hele
  plaat — bestanden staan in `server/background-assets/`). Bij "Transparant"
  (of een onbekende/lege waarde) blijft de achtergrond leeg. Zit er een QR-/
  Spotify-code op de plaat, dan krijgt die bij een **marmer**-achtergrond ook
  1% geel als vlak erachter i.p.v. puur wit (anders staat er een raar wit
  blokje bovenop de textuur) — bij Wit/Zwart/Transparant blijft dat gewoon wit.
  **Let op**: kies je zwarte tekst/iconen mét een zwarte of marmerzwarte
  achtergrond (of wit-op-wit), dan is die combinatie nauwelijks leesbaar — de
  code controleert dat niet automatisch, dat is aan de klant/het productformulier
  om een zinnige combinatie te forceren.
- **Trustpilot-review-mail**: elke dag om 10:00 wordt gecontroleerd of er
  orders zijn die minstens `REVIEW_EMAIL_DELAY_DAYS` (standaard 5) dagen
  geleden op status `verzonden` zijn gezet — die krijgen dan automatisch een
  mailtje met het verzoek om een review op Trustpilot achter te laten. Is een
  order na het verzenden alsnog op `geannuleerd` of `onjuiste gegevens` gezet,
  dan wordt 'm overgeslagen. Elke order krijgt deze mail maar **1x** (ook als
  de server ondertussen herstart). Vereist een gratis account bij
  [Resend](https://resend.com) (zie `.env.example` voor de benodigde
  instellingen: `RESEND_API_KEY`, `REVIEW_EMAIL_FROM`, `TRUSTPILOT_REVIEW_URL`).
  Wil je dit direct testen zonder tot 10:00 te wachten: open het dashboard in
  de browser (zodat je ingelogd bent), open de Developer Tools (Console-tabblad),
  en typ: `fetch('/api/reviews/run-scheduled-check', {method:'POST'})`.
  De e-mailtekst zelf staat in `server/reviewEmail.js`.

## Installatie

1. Zorg dat [Node.js](https://nodejs.org) (versie 18+) geïnstalleerd is.
2. Pak dit project uit en open een terminal in de map.
3. Installeer de dependencies:
   ```
   npm install
   ```
4. Kopieer `.env.example` naar `.env`:
   ```
   cp .env.example .env
   ```
5. Vul `.env` in met jouw gegevens:
   - `SHOPIFY_STORE`: jouw winkel domein, bv. `mijnwinkel.myshopify.com`
   - `SHOPIFY_ACCESS_TOKEN`: Admin API access token (zie hieronder)
   - `AUTH_USER` / `AUTH_PASS`: inloggegevens voor het dashboard
6. **(Optioneel, om eerst te testen)** Zet er een paar testorders in zonder dat
   Shopify al gekoppeld hoeft te zijn:
   ```
   npm run seed
   ```
   Dit zet 6 nepbestellingen in de database — met verschillende statussen, een paar
   met een Spotify-link en een paar met een voorbeeldfoto — zodat je de zoekbalk,
   paginering, selectie en het printen van pakbonnen direct kan uittesten.
7. Start de server:
   ```
   npm start
   ```
   Ga je nog code aanpassen tijdens het testen? Gebruik dan in plaats daarvan:
   ```
   npm run dev
   ```
   Dit start de server via `nodemon`, die automatisch herstart zodra je een
   bestand in `server/` opslaat — je hoeft dan niet steeds zelf Ctrl+C + `npm start`
   te doen. Wijzigingen in `public/` (html/css/js) hebben sowieso geen herstart
   nodig, alleen een refresh van de browserpagina.
8. Open `http://localhost:3000` in de browser. Je krijgt een login-scherm
   (gebruikersnaam/wachtwoord uit je `.env`).

**Let op:** zodra je daarna de server met echte Shopify-gegevens laat
synchroniseren, kan je de testorders er weer uithalen door het bestand
`orders.db` te verwijderen en de server opnieuw te starten (dan begint hij
schoon en haalt hij alleen je echte orders op).

## Online zetten via Railway

Railway is een eenvoudige hostingdienst waar deze app 24/7 kan draaien,
zonder dat je zelf een server hoeft te beheren.

**Node-versie vastgezet op 22.x** (zie `"engines"` in `package.json`): Node
24.19.0 bevat een bekende bug die de server af en toe kan laten crashen bij
het afsluiten (`RemoveEnvironmentCleanupHook`/`Assertion failed: (env) !=
nullptr`, in combinatie met `better-sqlite3`). Railway's standaard
bouwsysteem (Nixpacks) kan alleen een hóófdversie vastzetten (dus geen
specifieke subversie zoals 24.18.1) — vandaar de keuze voor de 22.x-lijn,
die deze bug niet heeft en nog steeds actief onderhouden wordt (tot april
2027).

1. Maak op [railway.app](https://railway.app) een nieuw project, en kies
   **"Deploy from GitHub repo"** (zet dit project dus eerst in een eigen
   GitHub-repository — of gebruik Railway's "Empty Project" + upload via hun
   CLI als je geen GitHub wil gebruiken).
2. **Belangrijk — permanente opslag toevoegen**: klik in je Railway-project op
   je service → tabblad **Volumes** → **New Volume**. Geef als **Mount path**
   bijvoorbeeld `/data` op. Zonder dit ben je bij elke nieuwe deploy je hele
   orderdatabase kwijt (Railway's normale bestandssysteem wordt bij elke
   deploy vanuit de code opnieuw opgebouwd, dus alles wat er lokaal bij komt —
   zoals `orders.db` — verdwijnt anders gewoon weer).
3. Zet bij **Variables** dezelfde instellingen als in `.env.example`, plus:
   - `DATA_DIR` = `/data` (of het pad dat je bij stap 2 als mount path koos)
   - `NODE_ENV` = `production`
   
   Railway zet automatisch zelf een `PORT`-variabele — daar hoef je niets
   voor te doen, de app leest die al vanzelf uit.
4. Railway herkent dit als een Node.js-project en draait automatisch
   `npm install` gevolgd door `npm start` — geen extra configuratie nodig.
5. Zodra de deploy klaar is, krijg je van Railway een `.up.railway.app`-url
   (of koppel je eigen domein via **Settings → Networking → Custom Domain**).

**Let op**: de Montserrat-fontbestanden en alle andere assets staan al in de
zip, dus die komen automatisch mee bij een GitHub-push/Railway-deploy — je
hoeft ze niet apart te uploaden.

**Sessies (ingelogd blijven) overleven een herstart**: login-sessies worden
opgeslagen in dezelfde SQLite-database als de orders (dus ook op de
permanente Volume, zie stap 2 hierboven) — niet in het geheugen van het
serverproces. Zonder dit zou iedereen bij **elke** nieuwe deploy automatisch
worden uitgelogd, ook al is de sessie-cookie zelf nog 7 dagen geldig. Zorg
dus vooral dat `SESSION_SECRET` (stap 3) én de Volume (stap 2) allebei goed
staan — mist een van de twee, dan werkt "ingelogd blijven" nog steeds niet
betrouwbaar.

## Een Shopify Admin API token aanmaken

1. Ga naar je Shopify Admin → **Instellingen → Apps en verkoopkanalen → Apps ontwikkelen**.
2. Klik **Een app maken**, geef een naam.
3. Onder **Configuratie** → **Admin API scopes**: schakel minimaal `read_orders` in.
4. Klik **API-credentials** → **Installeer app** → kopieer het
   **Admin API access token** (begint met `shpat_...`).
5. Zet dit token in `.env` als `SHOPIFY_ACCESS_TOKEN`.

## Hoe Spotify-links herkend worden

De app doorzoekt bij elke order:
- de ordernotitie (`note`)
- de note attributes
- de **properties van elk line item** (dit zijn de custom velden die een klant
  invult op de productpagina, bijvoorbeeld via een app als "Custom Fields" of
  "Product Options" — handig als klanten hier hun Spotify link invullen)

Elke tekst die een `open.spotify.com/...` link of `spotify:...` URI bevat
wordt herkend en getoond in de popup.

**Let op:** als jouw Spotify-links ergens anders in de order staan (bijvoorbeeld
in een ander veld), stuur dat door en dan pas ik `extractSpotifyLinks` in
`server/shopify.js` aan zodat die op de juiste plek zoekt.

## Hoe geüploade foto's herkend worden

De app doorzoekt de line item properties op drie manieren:
1. Links die eindigen op een afbeeldingsextensie (`.jpg`, `.jpeg`, `.png`, `.gif`,
   `.webp`, `.svg`) — voor gewone foto-upload-apps die de bestands-URL in een
   custom property zetten.
2. Links die "autopictura" in het domein bevatten (specifiek de
   `_autopictura_design_link`-property) — deze hebben geen bestandsextensie,
   dus die worden apart herkend op basis van het domein. De losse
   `_autopictura_generation_id` (een kale UUID) en `_autopictura_generated_image`
   (een relatief pad zonder `https://`) worden bewust genegeerd — alleen de
   volledige `_autopictura_design_link`-URL is de link die gebruikt wordt voor
   de preview op de pakbon en het drukwerkbestand.
3. Links naar bestanden die klanten rechtstreeks via Shopify's eigen
   uploadveld hebben ingestuurd (`cdn.shopify.com/s/files/...`, bijvoorbeeld
   een `_svg 0`-property) — deze worden herkend puur op het cdn.shopify.com-domein,
   ook als de extensie niet in de gebruikelijke lijst voorkomt.

**Belangrijk onderscheid in de popup en op de pakbon:** alleen links met
"autopictura" erin krijgen de **drukwerkbestand (PDF)**-knop op het exacte
fysieke formaat. Alle andere gevonden foto's/bestanden (zoals een losse SVG-
of foto-upload) krijgen gewoon de normale **⬇ Download het bestand**-knop,
die het originele bestand ongewijzigd aflevert.

Werkt jullie situatie net anders (andere property-naam, ander domein)? Stuur
een voorbeeld door, dan pas ik `extractPhotoLinks` in `server/shopify.js`
hierop aan.

In de testdata (order 1007, via `npm run seed`) zitten nu beide voorbeelden:
een `_autopictura_design_link`-property én een `_svg 0`-property, zodat je
meteen kan zien dat elk zijn eigen soort downloadknop krijgt. De testlink voor
de SVG is een fictief voorbeeld-pad, dus de fotopreview daarvan zal in de
popup niet echt laden (dat hoort zo) — de downloadknop zelf werkt wel altijd,
ook als de preview faalt.

## Bestand downloaden vanuit de popup

Bij elke gevonden foto in de popup staat een knop **⬇ Download het bestand**.
Deze gaat via `/api/download?url=...` op de server, die het bestand ophaalt en
met een `Content-Disposition: attachment` header teruggeeft — zo wordt het
bestand altijd gedownload in plaats van in een nieuw tabblad geopend, ook als
de externe dienst zelf geen download-headers meestuurt.

## Drukwerkbestanden (PDF)

De knop **⬇ Drukwerkbestanden (PDF)** op de hoofdpagina doet het volgende:

1. Werkt alleen op de orders die je hebt **aangevinkt** in de tabel — de knop
   staat uitgeschakeld zolang er niets is geselecteerd.
2. Filtert daarvan de orders die een foto-link bevatten met "autopictura" erin
   (geselecteerde orders zonder autopictura-link worden overgeslagen).
3. Haalt voor elke overgebleven order de afbeelding op bij autopictura.
4. Zoekt in de volledige besteltekst (producttitel, variant, eigenschappen)
   naar "10x10" of "13x13".
5. Zet de afbeelding om naar een `.pdf`-bestand op het gedetecteerde fysieke
   drukformaat (10×10cm of 13×13cm, op 300dpi). De PDF-pagina heeft exact dat
   formaat en de foto vult 'm volledig — dit is met `pdf-lib` opgebouwd (een
   pure JS-library) en hier ook daadwerkelijk gerenderd en gecontroleerd
   (paginagrootte + zichtbare foto) voordat het is opgeleverd. Bij "13x13"
   krijgt de bestandsnaam `groot` achter het ordernummer (bv. `1007 groot.pdf`)
   én komt het bestand in een submap `groot/` te staan; standaardformaat-
   bestanden (10x10) staan gewoon los in de hoofdmap (bv. `1007.pdf`).
6. Bundelt alles in één `tegeltjes.zip` om te downloaden — met daarin dus een
   submap `groot/` voor alle 13x13-bestanden.

Gaat het ophalen of omzetten van een specifieke order mis, dan komt er in
plaats van een `.pdf` een `FOUT-<ordernummer>.txt` in de zip met de
foutmelding, zodat de rest van de bestanden gewoon doorgaat.

**Let op:** deze functie gebruikt de `sharp` library voor beeldbewerking.
Dat is een native module — bij `npm install` wordt er dus een platform-specifiek
binair bestand gedownload. Dit werkt op de meeste systemen automatisch, maar
vraagt (net als `better-sqlite3`) wel om een werkende internetverbinding tijdens
de installatie. Kom je een installatiefout tegen met `sharp`, stuur die door
dan help ik je verder.

Werkt jullie drukkerij/RIP liever met een ander formaat (bijvoorbeeld toch
weer EPS, of CMYK in plaats van RGB)? Laat het weten, dan pas ik
`server/printfile.js` daarop aan.


## Pakbonnen printen

1. Vink in de tabel de orders aan die je wil printen (of vink het bovenste
   selectievakje aan om alles op de huidige pagina te selecteren — max. 50).
2. Klik op **🖨️ Print pakbonnen**.
3. Er opent een nieuw venster met voor elke geselecteerde order een bonnetje
   op 80mm breedte (8cm — standaard formaat voor bon-/thermische printers), met
   ordernummer, klantgegevens, bestelde items en — indien aanwezig — een
   kleine preview van de geüploade foto. De bon krijgt geen vaste lengte:
   die volgt automatisch de inhoud, met 1cm marge boven en onder (via een
   `@page { size: 80mm auto; margin: 1cm 0; }` regel), zodat er geen leeg
   papier wordt doorgevoerd op een kassarol.
4. De browser print-dialoog opent automatisch; kies daar je bonprinter.

Print je op 58mm in plaats van 80mm? Pas dan `80mm` aan naar `58mm` op de
twee plekken in de inline `<style>` binnen `printOrders()` in `public/app.js`
(bij `@page` en bij `.receipt-page`).

**Let op:** de "auto"-hoogte voor het paginaformaat wordt niet door elke
browser/printerdriver op precies dezelfde manier opgepakt. Test dit even met
jullie bonprinter — werkt het ergens niet zoals verwacht, laat het weten dan
stem ik het af op jullie specifieke printer/driver.

## Statussen

Standaard statussen in het dashboard:
- `wacht op drukwerkbestand` (automatisch bij nieuwe order)
- `wacht op productie` (enige status die je vanuit de order-popup kan zetten)
- `verzonden`
- `geannuleerd`
- `onjuiste gegevens`

Wil je meer/andere statussen? Pas de `STATUSES` array bovenaan
`public/app.js` aan, én de `<option>`s in `public/index.html` (filterknoppen
en bulk-status dropdown).

## Deployen (live zetten)

Dit project draait als een gewone Node.js server, dus je kan het hosten op
bijvoorbeeld Render, Railway, een VPS, of een Node-hosting van je keuze.
Zorg dat:
- de `.env` variabelen op de server zijn ingesteld,
- poort `PORT` open staat / correct doorgestuurd wordt,
- je bij voorkeur **HTTPS** gebruikt (bijv. via een reverse proxy zoals
  Nginx of de HTTPS die je hostingpartij aanbiedt), zodat gebruikersnaam/
  wachtwoord niet onversleuteld over het netwerk gaan.

## Projectstructuur

```
shopify-order-app/
├── server/
│   ├── index.js      # Express server, auth, cron sync, API routes
│   ├── shopify.js     # Shopify API aanroepen + spotify link detectie
│   └── db.js          # SQLite database (orders.db wordt automatisch aangemaakt)
├── public/
│   ├── index.html      # Dashboard pagina
│   ├── app.js           # Frontend logica (tabel, popup, knoppen)
│   └── style.css        # Styling
├── .env.example
├── package.json
└── README.md
```
