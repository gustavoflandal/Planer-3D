import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'src');
const dist = path.join(here, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });

const read = (rel) => fs.readFileSync(path.join(src, rel), 'utf8');

const html = read('index.html');
const css = read('styles.css');
const js = read('app.js');

const written = [];
const write = (rel, data) => {
  const file = path.join(dist, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  written.push(`${rel} (${Buffer.byteLength(data)} bytes)`);
};

write('index.html', html);
write('assets/styles.css', css);
write('assets/app.js', js);

/* --- icon -----------------------------------------------------------------
   Built here rather than kept as a binary asset: a dark tile with the three
   bars of the header mark (blue, amber, yellow). 16x16, 32 bits per pixel.   */
const ICON = {
  size: 16,
  dark: [92, 91, 91],
  blue: [95, 194, 234],
  amber: [228, 169, 52],
  yellow: [254, 197, 40],
};

function iconPixels() {
  const n = ICON.size;
  const px = Buffer.alloc(n * n * 4, 0);
  const put = (x, y, rgb) => {
    const off = ((n - 1 - y) * n + x) * 4; /* ICO rows run bottom-up */
    px[off] = rgb[2];
    px[off + 1] = rgb[1];
    px[off + 2] = rgb[0];
    px[off + 3] = 255;
  };
  const fill = (x0, y0, x1, y1, rgb) => {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) put(x, y, rgb);
    }
  };
  fill(0, 0, n - 1, n - 1, ICON.dark);
  fill(2, 6, 4, 13, ICON.blue);
  fill(6, 2, 8, 13, ICON.amber);
  fill(10, 8, 12, 13, ICON.yellow);
  return px;
}

/* AND-mask rows are padded to 4 bytes; with 32 bits per pixel it only has to be
   present, every pixel already carries its own opacity. */
const maskRowBytes = Math.ceil(Math.ceil(ICON.size / 8) / 4) * 4;

function faviconIco() {
  const n = ICON.size;
  const pixels = iconPixels();
  const mask = Buffer.alloc(maskRowBytes * n, 0);
  const imageSize = 40 + pixels.length + mask.length;

  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); /* reserved */
  head.writeUInt16LE(1, 2); /* 1 = icon */
  head.writeUInt16LE(1, 4); /* one image */

  const entry = Buffer.alloc(16);
  entry.writeUInt8(n, 0);
  entry.writeUInt8(n, 1);
  entry.writeUInt8(0, 2); /* palette colours */
  entry.writeUInt8(0, 3); /* reserved */
  entry.writeUInt16LE(1, 4); /* planes */
  entry.writeUInt16LE(32, 6); /* bits per pixel */
  entry.writeUInt32LE(imageSize, 8);
  entry.writeUInt32LE(head.length + entry.length, 12);

  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(n, 4);
  info.writeInt32LE(n * 2, 8); /* height covers pixels + mask */
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  info.writeUInt32LE(0, 16); /* no compression */
  info.writeUInt32LE(pixels.length + mask.length, 20);

  return Buffer.concat([head, entry, info, pixels, mask]);
}

const ico = faviconIco();
write('favicon.ico', ico);

