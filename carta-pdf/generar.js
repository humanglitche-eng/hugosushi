/* Genera carta-hugo-sushi.pdf con el catálogo VIVO de la API.

     node generar.js            → carta-hugo-sushi.pdf al lado de este archivo
     node generar.js otra.pdf   → con otro nombre

   Necesita `playwright-core` y un Chromium de Playwright instalado
   (`npx playwright install chromium`). Si playwright-core no está en el
   proyecto, sirve el de la caché de npx con NODE_PATH.

   Volver a correrlo es la forma de actualizar la carta: el dueño cambia
   precios o platos desde su panel y el PDF nuevo ya los trae. */
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { console.error('Falta playwright-core: npm i playwright-core (o NODE_PATH a uno instalado).'); process.exit(1); }

const API = 'https://api.hg-vl.com/v1/hugo/catalogo';
const salida = path.resolve(__dirname, process.argv[2] || 'carta-hugo-sushi.pdf');

(async () => {
  const r = await fetch(API, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('la API contestó ' + r.status);
  const { items } = await r.json();
  if (!Array.isArray(items) || !items.length) throw new Error('la API devolvió la carta vacía: no se genera nada');

  const br = await chromium.launch();
  const pg = await br.newPage();
  const errores = [];
  pg.on('pageerror', (e) => errores.push(e.message));
  await pg.addInitScript((c) => { window.CARTA = c; }, items);
  await pg.goto('file://' + path.join(__dirname, 'carta.html'), { waitUntil: 'networkidle' });
  // Las tipografías y todas las fotos tienen que estar antes de imprimir.
  await pg.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => i.complete ? null : new Promise((ok) => { i.onload = i.onerror = ok; })));
  });
  const rotas = await pg.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')));
  await pg.pdf({ path: salida, format: 'A4', printBackground: true, preferCSSPageSize: true });
  await br.close();

  if (errores.length) console.warn('Errores en la página:', errores);
  if (rotas.length) console.warn('Fotos que no cargaron:', rotas);
  console.log(`${items.length} platos → ${salida}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
