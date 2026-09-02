const { PDFDocument, rgb, cmyk, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');
const { MM, nearWhiteCmyk } = require('./pdf-shared');
const paths = require('./musicframe-paths');

const PAGE_W_MM = 100;
const PAGE_H_MM = 100;

const COLOR_BLACK = rgb(0, 0, 0);
// Wit = de 1%-gele CMYK-truc (C0 M0 Y1 K0), net als overal elders in dit
// project — nooit letterlijk #FFFFFF, want dat kan een printer soms als
// "geen inkt"/gat zien i.p.v. als te printen kleur.
const COLOR_WHITE = nearWhiteCmyk(cmyk);

// --- Tegelkleuren waarbij de hoofdtekst ZWART wordt (lichte tegel) — alle
// overige kleuren (incl. Zwart zelf) krijgen WITTE hoofdtekst. Bevestigd met
// de opdrachtgever: alleen Wit en Beige geven zwarte tekst. ---
const LICHTE_TEGELKLEUREN = ['wit', 'beige'];

// --- Bekende, vaste tekst-ontwerpen. Elk ontwerp heeft:
//  - herken: regex die matcht op de producttitel
//  - lettertypeBestanden/lettertypeTerugval: elk ontwerp kan zijn EIGEN
//    lettertype(n) gebruiken (bv. Playfair Display vs. Blastered) — bestanden
//    horen in server/fonts/ te staan; ontbreken ze, dan valt de server terug
//    op het meegegeven ingebouwde PDF-lettertype.
//  - regels: lijst van tekstregels. accent:true = ALTIJD de accentkleur
//    (ongeacht tegelkleur); overige regels volgen de zwart/wit-regel
//    hierboven.
//  - hart: eigen hart-pad + eigen (vaste) kleur + positie/schaal — twee
//    'eenheid'-varianten worden ondersteund, zie drawHart() hieronder.
// Nieuwe varianten kunnen hier simpelweg worden toegevoegd zodra er een
// referentiebestand + voorbeeldbestelling van is.
const TEGEL_TEKST_ONTWERPEN = [
  {
    id: 'jij-bent-goud',
    // Titel in Shopify: "Tegeltje met tekst - Jij bent goud."
    herken: /jij\s*bent\s*goud/i,
    lettertypeBestanden: { medium: 'PlayfairDisplay-Medium.ttf', blackItalic: 'PlayfairDisplay-BlackItalic.ttf' },
    lettertypeTerugval: { medium: StandardFonts.TimesRoman, blackItalic: StandardFonts.TimesRomanBoldItalic },
    regels: [
      { tekst: 'Jij', fontStijl: 'medium', puntgrootteMm: 18.6, topMm: 23.25, accent: false },
      { tekst: 'bent', fontStijl: 'medium', puntgrootteMm: 18.6, topMm: 40.25, accent: false },
      { tekst: 'GOUD', fontStijl: 'blackItalic', puntgrootteMm: 15.0, topMm: 60.12, accent: true }
    ],
    // "genormaliseerd": het hart-pad (uit musicframe-paths.js) staat in eigen
    // eenheden, met een gedocumenteerde widthMm — de schaal is experimenteel
    // bepaald (zie eerdere opmeet-sessie) om op de doelbreedte uit te komen.
    hart: {
      eenheid: 'genormaliseerd',
      pad: paths.heart.d,
      kleur: cmyk(0.2, 0.3, 0.75, 0.05), // altijd goud, ongeacht tegelkleur
      breedteMm: paths.heart.widthMm,
      schaal: 0.4522,
      topMm: 77.03
    }
  },
  {
    id: 'altijd-fijn-opa-en-oma',
    // Titel in Shopify: "Tegeltje met tekst - Altijd fijn om bij Opa & Oma te zijn."
    // LET OP: deze regex moet VÓÓR "altijd-fijn-oma" in de lijst staan — die
    // laatste se regex (/altijd\s*fijn.*oma/i) zou deze titel namelijk OOK
    // matchen (bevat immers ook "oma"), en TEGEL_TEKST_ONTWERPEN.find() pakt
    // altijd de EERSTE match in de lijst.
    herken: /altijd\s*fijn.*opa.*oma/i,
    lettertypeBestanden: { regular: 'Blastered-Regular.otf' },
    lettertypeTerugval: { regular: StandardFonts.HelveticaBold },
    regels: [
      { tekst: 'ALTIJD FIJN', fontStijl: 'regular', puntgrootteMm: 15.35, topMm: 23.24, accent: false },
      { tekst: 'OM BIJ OPA & OMA', fontStijl: 'regular', puntgrootteMm: 15.35, topMm: 42.42, accent: false },
      { tekst: 'TE ZIJN!', fontStijl: 'regular', puntgrootteMm: 15.35, topMm: 61.60, accent: false }
    ],
    // Zelfde hart-pad als "altijd-fijn-oma" hieronder (identiek bevestigd:
    // gelijke kleur + gelijke deelvorm-afmetingen), alleen het ankerpunt is
    // hier lager (Y) omdat er 3 in plaats van 2 tekstregels boven staan.
    hart: {
      eenheid: 'pdf-punten',
      pad: 'M 0,-0.0 C 0.784,-6.955 2.052,-13.846 3.8,-20.629 C 3.825,-20.209 3.84,-19.806 3.857,-19.447 C 4.169,-12.73 2.426,-6.241 0,-0.0 M -8.402,3.299 C -8.309,3.193 -8.243,3.093 -8.214,3.004 C -7.516,0.838 -6.818,-1.328 -6.12,-3.493 C -6.412,-1.037 -6.703,1.419 -6.995,3.876 C -7.054,4.374 -5.137,3.694 -3.976,2.904 C -4.122,4.287 -4.25,5.673 -4.357,7.061 C -5.693,5.834 -7.055,4.584 -8.402,3.299 M -19.896,-11.142 C -19.458,-11.363 -19.015,-11.635 -18.658,-11.916 C -17.959,-10.137 -17.26,-8.359 -16.561,-6.58 C -16.441,-6.279 -15.513,-6.534 -14.596,-6.989 C -13.934,-5.237 -13.416,-3.432 -13.045,-1.573 C -12.973,-1.216 -12.218,-1.487 -11.404,-1.921 C -11.505,-1.265 -11.594,-0.607 -11.674,0.053 C -14.937,-3.343 -17.893,-7.017 -19.896,-11.142 M -14.108,-14.076 C -14.291,-14.005 -14.487,-13.912 -14.685,-13.806 C -15.09,-14.837 -15.495,-15.867 -15.9,-16.898 C -15.189,-16.022 -14.607,-15.072 -14.108,-14.076 M 0.03,-24.901 C 0.528,-25.549 0.225,-25.471 1.125,-25.33 C 1.839,-25.218 2.354,-24.88 2.736,-24.414 C 2.072,-24.068 1.288,-23.563 1.07,-22.927 C 0.412,-21.01 -0.227,-19.087 -0.853,-17.159 C -0.685,-18.571 -0.518,-19.983 -0.35,-21.395 C -0.306,-21.769 -1.235,-21.515 -2.195,-21.055 C -1.78,-21.903 -1.337,-22.74 -0.855,-23.55 C -0.58,-24.011 -0.298,-24.475 0.03,-24.901 M 6.334,-26.926 C 4.688,-28.486 2.125,-27.717 0.365,-26.805 C -2.103,-25.528 -3.717,-23.576 -5.034,-21.168 C -6.564,-18.369 -7.8,-15.439 -8.742,-12.415 C -9.904,-15.96 -11.433,-19.326 -14.635,-21.517 C -16.571,-22.842 -19,-23.523 -21.31,-22.864 C -23.483,-22.244 -26.066,-20.66 -26.194,-18.179 C -26.477,-12.708 -23.057,-7.05 -19.855,-2.897 C -15.835,2.315 -10.883,6.771 -6.078,11.237 C -5.67,11.616 -4.668,11.19 -3.785,10.61 C -2.719,10.249 -0.946,9.104 -0.722,8.621 C 2.025,2.698 4.763,-3.296 6.382,-9.645 C 7.148,-12.649 7.656,-15.729 7.743,-18.832 C 7.807,-21.121 8.156,-25.199 6.334,-26.926 Z',
      kleur: cmyk(0.223, 0.973, 0.602, 0.156), // bordeauxrood — altijd deze kleur, ongeacht tegelkleur
      ankerXMm: 53.27,
      ankerTopMm: 89.983
    }
  },
  {
    id: 'altijd-fijn-oma',
    // Titel in Shopify: "Tegeltje met tekst - Altijd fijn om bij Oma te zijn."
    herken: /altijd\s*fijn.*oma/i,
    lettertypeBestanden: { regular: 'Blastered-Regular.otf' },
    lettertypeTerugval: { regular: StandardFonts.HelveticaBold },
    regels: [
      { tekst: 'ALTIJD FIJN', fontStijl: 'regular', puntgrootteMm: 15.346, topMm: 19.6, accent: false },
      { tekst: 'OM BIJ OMA', fontStijl: 'regular', puntgrootteMm: 15.346, topMm: 38.78, accent: false },
      { tekst: 'TE ZIJN!', fontStijl: 'regular', puntgrootteMm: 15.346, topMm: 57.96, accent: false }
    ],
    // "pdf-punten": dit pad is rechtstreeks uit de PDF-inhoud van het
    // referentiebestand gehaald (via de ruwe content-stream-operators) — de
    // coördinaten staan al in PDF-punten, dus schaal 1 (geen mm-omrekening).
    hart: {
      eenheid: 'pdf-punten',
      pad: 'M 0,-0.0 C 0.784,-6.955 2.052,-13.846 3.8,-20.629 C 3.825,-20.209 3.84,-19.806 3.857,-19.447 C 4.169,-12.73 2.426,-6.241 0,-0.0 M -8.402,3.299 C -8.309,3.193 -8.243,3.093 -8.214,3.004 C -7.516,0.838 -6.818,-1.328 -6.12,-3.493 C -6.412,-1.037 -6.703,1.419 -6.995,3.876 C -7.054,4.374 -5.137,3.694 -3.976,2.904 C -4.122,4.287 -4.25,5.673 -4.357,7.061 C -5.693,5.834 -7.055,4.584 -8.402,3.299 M -19.896,-11.142 C -19.458,-11.363 -19.015,-11.635 -18.658,-11.916 C -17.959,-10.137 -17.26,-8.359 -16.561,-6.58 C -16.441,-6.279 -15.513,-6.534 -14.596,-6.989 C -13.934,-5.237 -13.416,-3.432 -13.045,-1.573 C -12.973,-1.216 -12.218,-1.487 -11.404,-1.921 C -11.505,-1.265 -11.594,-0.607 -11.674,0.053 C -14.937,-3.343 -17.893,-7.017 -19.896,-11.142 M -14.108,-14.076 C -14.291,-14.005 -14.487,-13.912 -14.685,-13.806 C -15.09,-14.837 -15.495,-15.867 -15.9,-16.898 C -15.189,-16.022 -14.607,-15.072 -14.108,-14.076 M 0.03,-24.901 C 0.528,-25.549 0.225,-25.471 1.125,-25.33 C 1.839,-25.218 2.354,-24.88 2.736,-24.414 C 2.072,-24.068 1.288,-23.563 1.07,-22.927 C 0.412,-21.01 -0.227,-19.087 -0.853,-17.159 C -0.685,-18.571 -0.518,-19.983 -0.35,-21.395 C -0.306,-21.769 -1.235,-21.515 -2.195,-21.055 C -1.78,-21.903 -1.337,-22.74 -0.855,-23.55 C -0.58,-24.011 -0.298,-24.475 0.03,-24.901 M 6.334,-26.926 C 4.688,-28.486 2.125,-27.717 0.365,-26.805 C -2.103,-25.528 -3.717,-23.576 -5.034,-21.168 C -6.564,-18.369 -7.8,-15.439 -8.742,-12.415 C -9.904,-15.96 -11.433,-19.326 -14.635,-21.517 C -16.571,-22.842 -19,-23.523 -21.31,-22.864 C -23.483,-22.244 -26.066,-20.66 -26.194,-18.179 C -26.477,-12.708 -23.057,-7.05 -19.855,-2.897 C -15.835,2.315 -10.883,6.771 -6.078,11.237 C -5.67,11.616 -4.668,11.19 -3.785,10.61 C -2.719,10.249 -0.946,9.104 -0.722,8.621 C 2.025,2.698 4.763,-3.296 6.382,-9.645 C 7.148,-12.649 7.656,-15.729 7.743,-18.832 C 7.807,-21.121 8.156,-25.199 6.334,-26.926 Z',
      kleur: cmyk(0.223, 0.973, 0.602, 0.156), // altijd deze kleur, ongeacht tegelkleur
      ankerXMm: 53.27,
      ankerTopMm: 85.284
    }
  },
  {
    id: 'wat-je-in-je-hart-bewaart',
    // Titel in Shopify: "Tegeltje met tekst - Wat je in je hart bewaart."
    herken: /wat\s*je\s*in\s*je\s*hart\s*bewaart/i,
    lettertypeBestanden: { semibold: 'MinionPro-Semibold.otf' },
    lettertypeTerugval: { semibold: StandardFonts.TimesRomanBold },
    regels: [
      { tekst: 'Wat je in je hart bewaart', fontStijl: 'semibold', puntgrootteMm: 7.14, topMm: 41.82, accent: false },
      { tekst: 'raak je nooit meer kwijt.', fontStijl: 'semibold', puntgrootteMm: 7.14, topMm: 50.39, accent: false }
    ],
    // "pdf-punten": zelfde extractiemethode als de andere hartjes hierboven.
    hart: {
      eenheid: 'pdf-punten',
      pad: 'M 0,-0.0 C -1.801,1.887 -3.067,3.373 -3.955,5.903 C -4.046,6.162 -4.394,7.638 -4.471,7.69 C -4.861,7.955 -5.125,6.934 -5.176,6.704 C -6.157,2.271 -1.176,-1.93 1.453,-4.922 C 3.663,-7.438 6.261,-10.735 6.478,-14.219 C 6.738,-18.393 2.287,-17.624 -0.206,-16.298 C -2.854,-14.89 -5.7,-11.447 -5.933,-8.377 C -5.952,-8.132 -5.876,-7.387 -5.985,-7.249 C -6.906,-6.867 -6.788,-7.975 -6.973,-8.575 C -7.473,-10.203 -8.96,-12.189 -10.32,-13.203 C -14.288,-16.163 -17.863,-13.374 -16.971,-8.742 C -16.121,-4.326 -11.034,0.11 -7.135,1.978 C -7.079,2.005 -6.527,2.126 -6.72,2.239 C -7.02,2.415 -7.662,2.203 -7.985,2.099 C -12.421,0.659 -18.346,-4.937 -18.733,-9.789 C -19.192,-15.554 -13.285,-17.097 -9.387,-13.687 C -8.206,-12.654 -7.37,-11.392 -6.669,-10.002 C -6.647,-9.958 -6.65,-9.827 -6.553,-9.922 C -6.502,-9.972 -6.164,-11.056 -6.073,-11.268 C -4.555,-14.797 -1.222,-18.489 2.857,-18.74 C 5.549,-18.905 8.229,-17.257 8.55,-14.436 C 9.186,-8.849 3.497,-3.663 0,-0.0 Z',
      kleur: cmyk(0.2, 0.3, 0.75, 0.05), // goud — altijd deze kleur, ongeacht tegelkleur
      ankerXMm: 51.817,
      ankerTopMm: 70.751
    }
  },
  {
    id: 'liefde-neemt-nooit-afscheid',
    // Titel in Shopify: "Tegeltje met tekst - Liefde neemt nooit afscheid."
    herken: /liefde\s*neemt.*afscheid/i,
    lettertypeBestanden: { regular: 'Blastered-Regular.otf' },
    lettertypeTerugval: { regular: StandardFonts.HelveticaBold },
    regels: [
      { tekst: 'LIEFDE NEEMT', fontStijl: 'regular', puntgrootteMm: 15.35, topMm: 41.93, accent: false },
      { tekst: 'NOOIT AFSCHEID', fontStijl: 'regular', puntgrootteMm: 15.35, topMm: 61.11, accent: false }
    ],
    hart: {
      eenheid: 'pdf-punten',
      pad: 'M 0,-0.0 C -0.286,1.635 -1.3,3.266 -2.108,4.691 C -4.574,9.041 -7.838,12.954 -11.73,16.092 C -13.817,13.987 -15.551,11.554 -16.726,8.768 C -18.076,5.564 -18.663,2.01 -18.126,-1.442 C -17.884,-3.006 -17.476,-4.72 -16.498,-6.002 C -16.465,-6.045 -16.425,-6.08 -16.386,-6.109 C -16.26,-6.08 -15.969,-6.07 -15.986,-6.074 C -15.622,-5.979 -15.286,-5.924 -14.941,-5.762 C -14.189,-5.41 -13.569,-4.814 -13.123,-4.119 C -10.816,-0.528 -13.458,4.172 -12.053,8.06 C -11.841,8.645 -9.677,7.103 -9.5,6.825 C -8.351,5.022 -7.201,3.22 -6.052,1.417 C -5.286,0.215 -4.384,-1.607 -3.118,-2.369 C -1.491,-3.347 0.291,-1.661 0,-0.0 M 2.626,-2.611 C 2.217,-4.06 0.523,-4.376 -0.772,-4.172 C -2.239,-3.941 -3.653,-3.134 -4.798,-2.216 C -6.113,-1.161 -7.129,0.191 -8.037,1.597 C -8.638,2.529 -9.234,3.465 -9.829,4.401 C -10.027,0.871 -8.461,-3.112 -10.779,-6.039 C -13.101,-8.972 -17.134,-7.573 -19.069,-4.921 C -21.203,-1.994 -21.277,2.434 -20.671,5.855 C -19.955,9.899 -17.991,13.611 -15.264,16.659 C -14.895,17.072 -14.513,17.473 -14.119,17.861 C -14.689,18.25 -15.267,18.626 -15.859,18.981 C -16.073,19.11 -17.18,19.73 -16.969,20.095 C -16.765,20.449 -15.607,19.786 -15.45,19.691 C -14.789,19.295 -14.14,18.881 -13.5,18.454 C -10.87,20.898 -7.789,22.84 -4.558,24.394 C -3.891,24.714 -1.71,22.944 -2.132,22.741 C -5.362,21.188 -8.466,19.196 -11.081,16.726 C -7.193,13.761 -3.78,10.197 -1.075,6.096 C -0.196,4.763 0.602,3.378 1.325,1.954 C 1.988,0.647 3.057,-1.082 2.626,-2.611 Z',
      // Dit hartje heeft GEEN eigen vaste kleur (i.t.t. de andere ontwerpen)
      // — volgt in plaats daarvan dezelfde zwart/wit-regel als de hoofdtekst
      // (bevestigd met de opdrachtgever: anders zou het op een zwarte tegel
      // onzichtbaar worden, zwart-op-zwart).
      volgtHoofdtekstkleur: true,
      ankerXMm: 52.5,
      ankerTopMm: 81.13
    }
  },
  {
    id: 'huisje-vol-liefde',
    // Titel in Shopify: "Tegeltje met tekst - Huisje vol liefde."
    herken: /huisje\s*vol\s*liefde/i,
    lettertypeBestanden: { regular: 'BloomingElegantHand.otf' },
    lettertypeTerugval: { regular: StandardFonts.TimesRomanItalic },
    regels: [
      { tekst: 'Huisje', fontStijl: 'regular', puntgrootteMm: 18.6, topMm: 20.31, accent: false },
      { tekst: 'vol', fontStijl: 'regular', puntgrootteMm: 18.6, topMm: 37.31, accent: false },
      { tekst: 'liefde', fontStijl: 'regular', puntgrootteMm: 18.6, topMm: 54.31, accent: false }
    ],
    // Zelfde hart-pad als "altijd-fijn-oma"/"altijd-fijn-opa-en-oma"
    // hierboven (identiek bevestigd: gelijke kleur + gelijke deelvorm-
    // afmetingen), alleen weer een ander ankerpunt.
    hart: {
      eenheid: 'pdf-punten',
      pad: 'M 0,-0.0 C 0.784,-6.955 2.052,-13.846 3.8,-20.629 C 3.825,-20.209 3.84,-19.806 3.857,-19.447 C 4.169,-12.73 2.426,-6.241 0,-0.0 M -8.402,3.299 C -8.309,3.193 -8.243,3.093 -8.214,3.004 C -7.516,0.838 -6.818,-1.328 -6.12,-3.493 C -6.412,-1.037 -6.703,1.419 -6.995,3.876 C -7.054,4.374 -5.137,3.694 -3.976,2.904 C -4.122,4.287 -4.25,5.673 -4.357,7.061 C -5.693,5.834 -7.055,4.584 -8.402,3.299 M -19.896,-11.142 C -19.458,-11.363 -19.015,-11.635 -18.658,-11.916 C -17.959,-10.137 -17.26,-8.359 -16.561,-6.58 C -16.441,-6.279 -15.513,-6.534 -14.596,-6.989 C -13.934,-5.237 -13.416,-3.432 -13.045,-1.573 C -12.973,-1.216 -12.218,-1.487 -11.404,-1.921 C -11.505,-1.265 -11.594,-0.607 -11.674,0.053 C -14.937,-3.343 -17.893,-7.017 -19.896,-11.142 M -14.108,-14.076 C -14.291,-14.005 -14.487,-13.912 -14.685,-13.806 C -15.09,-14.837 -15.495,-15.867 -15.9,-16.898 C -15.189,-16.022 -14.607,-15.072 -14.108,-14.076 M 0.03,-24.901 C 0.528,-25.549 0.225,-25.471 1.125,-25.33 C 1.839,-25.218 2.354,-24.88 2.736,-24.414 C 2.072,-24.068 1.288,-23.563 1.07,-22.927 C 0.412,-21.01 -0.227,-19.087 -0.853,-17.159 C -0.685,-18.571 -0.518,-19.983 -0.35,-21.395 C -0.306,-21.769 -1.235,-21.515 -2.195,-21.055 C -1.78,-21.903 -1.337,-22.74 -0.855,-23.55 C -0.58,-24.011 -0.298,-24.475 0.03,-24.901 M 6.334,-26.926 C 4.688,-28.486 2.125,-27.717 0.365,-26.805 C -2.103,-25.528 -3.717,-23.576 -5.034,-21.168 C -6.564,-18.369 -7.8,-15.439 -8.742,-12.415 C -9.904,-15.96 -11.433,-19.326 -14.635,-21.517 C -16.571,-22.842 -19,-23.523 -21.31,-22.864 C -23.483,-22.244 -26.066,-20.66 -26.194,-18.179 C -26.477,-12.708 -23.057,-7.05 -19.855,-2.897 C -15.835,2.315 -10.883,6.771 -6.078,11.237 C -5.67,11.616 -4.668,11.19 -3.785,10.61 C -2.719,10.249 -0.946,9.104 -0.722,8.621 C 2.025,2.698 4.763,-3.296 6.382,-9.645 C 7.148,-12.649 7.656,-15.729 7.743,-18.832 C 7.807,-21.121 8.156,-25.199 6.334,-26.926 Z',
      kleur: cmyk(0.223, 0.973, 0.602, 0.156), // bordeauxrood — altijd deze kleur, ongeacht tegelkleur
      ankerXMm: 53.27,
      ankerTopMm: 83.985
    }
  },
  {
    id: 'beste-vriendin-definitie',
    // Titel in Shopify: "Tegeltje met Tekst - Beste vriendin met definitie."
    herken: /beste\s*vriendin/i,
    // LET OP: dit ontwerp is LINKS uitgelijnd (xMm per regel), i.t.t. alle
    // andere ontwerpen hierboven die gecentreerd zijn. Geen hartje. Het
    // lijntje onder de titel (ontwerp.lijn) volgt de hoofdtekst-kleur.
    lettertypeBestanden: { bold: 'BodoniModa-Bold.ttf', regular: 'BodoniModa-Regular.ttf', italic: 'PlayfairDisplay-MediumItalic.ttf' },
    lettertypeTerugval: { bold: StandardFonts.TimesRomanBold, regular: StandardFonts.TimesRoman, italic: StandardFonts.TimesRomanItalic },
    regels: [
      { tekst: 'Beste vriendin', fontStijl: 'bold', puntgrootteMm: 10.00, topMm: 20.76, xMm: 11.07, accent: false },
      { tekst: 'zelfstandig naamwoord', fontStijl: 'regular', puntgrootteMm: 3.95, topMm: 36.08, xMm: 10.91, accent: false },
      { tekst: '1. Samen lachen tot het gênant wordt', fontStijl: 'italic', puntgrootteMm: 3.53, topMm: 51.04, xMm: 11.07, accent: false },
      { tekst: '2. Ongevraagd eerlijk', fontStijl: 'italic', puntgrootteMm: 3.53, topMm: 58.09, xMm: 11.07, accent: false },
      { tekst: '3. De zus die ik zelf mocht kiezen', fontStijl: 'italic', puntgrootteMm: 3.53, topMm: 65.15, xMm: 11.07, accent: false },
      { tekst: '4. Altijd samen, nooit saai', fontStijl: 'italic', puntgrootteMm: 3.53, topMm: 72.21, xMm: 11.07, accent: false },
      { tekst: '5. Je privé-psycholoog zonder diploma', fontStijl: 'italic', puntgrootteMm: 3.53, topMm: 79.26, xMm: 11.07, accent: false }
    ],
    lijn: { xMm: 11.07, topMm: 31.45, breedteMm: 72.90, hoogteMm: 0.56 }
  },
  {
    id: 'in-dit-huis-plassen-we-zittend',
    // Titel in Shopify: "Tegeltje met tekst – In dit huis plassen we zittend, bedankt."
    herken: /plassen.*zittend/i,
    // Zelfde lettertype als de andere Blastered-ontwerpen (Oma/Opa & Oma/
    // Liefde), maar LINKS uitgelijnd (xMm per regel) i.p.v. gecentreerd — en
    // geen hartje (net als "Beste vriendin met definitie").
    lettertypeBestanden: { regular: 'Blastered-Regular.otf' },
    lettertypeTerugval: { regular: StandardFonts.HelveticaBold },
    regels: [
      { tekst: 'IN DIT HUIS', fontStijl: 'regular', puntgrootteMm: 16.71, topMm: 15.24, xMm: 13.16, accent: false },
      { tekst: 'PLASSEN WE', fontStijl: 'regular', puntgrootteMm: 16.71, topMm: 33.98, xMm: 13.16, accent: false },
      { tekst: 'ZITTEND,', fontStijl: 'regular', puntgrootteMm: 16.71, topMm: 52.73, xMm: 13.16, accent: false },
      { tekst: 'BEDANKT.', fontStijl: 'regular', puntgrootteMm: 16.71, topMm: 71.48, xMm: 13.16, accent: false }
    ]
  },
  {
    id: 'opa-met-definitie',
    // Titel in Shopify: "Tegeltje met Tekst - Opa met definitie."
    // LET OP: specifiek genoeg om NIET de "Altijd fijn om bij Opa & Oma"-
    // titel te matchen (die bevat ook "Opa") — vereist expliciet "met
    // definitie" direct na "Opa".
    herken: /\bopa\s+met\s+definitie/i,
    // Zelfde woordenboek-stijl als "Beste vriendin met definitie" — titel in
    // Bodoni Moda Bold, de rest (ondertitel + genummerde lijst) in Bodoni
    // Moda Regular. LET OP: het referentiebestand had de genummerde lijst
    // technisch ingebed als "KhmerMN" (een macOS-systeemfont) — de letters
    // zien er zelf gewoon Bodoni-achtig en rechtop uit (geen Khmer-schrift),
    // dus dit is vrijwel zeker een verkeerd-geëxporteerde fallback in het
    // originele bestand, niet een bewuste keuze. Aangenomen dat dit ook
    // gewoon Bodoni Moda Regular moet zijn (i.p.v. Playfair Display Medium
    // Italic zoals bij "Beste vriendin" — deze lijst is namelijk rechtop,
    // niet cursief). Corrigeer dit als dat toch niet klopt.
    lettertypeBestanden: { bold: 'BodoniModa-Bold.ttf', regular: 'BodoniModa-Regular.ttf' },
    lettertypeTerugval: { bold: StandardFonts.TimesRomanBold, regular: StandardFonts.TimesRoman },
    regels: [
      { tekst: 'Opa', fontStijl: 'bold', puntgrootteMm: 11.88, topMm: 31.97, xMm: 8.97, accent: false },
      { tekst: "[de; meervoud: opa's]", fontStijl: 'regular', puntgrootteMm: 4.18, topMm: 48.73, xMm: 8.80, accent: false },
      { tekst: '1. Officiele expert in verhalen die altijd', fontStijl: 'regular', puntgrootteMm: 3.70, topMm: 60.92, xMm: 8.66, accent: false },
      { tekst: 'beginnen met "vroeger..."', fontStijl: 'regular', puntgrootteMm: 3.70, topMm: 65.36, xMm: 8.66, accent: false },
      { tekst: '2. Professioneel knuffelaar met een hart van goud..', fontStijl: 'regular', puntgrootteMm: 3.70, topMm: 69.80, xMm: 8.66, accent: false },
      { tekst: '3. Geheim wapen tegen honger: altijd koekjes in de buurt.', fontStijl: 'regular', puntgrootteMm: 3.70, topMm: 74.24, xMm: 8.66, accent: false },
      { tekst: '4. Combineert wijsheid met een ondeugende glimlach.', fontStijl: 'regular', puntgrootteMm: 3.70, topMm: 78.69, xMm: 8.66, accent: false }
    ],
    lijn: { xMm: 8.97, topMm: 44.26, breedteMm: 82.65, hoogteMm: 0.56 }
  }
];

function fromTopMm(topMm) {
  return (PAGE_H_MM - topMm) * MM;
}

// Herkent of een productregel een "Tegeltje met tekst"-standaardproduct is
// waar we een ontwerp voor kennen. Geeft het ontwerp terug (of null).
function matchTegelTekstOntwerp(li) {
  const titel = li.title || '';
  if (!/tegeltje met tekst/i.test(titel)) return null;
  return TEGEL_TEKST_ONTWERPEN.find(o => o.herken.test(titel)) || null;
}

function isTegelTekstLineItem(li) {
  return matchTegelTekstOntwerp(li) !== null;
}

// Haalt de gekozen tegelkleur uit de Shopify-variant (bv. "Beige / Houten-
// houder" -> "Beige") — dezelfde plek (variant_title) als bij de andere
// tegel-/frame-producten in dit project.
function extractTegelKleur(li) {
  const variantTitle = li.variant_title || '';
  const eersteDeel = variantTitle.split('/')[0].trim();
  return eersteDeel || null;
}

function extractTegelTekstData(li) {
  const ontwerp = matchTegelTekstOntwerp(li);
  const kleur = extractTegelKleur(li);
  return { ontwerp, kleur };
}

// Zoekt in een volledige (raw) Shopify-order naar "Tegeltje met tekst"-
// productregels met een bekend ontwerp, en geeft voor elk besteld exemplaar
// (quantity) een los item terug.
function extractTegelTekstItemsFromOrder(rawOrder) {
  const items = [];
  (rawOrder.line_items || []).forEach(li => {
    const ontwerp = matchTegelTekstOntwerp(li);
    if (!ontwerp) return;
    const kleur = extractTegelKleur(li);
    const qty = li.quantity && li.quantity > 0 ? li.quantity : 1;
    for (let i = 0; i < qty; i++) {
      items.push({ title: li.title, kleur, data: { ontwerp, kleur } });
    }
  });
  return items;
}

// Laadt alle lettertype-stijlen die een ontwerp nodig heeft, met per stijl
// een terugval op een ingebouwd PDF-lettertype als het echte bestand
// ontbreekt in server/fonts/.
async function laadLettertypen(doc, ontwerp) {
  const fonts = {};
  for (const stijl of Object.keys(ontwerp.lettertypeBestanden || {})) {
    const bestandsnaam = ontwerp.lettertypeBestanden[stijl];
    const bestandsPad = path.join(__dirname, 'fonts', bestandsnaam);
    if (fs.existsSync(bestandsPad)) {
      fonts[stijl] = await doc.embedFont(fs.readFileSync(bestandsPad));
    } else {
      console.warn(`[texttile] ${bestandsnaam} niet gevonden in server/fonts/ — val terug op een ingebouwd PDF-lettertype. Zie README voor hoe je het echte lettertypebestand toevoegt.`);
      fonts[stijl] = await doc.embedFont(ontwerp.lettertypeTerugval[stijl] || StandardFonts.Helvetica);
    }
  }
  return fonts;
}

// Tekent het hart-icoon van een ontwerp — ondersteunt 2 opslag-eenheden
// (zie de toelichting bij TEGEL_TEKST_ONTWERPEN hierboven).
function drawHart(page, hart) {
  if (hart.eenheid === 'pdf-punten') {
    page.drawSvgPath(hart.pad, {
      x: hart.ankerXMm * MM,
      y: fromTopMm(hart.ankerTopMm),
      scale: 1, // staat al in PDF-punten, geen mm-omrekening nodig
      color: hart.kleur
    });
  } else {
    // 'genormaliseerd': eigen eenheden met een gedocumenteerde breedteMm,
    // herschaald met de experimenteel bepaalde factor.
    const hartBreedteMm = hart.breedteMm * hart.schaal;
    const hartXMm = (PAGE_W_MM - hartBreedteMm) / 2;
    page.drawSvgPath(hart.pad, {
      x: hartXMm * MM,
      y: fromTopMm(hart.topMm),
      scale: hart.schaal,
      color: hart.kleur
    });
  }
}

async function generateTegelTekstPdf(data) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([PAGE_W_MM * MM, PAGE_H_MM * MM]);

  const ontwerp = data.ontwerp;
  if (!ontwerp) {
    throw new Error('Geen bekend tekst-ontwerp meegegeven aan generateTegelTekstPdf.');
  }

  const fonts = await laadLettertypen(doc, ontwerp);

  // --- Hoofdtekst-kleur: zwart bij Wit/Beige, wit bij alle andere tegel-
  // kleuren (bevestigd met de opdrachtgever). Regels met accent:true zijn
  // hier bewust NIET van afhankelijk — die houden altijd hun eigen vaste
  // accentkleur (per regel meegegeven). ---
  const kleurNaam = (data.kleur || '').toLowerCase();
  const hoofdtekstKleur = LICHTE_TEGELKLEUREN.some(k => kleurNaam.includes(k)) ? COLOR_BLACK : COLOR_WHITE;

  (ontwerp.regels || []).forEach(regel => {
    const font = fonts[regel.fontStijl];
    const kleur = regel.accent ? (regel.accentKleur || (ontwerp.hart && ontwerp.hart.kleur)) : hoofdtekstKleur;
    const sizePt = regel.puntgrootteMm * MM;
    // Standaard gecentreerd (zoals alle eerdere ontwerpen) — tenzij de regel
    // een eigen xMm meegeeft, dan links uitgelijnd vanaf die positie (nodig
    // voor ontwerpen zoals "Beste vriendin", die links uitgelijnd zijn).
    let xPt;
    if (regel.xMm !== undefined) {
      xPt = regel.xMm * MM;
    } else {
      const textWidthPt = font.widthOfTextAtSize(regel.tekst, sizePt);
      xPt = (PAGE_W_MM * MM - textWidthPt) / 2;
    }
    page.drawText(regel.tekst, {
      x: xPt,
      y: fromTopMm(regel.topMm) - sizePt * 0.75, // tekst-baseline t.o.v. de top van de tekstregel (empirisch bepaald, zie opmeet-sessie)
      size: sizePt,
      font,
      color: kleur
    });
  });

  // --- Lijn (optioneel, bv. bij "Beste vriendin" onder de titel) — volgt
  // ALTIJD de hoofdtekst-kleur (geen aparte accentkleur-optie nodig, is in
  // het referentiebestand ook gewoon dezelfde kleur als de tekst). ---
  if (ontwerp.lijn) {
    const lijn = ontwerp.lijn;
    page.drawRectangle({
      x: lijn.xMm * MM,
      y: fromTopMm(lijn.topMm + lijn.hoogteMm),
      width: lijn.breedteMm * MM,
      height: lijn.hoogteMm * MM,
      color: hoofdtekstKleur
    });
  }

  // --- Hartje (optioneel — sommige ontwerpen, zoals "Beste vriendin",
  // hebben er geen). Meestal een eigen, vaste kleur (ongeacht tegelkleur) —
  // tenzij het ontwerp zelf aangeeft dat het hartje de hoofdtekst-kleur moet
  // volgen (volgtHoofdtekstkleur: true), bv. om te voorkomen dat een zwart
  // hartje onzichtbaar wordt op een zwarte tegel. ---
  if (ontwerp.hart) {
    const hartKleur = ontwerp.hart.volgtHoofdtekstkleur ? hoofdtekstKleur : ontwerp.hart.kleur;
    drawHart(page, { ...ontwerp.hart, kleur: hartKleur });
  }

  return doc.save();
}

module.exports = {
  generateTegelTekstPdf, isTegelTekstLineItem, matchTegelTekstOntwerp,
  extractTegelKleur, extractTegelTekstData, extractTegelTekstItemsFromOrder,
  TEGEL_TEKST_ONTWERPEN, LICHTE_TEGELKLEUREN
};