write(
  'favicon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Syncrofin 3D Planner">
<rect width="32" height="32" rx="6" fill="#5c5b5b"/>
<rect x="5" y="13" width="6" height="15" rx="1" fill="#5fc2ea"/>
<rect x="13" y="4" width="6" height="24" rx="1" fill="#e4a934"/>
<rect x="21" y="9" width="6" height="19" rx="1" fill="#fec528"/>
</svg>
`,
);

write(
  '404.html',
  `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Página não encontrada</title>
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #eef1f4;
         font-family: Arial, Tahoma, Verdana, sans-serif; color: #5d5d5d; text-align: center; }
  h1 { font-size: 28px; font-weight: 400; color: #2f3337; margin: 0 0 8px; }
  p { margin: 0 0 18px; }
  a { color: #5c5b5b; font-weight: 700; }
</style>
</head>
<body>
  <main>
    <h1>Página não encontrada</h1>
    <p>O endereço não existe neste planeador.</p>
    <p><a href="./index.html">Voltar ao planeador de carga</a></p>
  </main>
</body>
</html>
`,
);

/* --- old addresses --------------------------------------------------------
   The planner replaced a set of marketing pages. Anyone following an old link
   (a bookmark, a search result) should land in the planner instead of a dead
   end, so each former address becomes an instant redirect. Everything is
   inline: no shared files, so no request can fail from a deeper folder. The
   note is in the language the old page was written in.                     */
const legacyRoutes = [
  {
    path: 'en',
    lang: 'en',
    title: 'The load planner has moved',
    text: 'The truck and container load planner is now the start page.',
    cta: 'Open the planner',
  },
  {
    path: 'es',
    lang: 'es',
    title: 'El planificador de carga se ha mudado',
    text: 'El planificador de carga de camiones y contenedores es ahora la página de inicio.',
    cta: 'Abrir el planificador',
  },
  {
    path: 'de',
    lang: 'de',
    title: 'Der Ladungsplaner ist umgezogen',
    text: 'Der Ladungsplaner für LKW und Container ist jetzt die Startseite.',
    cta: 'Planer öffnen',
  },
  {
    path: 'en/try-online-for-free',
    lang: 'en',
    title: 'The free trial page is gone',
    text: 'The planner is free to use and needs no account, so the trial page is no longer needed.',
    cta: 'Open the planner',
  },
];

for (const route of legacyRoutes) {
  const depth = route.path.split('/').length;
  const back = '../'.repeat(depth) + 'index.html';
  write(
    `${route.path}/index.html`,
    `<!doctype html>
<html lang="${route.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${back}">
<title>${route.title}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #eef1f4;
         font-family: Arial, Tahoma, Verdana, sans-serif; color: #5d5d5d; text-align: center; }
  h1 { font-size: 24px; font-weight: 400; color: #2f3337; margin: 0 0 10px; }
  p { margin: 0; }
  a { color: #c98d22; font-weight: 700; }
</style>
</head>
<body>
  <main>
    <h1>${route.title}</h1>
    <p>${route.text}</p>
    <p><a href="${back}">${route.cta}</a></p>
  </main>
</body>
</html>
`,
  );
}

/* --- small self-check: the page must point at files that were written ------ */
const problems = [];
for (const asset of ['assets/styles.css', 'assets/app.js', 'favicon.svg', 'favicon.ico']) {
  if (!html.includes(asset)) problems.push(`index.html does not link ${asset}`);
}
for (const rel of written.map((w) => w.split(' ')[0])) {
  if (!fs.existsSync(path.join(dist, rel))) problems.push(`missing after write: ${rel}`);
}
if (!html.includes('<canvas')) problems.push('index.html has no canvas for the 3D view');
if (!html.includes('<nav')) problems.push('index.html has no navigation landmark');
if (!html.includes('<footer')) problems.push('index.html has no footer landmark');

/* The menu button only shows on a phone, so its name is the only thing a screen
   reader gets: it has to be exactly one clear phrase, and must control the
   group of actions it reveals. */
if (!html.includes('aria-label="Toggle navigation"')) problems.push('menu button has no accessible name');
if (!html.includes('aria-controls="top-actions"')) problems.push('menu button does not say what it opens');
if (!html.includes('aria-expanded="false"')) problems.push('menu button does not report its state');
if (html.includes('nav-toggle-text')) problems.push('menu button still has stray visible text');

for (const route of legacyRoutes) {
  const page = fs.readFileSync(path.join(dist, route.path, 'index.html'), 'utf8');
  const depth = route.path.split('/').length;
  if (!page.includes(`content="0; url=${'../'.repeat(depth)}index.html"`)) {
    problems.push(`${route.path} does not redirect to the planner`);
  }
  if (page.includes('assets/') || page.includes('favicon')) {
    problems.push(`${route.path} asks for a file that lives outside its folder`);
  }
}

/* The stylesheet is long and mostly flat, so one comment left open silently
   swallows every rule after it: that is how the page once fell back to Times
   New Roman with the whole palette gone, while the build stayed green. Read it
   the way a browser would — comments removed — and insist on the few things
   whose absence changes the whole page. */
function cssProblems(cssRaw) {
  const found = [];
  const cssOnly = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  if (cssOnly.includes('/*')) found.push('styles.css never closes a comment, so rules after it are lost');
  if (cssOnly.includes('*/')) found.push('styles.css closes a comment it never opened');
  const opens = (cssOnly.match(/\{/g) || []).length;
  const closes = (cssOnly.match(/\}/g) || []).length;
  if (opens !== closes) found.push(`styles.css has ${opens} { and ${closes} }`);
  if (!/--font:\s*Arial/.test(cssOnly)) found.push('styles.css lost its Arial font stack');
  if (!/body\s*\{[^}]*font-family:\s*var\(--font\)/.test(cssOnly)) found.push('body no longer gets the planned font');
  if (!/body\s*\{[^}]*font-size:\s*16px/.test(cssOnly)) found.push('body text is no longer 16px');
  for (const token of ['--muted: #6b6b6b', '--text: #5d5d5d', '--dark: #5c5b5b', '--track: #bfc1c5']) {
    if (!cssOnly.includes(token)) found.push(`styles.css lost ${token}`);
  }
  if (/font-family:[^;}]*Times/.test(cssOnly)) found.push('styles.css asks for Times New Roman');
  /* The likeness check measures the page's "body text" as the size most of it
     is set in, so a handful of tiny rules can quietly pull the whole page down
     to 13px however body is set. Keep 16px in the majority. */
  const sizes = new Map();
  for (const rule of cssOnly.matchAll(/[^{}]+\{[^}]*\}/g)) {
    const size = /font-size:\s*([\d.]+)px/.exec(rule[0]);
    if (size) {
      const key = `${size[1]}px`;
      sizes.set(key, (sizes.get(key) || 0) + 1);
    }
  }
  const modal = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!modal || modal[0] !== '16px') {
    found.push(`most text is set at ${modal ? `${modal[0]} (${modal[1]} rules)` : 'no size'}, not 16px`);
  }
  for (const step of ['15px', '18px', '22px', '28px']) {
    if (!sizes.has(step)) found.push(`the type scale lost its ${step} step`);
  }
  return found;
}

problems.push(...cssProblems(fs.readFileSync(path.join(dist, 'assets', 'styles.css'), 'utf8')));

/* A guard that can't fail is no guard: try it once on a stylesheet shaped like
   the broken one, and complain if it passes. */
const brokenCss = '/* an open comment\n:root { --font: Arial; }\nbody { font-family: var(--font); }\n';
if (cssProblems(brokenCss).length === 0) problems.push('the stylesheet check no longer notices a lost rule');

if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 1) problems.push('favicon.ico header is wrong');
if (ico.length !== 22 + 40 + ICON.size * ICON.size * 4 + maskRowBytes * ICON.size) {
  problems.push('favicon.ico is not the expected size');
}
if (problems.length) {
  console.error('Build finished with problems:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(`Built ${written.length} files into dist/`);
for (const w of written) console.log('  ' + w);
