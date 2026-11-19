/* Smoke test: run src/app.js in a fake browser so a runtime error in the
   planner, the packer or the canvas drawing is caught before shipping.
   `node tools/smoke.mjs` — exits non-zero when the app throws. */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcFile = (name) => fs.readFileSync(path.join(here, '..', 'src', name), 'utf8');
/* the page loads these three, in this order */
const SCRIPTS = ['spaces.js', 'loadplan.js', 'lashing.js', 'app.js', 'spaces-ui.js', 'pdfwriter.js', 'loaddoc.js'];

const log = { fills: 0, strokes: 0, moves: 0 };

function ctx2d() {
  const noop = () => {};
  return {
    setTransform: noop,
    clearRect: noop,
    fillRect: () => { log.fills++; },
    strokeRect: () => { log.strokes++; },
    beginPath: noop,
    moveTo: () => { log.moves++; },
    lineTo: noop,
    closePath: noop,
    fill: () => { log.fills++; },
    stroke: () => { log.strokes++; },
    fillText: noop,
    save: noop,
    restore: noop,
    clip: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    set fillStyle(v) {},
    set strokeStyle(v) {},
    set lineWidth(v) {},
    set font(v) {},
    set textAlign(v) {},
    set globalAlpha(v) {}
  };
}

function node(tag = 'div') {
  const attrs = new Map();
  const classes = new Set();
  const on = {};
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    className: '',
    textContent: '',
    _html: '',
    value: '',
    width: 0,
    height: 0,
    hidden: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c))
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    addEventListener: (type, fn) => {
      (on[type] = on[type] || []).push(fn);
    },
    fire: (type, event) => {
      const base = { target: el, preventDefault: () => {}, pointerId: 1, clientX: 0, clientY: 0 };
      (on[type] || []).forEach((fn) => fn(Object.assign(base, event || {})));
    },
    focus: () => {},
    click: () => el.fire('click'),
    appendChild(child) { this.children.push(child); return child; },
    querySelector: () => node('span'),
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ width: 900, height: 600, left: 0, top: 0 }),
    getContext: () => ctx2d()
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = v; if (v === '') this.children = []; }
  });
  return el;
}

const ids = [
  '#view', '#axle-view', '#items', '#empty', '#cargo-count', '#item-form', '#form-msg',
  '#f-name', '#f-l', '#f-w', '#f-h', '#f-weight', '#f-qty', '#f-color', '#f-dest', '#f-orient', '#f-fragile', '#f-maxtop',
  '#axle-problems', '#axle-stops',
  '#plan', '#demo', '#clear', '#report', '#status', '#vehicle-dims',
  '#axle-list', '#axle-cog', '#nav-toggle', '#topbar', '#import', '#import-file', '#template',
  '#compare', '#compare-panel', '#compare-reco', '#compare-table', '#compare-fav', '#compare-run', '#compare-close'
];
const elements = {};
for (const id of ids) {
  elements[id] = node(id === '#view' || id === '#axle-view' ? 'canvas' : 'div');
}

elements['#f-name'].value = 'Caixa de teste';
elements['#f-l'].value = '1200';
elements['#f-w'].value = '800';
elements['#f-h'].value = '1000';
elements['#f-weight'].value = '150';
elements['#f-qty'].value = '8';
elements['#f-color'].value = 'blue';
elements['#f-dest'].value = 'Grupo 1';

const viewButtons = ['3d', 'top', 'side', 'left', 'right'].map((v) => {
  const b = node('button');
  b.dataset.view = v;
  return b;
});

const gauges = ['volume', 'weight', 'area', 'linear'].map((name) => {
  const g = node('div');
  g.dataset.gauge = name;
  g.barFill = node('i');
  g.valueEl = node('b');
  g.querySelector = (sel) => (sel === '.bar i' ? g.barFill : g.valueEl);
  return g;
});

const document = {
  readyState: 'complete',
  querySelector: (sel) => elements[sel] || null,
  querySelectorAll: (sel) => {
    if (sel === '[data-view]') return viewButtons;
    if (sel === '[data-gauge]') return gauges;
    return [];
  },
  createElement: (tag) => node(tag),
  addEventListener: () => {}
};

const store = new Map();
const window = {
  devicePixelRatio: 1,
  addEventListener: () => {},
  clearTimeout,
  setTimeout,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k)
  },
  ResizeObserver: null
};

const sandbox = {
  window, document, console, Math, JSON, parseInt, parseFloat, isFinite, Array, Object, String, Number,
  TextDecoder, Blob, Response, DecompressionStream
};
sandbox.window.document = document;

vm.createContext(sandbox);
for (const name of SCRIPTS) {
  try {
    vm.runInContext(srcFile(name), sandbox, { filename: name });
  } catch (err) {
    console.error(name + ' threw: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  }
}
const Spaces = window.SyncrofinSpaces;

const checks = [];
const canvas = elements['#view'];
checks.push(['canvas sized', canvas.width > 0 && canvas.height > 0]);
checks.push(['3D drawing happened', log.fills > 3 && log.strokes > 0]);
checks.push(['catalogue loaded', Spaces.all().length === 24 && Spaces.cargoSpaces().length === 20 && Spaces.tractors().length === 4]);
checks.push(['default is the semitrailer with a tractor', String(elements['#vehicle-dims'].textContent).startsWith('Semirreboque 13,6 m + Cavalo padrão')]);
checks.push(['cargo rows rendered', elements['#items'].children.length > 0]);
checks.push(['status written', String(elements['#status'].textContent).length > 5]);
checks.push(['dimensions written', String(elements['#vehicle-dims'].textContent).includes('mm')]);
checks.push([
  'volume gauge filled',
  gauges[0].barFill.style.width && /%$/.test(gauges[0].barFill.style.width)
]);
checks.push(['weight gauge filled', /%$/.test(gauges[1].barFill.style.width || '')]);
checks.push(['every demo box fitted', String(elements['#status'].textContent).includes('Tudo colocado')]);
checks.push(['volume gauge above 20%', parseFloat(gauges[0].barFill.style.width) > 20]);

/* The axle panel must mirror the lever rule: the loads on the axles add up to
   the cargo's own weight plus the tare of the semitrailer and its tractor (the
   kingpin row only reports what the tractor already carries), and the
   destination field must split the item list into the groups the demo items
   declare. */
const digits = (s) => parseInt(String(s).replace(/[^0-9]/g, '') || '0', 10);
/* one row per axle (and the kingpin); group rows come after them */
const axleRows = elements['#axle-list'].children.filter((li) => !/\bgroup\b/.test(li.className));
const groupRows = elements['#axle-list'].children.filter((li) => /\bgroup\b/.test(li.className));
const axleLoads = axleRows.filter((li) => !/\binfo\b/.test(li.className)).map((li) => {
  const val = li.children[2];
  return val ? digits(val.textContent) : 0;
});
const axleSum = axleLoads.reduce((a, b) => a + b, 0);
const tareOf = (s) => s.axles.reduce((t, a) => t + a.tare, 0);
const tare = tareOf(Spaces.get('semi')) + tareOf(Spaces.get('tractor42'));
const cargoWeight = elements['#items'].children.reduce((sum, li) => {
  if (li.className !== 'item-row') return sum;
  const btn = li.children[0];
  const meta = btn && btn.children[1] && btn.children[1].children[1];
  if (!meta) return sum;
  const parts = String(meta.textContent).split('·');
  return sum + (parts[1] ? digits(parts[1]) : 0) * (parts[2] ? digits(parts[2]) : 0);
}, 0);

checks.push(['axle list: 2 tractor axles, kingpin, 3 trailer axles', axleRows.length === 6 && axleLoads.length === 5 &&
  axleRows.filter((li) => /\binfo\b/.test(li.className)).length === 1]);
checks.push(['axle loads sum to cargo + tare', Math.abs(axleSum - (cargoWeight + tare)) <= 6]);
checks.push(['axle-cog written', String(elements['#axle-cog'].textContent).includes('Centro de gravidade')]);
checks.push(['semitrailer axle group listed with its limit', groupRows.length === 1 &&
  /25\s?500/.test(groupRows[0].children[3].textContent)]);
const heads = elements['#items'].children.filter((li) => li.className === 'group-head');
checks.push([
  'destinations listed as numbered deliveries with reorder buttons',
  heads.length === 2 && heads[0].children[0].textContent === 'Entrega 1 · FruitPlanet Corp' &&
    heads[1].children[0].textContent === 'Entrega 2 · Grupo 1' && heads[0].children.length === 3
]);
checks.push(['problem list says the axles are within limits after each delivery',
  elements['#axle-problems'].children.length === 1 && /depois de cada entrega/.test(elements['#axle-problems'].children[0].textContent)]);
checks.push(['delivery table: departure and after delivery 1', !elements['#axle-stops'].hidden &&
  elements['#axle-stops'].children[0].children.length === 4]);
checks.push(['linear gauge in metres', /m$/.test(gauges[3].valueEl.textContent || '')]);

/* The menu button only exists on narrow screens, but its wiring must be sound:
   a click has to open the menu and mark it expanded, a second click has to shut
   it again. */
const toggle = elements['#nav-toggle'];
const bar = elements['#topbar'];
toggle.fire('click');
const opened = toggle.getAttribute('aria-expanded') === 'true' && bar.classList.contains('menu-open');
toggle.fire('click');
const closed = toggle.getAttribute('aria-expanded') === 'false' && !bar.classList.contains('menu-open');
checks.push(['menu button opens and closes', opened && closed]);

/* Pressing an action must leave the menu shut behind it. */
toggle.fire('click');
elements['#plan'].fire('click');
checks.push(['planning closes the menu', !bar.classList.contains('menu-open')]);

/* Spreadsheet import: numbers as Excel writes them in any locale, CSV with and
   without a header, units in the header, and a real .xlsx workbook built here
   with zlib, read back through the same path the browser uses. */
const imp = window.SyncrofinImport;
const semi = { name: 'Semirreboque 13,6 m', l: 13600, w: 2450, h: 2700 };
const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));

function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

const xlsx = zip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Carga" sheetId="1" r:id="rId7"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId7" Type="worksheet" Target="worksheets/folha.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Descrição</t></si><si><t>Comprimento (mm)</t></si><si><t>Largura (mm)</t></si><si><t>Altura (mm)</t></si><si><t>Peso (kg)</t></si><si><t>Quantidade</t></si><si><t>Destino</t></si><si><r><t xml:space="preserve">Palete </t></r><r><t>EUR &amp; Cia</t></r></si><si><t>Loja Norte</t></si></sst>',
  'xl/worksheets/folha.xml': '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c><c r="G1" t="s"><v>6</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>7</v></c><c r="B2"><v>1200</v></c><c r="C2"><v>800</v></c><c r="D2"><v>1450</v></c><c r="E2"><v>420.5</v></c><c r="F2"><v>12</v></c><c r="G2" t="s"><v>8</v></c></row>' +
    '<row r="4"><c r="A4" t="inlineStr"><is><t>Caixa</t></is></c><c r="B4"><v>600</v></c><c r="C4"><v>400</v></c><c r="D4"><v>400</v></c><c r="F4"><v>20</v></c></row>' +
    '<row r="5"><c r="A5" t="inlineStr"><is><t>Sem medidas</t></is></c></row>' +
    '</sheetData></worksheet>'
});

async function importChecks() {
  const out = [];
  out.push(['numbers: 1.200,5', imp.parseNumber('1.200,5') === 1200.5]);
  out.push(['numbers: 1,200.5', imp.parseNumber('1,200.5') === 1200.5]);
  out.push(['numbers: 1.200 and 12,5', imp.parseNumber('1.200') === 1200 && imp.parseNumber('12,5') === 12.5]);
  out.push(['numbers: 120 kg', imp.parseNumber('120 kg') === 120]);

  const csv = 'Descrição;Comprimento (cm);Largura (cm);Altura (cm);Peso total (kg);Qtd;Destino;Cor\r\n' +
    '"Caixa ""A""' + '";120;80;100;1.200,5;10;Loja 1;verde\r\n;;;;\r\nGrande;9999;80;100;1;1;;\r\n';
  const r1 = imp.rowsToItems(await imp.readSpreadsheet(enc(csv)), semi);
  const a = r1.items[0] || {};
  out.push(['csv: header, cm and total weight', r1.items.length === 1 && a.name === 'Caixa "A"' && a.l === 1200 &&
    a.w === 800 && a.h === 1000 && Math.abs(a.weight - 120.05) < 0.06 && a.qty === 10 && a.dest === 'Loja 1' && a.color === 'green']);
  out.push(['csv: oversize row skipped with its line', r1.skipped.length === 1 && r1.skipped[0].line === 4 && /não cabe/.test(r1.skipped[0].reason)]);

  const r2 = imp.rowsToItems(await imp.readSpreadsheet(enc('Palete,1200,800,1450,420,12\nCaixa,600,400,400,35,20\n')), semi);
  out.push(['csv: no header, positional', r2.items.length === 2 && r2.items[0].name === 'Palete' && r2.items[0].qty === 12 &&
    r2.items[1].l === 600 && r2.items[1].weight === 35 && r2.items[1].qty === 20]);
  const r2b = imp.rowsToItems(await imp.readSpreadsheet(enc('1000;600;500;50;3\n')), semi);
  out.push(['csv: no header, no description', r2b.items.length === 1 && r2b.items[0].l === 1000 &&
    r2b.items[0].qty === 3 && r2b.items[0].name === 'Volume 1']);

  const r3 = imp.rowsToItems(await imp.readSpreadsheet(enc('L;W;H;Qty\n1200;800;1000;2\n')), semi);
  out.push(['csv: L W H header', r3.items.length === 1 && r3.items[0].l === 1200 && r3.items[0].w === 800]);
  const r4 = imp.rowsToItems(await imp.readSpreadsheet(enc('C;L;A\n1200;800;1000\n')), semi);
  out.push(['csv: C L A header', r4.items.length === 1 && r4.items[0].l === 1200 && r4.items[0].w === 800]);

  const ansi = new Uint8Array([...Buffer.from('Descri', 'latin1'), 0xe7, 0xe3, ...Buffer.from('o;Comp;Larg;Alt\nCal', 'latin1'), 0xe7, ...Buffer.from('ado;500;400;300\n', 'latin1')]);
  const r6 = imp.rowsToItems(await imp.readSpreadsheet(ansi), semi);
  out.push(['csv: Windows-1252 accents', r6.items.length === 1 && r6.items[0].name === 'Calçado']);

  const rows = await imp.readSpreadsheet(xlsx);
  const r5 = imp.rowsToItems(rows, semi);
  const x = r5.items[0] || {};
  out.push(['xlsx: shared, rich and inline strings', r5.items.length === 2 && x.name === 'Palete EUR & Cia' &&
    x.l === 1200 && x.h === 1450 && x.weight === 420.5 && x.qty === 12 && x.dest === 'Loja Norte' &&
    r5.items[1].name === 'Caixa' && r5.items[1].qty === 20]);
  out.push(['xlsx: row without sizes skipped as line 5', r5.skipped.length === 1 && r5.skipped[0].line === 5]);

  const tpl = imp.rowsToItems(await imp.readSpreadsheet(enc('﻿' + imp.templateCsv())), semi);
  out.push(['template CSV imports back as the demo', tpl.items.length === 4 && !tpl.skipped.length &&
    tpl.items[0].name === 'Palete EUR' && tpl.items[0].color === 'blue' && tpl.items[3].color === 'orange' &&
    tpl.items[0].dest === 'FruitPlanet Corp']);
  out.push(['template CSV keeps fragile and weight on top', tpl.items[2].fragile === true && tpl.items[3].maxTop === 300 &&
    tpl.items[0].orient === 'upright' && tpl.items[0].fragile === false && tpl.items[0].maxTop === null]);
  const rules = imp.rowsToItems(imp.parseCsv('Descrição;Comp;Larg;Alt;Peso;Qtd;Pode deitar;Frágil;Peso máx. em cima (kg)\r\nTubo;3000;300;300;40;5;Sim;Não;0\r\nVidro;1000;800;600;80;2;não;sim;\r\n'), semi);
  out.push(['csv: may tip, fragile and weight on top columns', rules.items.length === 2 &&
    rules.items[0].orient === 'any' && !rules.items[0].fragile && rules.items[0].maxTop === 0 && rules.items[0].weight === 40 &&
    rules.items[1].orient === 'upright' && rules.items[1].fragile && rules.items[1].maxTop === null]);

  let oldXls = '';
  await imp.readSpreadsheet(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0])).catch((e) => { oldXls = e.message; });
  out.push(['old .xls refused with advice', /\.xlsx ou \.csv/.test(oldXls)]);

  /* the button path: choosing a file adds its rows to the list */
  const before = elements['#items'].children.length;
  const fileInput = elements['#import-file'];
  fileInput.files = [{ name: 'carga.xlsx', size: xlsx.length, arrayBuffer: async () => xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.length) }];
  fileInput.fire('change');
  for (let i = 0; i < 50 && !/Importados/.test(elements['#form-msg'].textContent); i++) await new Promise((r) => setTimeout(r, 10));
  out.push(['import button adds the rows', elements['#items'].children.length > before && /Importados 2 itens/.test(elements['#form-msg'].textContent)]);
  out.push(['import message is marked as success', elements['#form-msg'].classList.contains('ok')]);
  return out;
}

/* Cargo spaces: catalogue, validation, saving, favourites and the axle
   arithmetic, on a storage of their own so the planner's is left alone. */
function spaceChecks() {
  const out = [];
  const mem = new Map();
  const fakeStore = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  Spaces.useStorage(fakeStore);

  out.push(['19 space types', Spaces.TYPES.length === 19]);
  out.push(['4-axle types: semitrailer, bitruck, tractor', ['semi4', 'lorry4', 'truck4'].every((id) => Spaces.typeOf(id))]);
  out.push(['roles: semitrailer with 4 axles runs A to E', Spaces.roles('semi4').map((r) => r.letter).join('') === 'ABCDE']);
  out.push(['roles: bitruck steers on A and B', Spaces.roles('lorry4').map((r) => r.group).join() === 'front,front,rear,rear' &&
    Spaces.roles('lorry4')[1].label === 'Eixo dianteiro 2']);
  out.push(['roles: 3-axle trailer turns on A, tandem at the rear', Spaces.roles('trailer3').map((r) => r.group).join() === 'front,rear,rear']);
  out.push(['roles: 4-axle trailer turns on A and B', Spaces.roles('trailer4').map((r) => r.group).join() === 'front,front,rear,rear']);
  out.push(['built-in 3- and 4-axle trailers are valid', ['trailer3ax', 'trailer4ax'].every((id) => Spaces.get(id) && !Spaces.validate(Spaces.get(id)).length)]);
  out.push(['roles: semitrailer A is the kingpin', Spaces.roles('semi3').map((r) => r.letter + r.role).join() === 'Akingpin,Baxle,Caxle,Daxle']);

  const blankErrors = Spaces.validate(Spaces.blank('semi3'));
  out.push(['blank form lists what is missing', blankErrors.some((e) => e.field === 'name') && blankErrors.some((e) => e.field === 'l') &&
    blankErrors.some((e) => e.field === 'axle3.max')]);

  const good = {
    name: 'Semirreboque 135', type: 'semi3', l: 13620, w: 2480, h: 2710, payload: 24000, track: 2050,
    axles: [{ dist: 1675, tare: 1270, max: 12000 }, { dist: 7985, tare: 2004, max: 10000 },
      { dist: 9295, tare: 1660, max: 10000 }, { dist: 10605, tare: 1416, max: 10000 }]
  };
  out.push(['valid space passes', Spaces.validate(Spaces.clean(good)).length === 0]);
  const swapped = JSON.parse(JSON.stringify(good));
  swapped.axles[2].dist = 7000;
  out.push(['axles out of order refused', Spaces.validate(Spaces.clean(swapped)).some((e) => e.field === 'axle2.dist')]);
  const tractorBad = { name: 'T', type: 'truck2', payload: 18000, track: 2050, axles: [{ dist: 500, tare: 5000, max: 8000 }, { dist: 900, tare: 2500, max: 11500 }] };
  out.push(['tractor front axle must be ahead of the fifth wheel', Spaces.validate(Spaces.clean(tractorBad)).some((e) => e.field === 'axle0.dist')]);

  const saved = Spaces.save(good);
  out.push(['custom space saved', saved.ok && saved.space.origin === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(saved.space.created) &&
    Spaces.all().length === 25]);
  const id = saved.space.id;
  out.push(['custom space persisted', JSON.parse(mem.get('syncrofin.spaces.v1')).custom.length === 1]);

  out.push(['type filter: containers', Spaces.filter(Spaces.cargoSpaces(), { groups: ['container'] }).length === 3]);
  out.push(['type filter: lorries + trailers', Spaces.filter(Spaces.cargoSpaces(), { groups: ['lorry', 'trailer'] }).length === 13]);
  out.push(['type filter: vans', Spaces.filter(Spaces.cargoSpaces(), { groups: ['van'] }).length === 5]);
  out.push(['minifurgão is a valid 2-axle van', (function () {
    const m = Spaces.get('minivan');
    return !!m && m.type === 'van2' && Spaces.validate(Spaces.clean(m)).length === 0 && Spaces.roles('van2').map((r) => r.role).join() === 'front,rear';
  })()]);
  Spaces.toggleFavorite(id);
  out.push(['favourites filter', Spaces.filter(Spaces.cargoSpaces(), { favoritesOnly: true }).map((s) => s.id).sort().join() === [id, 'semi'].sort().join()]);

  const edited = Spaces.get('ct20');
  edited.payload = 21000;
  edited.id = 'ct20';
  Spaces.save(edited);
  out.push(['built-in space edited in place', Spaces.get('ct20').payload === 21000 && Spaces.get('ct20').edited && Spaces.get('ct20').origin === 'system']);
  out.push(['built-in space reset', Spaces.reset('ct20') && Spaces.get('ct20').payload === 28000 && !Spaces.get('ct20').edited]);
  out.push(['built-in space cannot be deleted', Spaces.remove('ct20') === false && !!Spaces.get('ct20')]);

  /* reload from storage: same custom space and favourite */
  Spaces.useStorage(fakeStore);
  out.push(['custom space and favourite survive a reload', !!Spaces.get(id) && Spaces.isFavorite(id)]);
  out.push(['custom space deleted', Spaces.remove(id) && !Spaces.get(id) && !Spaces.isFavorite(id)]);

  /* axle loads */
  const semi = Spaces.get('semi');
  const tractor = Spaces.get('tractor42');
  const onKingpin = Spaces.axleLoads(semi, null, { weight: 10000, cgx: semi.axles[0].dist, cgz: semi.w / 2 });
  out.push(['cargo over the kingpin rests on the kingpin', Math.abs(onKingpin.kingpin.load - (10000 + semi.axles[0].tare)) < 1 &&
    onKingpin.rows.filter((r) => r.part === 'space').every((r) => Math.abs(r.cargo) < 1)]);
  const groupX = (semi.axles[1].dist + semi.axles[2].dist + semi.axles[3].dist) / 3;
  const onGroup = Spaces.axleLoads(semi, null, { weight: 9000, cgx: groupX, cgz: semi.w / 2 });
  out.push(['cargo over the axle group is shared by its axles', Math.abs(onGroup.kingpin.cargo) < 1 &&
    onGroup.rows.filter((r) => r.part === 'space').every((r) => Math.abs(r.cargo - 3000) < 1)]);
  const withTractor = Spaces.axleLoads(semi, tractor, { weight: 12000, cgx: 5000, cgz: semi.w / 2 });
  const tRows = withTractor.rows.filter((r) => r.part === 'tractor');
  const tSum = tRows.reduce((t, r) => t + r.load, 0);
  out.push(['tractor axles carry the kingpin load plus their tare', tRows.length === 2 &&
    Math.abs(tSum - (withTractor.kingpin.load + tareOf(tractor))) < 1 && withTractor.kingpin.info === true]);
  const lean = Spaces.axleLoads(semi, null, { weight: 8000, cgx: 6000, cgz: semi.w / 2 - 300 });
  out.push(['cargo leaning left loads the left wheels', lean.leftShare > 0.6 && lean.rows.every((r) => r.left >= r.right)]);
  const lorry = Spaces.get('rigid');
  const lorryFront = Spaces.axleLoads(lorry, null, { weight: 2000, cgx: lorry.axles[0].dist, cgz: lorry.w / 2 });
  out.push(['lorry: cargo over the front axle', Math.abs(lorryFront.rows[0].cargo - 2000) < 1 && Math.abs(lorryFront.rows[1].cargo) < 1]);
  /* 4-axle types */
  const bitruck = Spaces.get('bitruck');
  const frontMid = (bitruck.axles[0].dist + bitruck.axles[1].dist) / 2;
  const bt = Spaces.axleLoads(bitruck, null, { weight: 6000, cgx: frontMid, cgz: bitruck.w / 2 });
  out.push(['bitruck: cargo over the steering pair is shared by A and B', bt.rows.length === 4 &&
    Math.abs(bt.rows[0].cargo - 3000) < 1 && Math.abs(bt.rows[1].cargo - 3000) < 1 && Math.abs(bt.rows[2].cargo) < 1]);
  const tr4 = Spaces.get('trailer4ax');
  const tr4Mid = ((tr4.axles[0].dist + tr4.axles[1].dist) / 2 + (tr4.axles[2].dist + tr4.axles[3].dist) / 2) / 2;
  const t4 = Spaces.axleLoads(tr4, null, { weight: 8000, cgx: tr4Mid, cgz: tr4.w / 2 });
  out.push(['4-axle trailer: cargo midway is shared by all four axles', t4.rows.length === 4 &&
    t4.rows.every((r) => Math.abs(r.cargo - 2000) < 1)]);
  const semi4 = Spaces.get('semi4ax');
  const s4 = Spaces.axleLoads(semi4, null, { weight: 20000, cgx: 8000, cgz: semi4.w / 2 });
  out.push(['4-axle semitrailer: kingpin + 4 axles carry cargo + tare', s4.rows.length === 5 &&
    Math.abs(s4.rows.reduce((t, r) => t + r.load, 0) - (20000 + tareOf(semi4))) < 1]);
  const t84 = Spaces.get('tractor84');
  const s4t = Spaces.axleLoads(semi4, t84, { weight: 20000, cgx: 8000, cgz: semi4.w / 2 });
  const t84Rows = s4t.rows.filter((r) => r.part === 'tractor');
  out.push(['4-axle tractor carries the kingpin on its 4 axles', t84Rows.length === 4 &&
    Math.abs(t84Rows.reduce((t, r) => t + r.load, 0) - (s4t.kingpin.load + tareOf(t84))) < 1 &&
    Math.abs(t84Rows[0].cargo - t84Rows[1].cargo) < 1 && Math.abs(t84Rows[2].cargo - t84Rows[3].cargo) < 1]);
  const t4r = Spaces.get('tractor4r');
  out.push(['1 + 3 tractor: one steering axle, a rear tridem', Spaces.roles('truck4r').map((r) => r.group).join() === 'front,rear,rear,rear' &&
    Spaces.roles('truck4r').map((r) => r.label).join() === 'Eixo dianteiro,Eixo motriz,Eixo de apoio 1,Eixo de apoio 2' &&
    !Spaces.validate(t4r).length]);
  const s4r = Spaces.axleLoads(semi4, t4r, { weight: 20000, cgx: 8000, cgz: semi4.w / 2 });
  const t4rRows = s4r.rows.filter((r) => r.part === 'tractor');
  out.push(['1 + 3 tractor carries the kingpin on its 4 axles, the tridem sharing equally', t4rRows.length === 4 &&
    Math.abs(t4rRows.reduce((t, r) => t + r.load, 0) - (s4r.kingpin.load + tareOf(t4r))) < 1 &&
    Math.abs(t4rRows[1].cargo - t4rRows[2].cargo) < 1 && Math.abs(t4rRows[2].cargo - t4rRows[3].cargo) < 1]);
  const t84bad = JSON.parse(JSON.stringify(t84));
  t84bad.axles[1].dist = 200;
  out.push(['4-axle tractor: second steering axle must be ahead of the fifth wheel',
    Spaces.validate(Spaces.clean(t84bad)).some((e) => e.field === 'axle1.dist')]);
  out.push(['built-in 4-axle spaces are valid', ['bitruck', 'semi4ax', 'tractor84'].every((id) => Spaces.validate(Spaces.get(id)).length === 0)]);

  out.push(['container has no axles of its own', Spaces.axleLoads(Spaces.get('ct40'), null, { weight: 5000, cgx: 3000, cgz: 1000 }).rows.length === 0]);
  return out;
}

/* The load plan (loadplan.js): every rule of the arranging, the statics model
   it uses while placing, the checks after each delivery, and the search. */
function planChecks() {
  const out = [];
  const P = window.SyncrofinLoadPlan;
  const semi = Spaces.get('semi');
  const t42 = Spaces.get('tractor42');
  const EPS = 0.5;
  const box = (o) => Object.assign({ id: 1, name: 'x', color: 'blue', dest: '', qty: 1 }, o);
  const overlapsXZ = (a, b) => a.x < b.x + b.l - EPS && b.x < a.x + a.l - EPS && a.z < b.z + b.w - EPS && b.z < a.z + a.w - EPS;
  const overlapsYZ = (a, b) => a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS && a.z < b.z + b.w - EPS && b.z < a.z + a.w - EPS;
  const restsOn = (top, under) => Math.abs(under.y + under.h - top.y) <= 1 && overlapsXZ(top, under);

  /* rotations */
  out.push(['this side up: only turned about the vertical', P.orientations({ l: 1200, w: 800, h: 1450 }).every((o) => o.h === 1450) &&
    P.orientations({ l: 1200, w: 800, h: 1450, orient: 'any' }).length === 6]);
  const tall = P.planSync({ vehicle: semi, tractor: t42, items: [box({ l: 1200, w: 800, h: 1450, weight: 100, qty: 30 })] }, 0);
  out.push(['upright boxes keep their height', tall.placed.length === 30 && tall.placed.every((b) => b.h === 1450)]);

  /* fragile, weight on top, support */
  const mix = P.planSync({ vehicle: semi, tractor: t42, rules: { support: 80 }, items: [
    box({ id: 1, l: 600, w: 400, h: 400, weight: 30, qty: 30, fragile: true }),
    box({ id: 2, l: 600, w: 600, h: 500, weight: 200, qty: 20, maxTop: 250 }),
    box({ id: 3, l: 800, w: 600, h: 400, weight: 60, qty: 40 })
  ] }, 0);
  const onTopOf = (under) => mix.placed.filter((t) => t !== under && restsOn(t, under));
  out.push(['nothing rests on a fragile box', mix.placed.filter((b) => b.fragile).every((b) => onTopOf(b).length === 0)]);
  /* the weight resting on a box, all the way up, by the share of each layer */
  const above = new Map();
  [...mix.placed].sort((a, b) => b.y - a.y).forEach((b) => {
    const load = (above.get(b) || 0) + b.weight;
    const under = mix.placed.filter((u) => u !== b && restsOn(b, u));
    const area = (u) => (Math.min(b.x + b.l, u.x + u.l) - Math.max(b.x, u.x)) * (Math.min(b.z + b.w, u.z + u.w) - Math.max(b.z, u.z));
    const total = under.reduce((s, u) => s + area(u), 0);
    under.forEach((u) => above.set(u, (above.get(u) || 0) + (load * area(u)) / total));
  });
  out.push(['no box bears more than its limit on top', mix.placed.filter((b) => b.maxTop !== Infinity).every((b) => (above.get(b) || 0) <= b.maxTop + 0.5) &&
    mix.placed.some((b) => b.maxTop !== Infinity && (above.get(b) || 0) > 0)]);
  out.push(['every stacked box has 80% of its base supported', mix.placed.filter((b) => b.y > 0.5).every((b) => {
    const area = mix.placed.filter((u) => restsOn(b, u)).reduce((s, u) => s + (Math.min(b.x + b.l, u.x + u.l) - Math.max(b.x, u.x)) * (Math.min(b.z + b.w, u.z + u.w) - Math.max(b.z, u.z)), 0);
    return area >= b.l * b.w * 0.8 - 0.5;
  })]);

  /* unloading order */
  const drops = P.planSync({ vehicle: semi, tractor: t42, stops: ['A', 'B', 'C'], items: [
    box({ id: 1, l: 1200, w: 800, h: 1000, weight: 300, qty: 9, dest: 'A' }),
    box({ id: 2, l: 600, w: 400, h: 600, weight: 40, qty: 30, dest: 'B' }),
    box({ id: 3, l: 1200, w: 1000, h: 900, weight: 250, qty: 8, dest: 'C' })
  ] }, 0);
  const blocked = drops.placed.some((first) => drops.placed.some((other) => other.stop > first.stop && (
    (overlapsYZ(first, other) && other.x >= first.x + first.l - EPS) ||
    (overlapsXZ(first, other) && other.y >= first.y + first.h - EPS))));
  out.push(['no box is blocked by one delivered later', drops.placed.length === 47 && !blocked]);
  out.push(['the first delivery sits by the doors', Math.max(...drops.placed.filter((b) => b.stop === 0).map((b) => b.x + b.l)) >
    Math.max(...drops.placed.filter((b) => b.stop === 2).map((b) => b.x + b.l))]);

  /* planning modes */
  const modeItems = [
    box({ id: 1, l: 1200, w: 800, h: 1000, weight: 300, qty: 9, dest: 'A' }),
    box({ id: 2, l: 600, w: 400, h: 600, weight: 40, qty: 30, dest: 'B' }),
    box({ id: 3, l: 1200, w: 1000, h: 900, weight: 250, qty: 8, dest: 'C' })
  ];
  const blockedBy = (plan, key) => plan.placed.some((first) => plan.placed.some((other) => other[key] !== first[key] && (
    (overlapsYZ(first, other) && other.x >= first.x + first.l - EPS && other.stop > first.stop) ||
    (overlapsXZ(first, other) && other.y >= first.y + first.h - EPS))));
  out.push(['default mode is the itinerary', P.cleanMode(undefined) === 'itinerario' && drops.mode === 'itinerario' &&
    drops.check.states.length > 1]);
  const normal = P.planSync({ vehicle: semi, tractor: t42, stops: ['A', 'B', 'C'], mode: 'normal', items: modeItems }, 10);
  out.push(['normal mode: one block, checked only as it leaves', normal.placed.length === 47 &&
    normal.placed.every((b) => b.stop === 0) && normal.check.states.length === 1 && normal.blocks === null]);
  out.push(['normal mode: clients may share a stack', normal.placed.some((b) => normal.placed.some((u) => u.client !== b.client &&
    overlapsXZ(b, u) && Math.abs(b.y - (u.y + u.h)) < EPS))]);
  const byClient = P.planSync({ vehicle: semi, tractor: t42, stops: ['A', 'B', 'C'], mode: 'cliente', items: modeItems }, 30);
  const clientBlocks = byClient.blocks || [];
  out.push(['client mode: every client in one block, none blocked or stacked on', byClient.placed.length === 47 &&
    !blockedBy(byClient, 'client') && clientBlocks.length === 3 && clientBlocks.slice().sort().join() === 'A,B,C']);
  out.push(['client mode: the blocks follow the order reported, front to doors', clientBlocks.every((name, i) => {
    if (i === 0) return true;
    const c = ['A', 'B', 'C'].indexOf(name);
    const prev = ['A', 'B', 'C'].indexOf(clientBlocks[i - 1]);
    const front = (k) => Math.min(...byClient.placed.filter((b) => b.client === k).map((b) => b.x));
    return front(c) >= front(prev) - EPS;
  }) && byClient.check.states.length === 1]);

  /* manual mode: moving boxes by hand */
  const handItems = [
    box({ id: 1, name: 'Base', l: 1200, w: 800, h: 1000, weight: 300, qty: 2, dest: 'A' }),
    box({ id: 2, name: 'Topo', l: 1200, w: 800, h: 500, weight: 50, qty: 1, dest: 'A' })
  ];
  const handInput = { vehicle: semi, tractor: t42, stops: ['A'], mode: 'normal', items: handItems };
  const handPlan = P.planSync(handInput, 0);
  const hp = handPlan.placed;
  const iTop = hp.findIndex((b) => b.id === 2);
  const iBase = hp.findIndex((b) => b.id === 1 && hp.some((u) => u.id === 2 && Math.abs(u.y - (b.y + b.h)) < 1 &&
    u.x < b.x + b.l && b.x < u.x + u.l && u.z < b.z + b.w && b.z < u.z + u.w));
  /* drop the light box in the middle of the floor: it lands on the floor */
  const toFloor = P.dropAt(semi, hp, iTop, 6000, 900, { snap: false });
  out.push(['drop on empty floor rests on the floor', toFloor.ok && toFloor.box.y === 0 && toFloor.box.x === 6000 && toFloor.box.z === 900]);
  /* drop it over a base box: it climbs on top */
  const baseBox = hp.find((b) => b.id === 1);
  const onTop = P.dropAt(semi, hp, iTop, baseBox.x + 10, baseBox.z, { snap: false });
  out.push(['drop over a box rests on top of it', onTop.ok && Math.abs(onTop.box.y - (baseBox.y + baseBox.h)) < 1]);
  /* near a wall the box snaps against it; never outside the space */
  const topBox = hp[iTop];
  const snapped = P.dropAt(semi, hp, iTop, semi.l - topBox.l - 40, -500);
  out.push(['a box let go near a wall snaps to it and stays inside', snapped.box.x === semi.l - topBox.l && snapped.box.z === 0]);
  const turned = P.dropAt(semi, hp, iTop, 6000, 0, { turn: true, snap: false }).box;
  out.push(['turning swaps length and width', turned.l === topBox.w && turned.w === topBox.l]);
  /* too tall for the stack it would sit on */
  const lowRoof = Object.assign({}, semi, { h: 1300 });
  const stackHigh = P.dropAt(lowRoof, [Object.assign({}, hp[0], { x: 0, y: 0, z: 0 }), Object.assign({}, hp[iTop], { x: 5000, y: 0, z: 0 })], 1, 0, 0, { snap: false });
  out.push(['a box that would pass the roof is refused', !stackHigh.ok && /teto/.test(stackHigh.reason)]);
  /* moving the base from under the light box: the light box comes down */
  if (iBase >= 0) {
    const away = P.dropAt(semi, hp, iBase, 9000, 0, { snap: false });
    const next = hp.slice();
    next[iBase] = away.box;
    const after = P.evaluate(handInput, next, []);
    const fallen = after.placed[iTop];
    out.push(['what rested on a moved box comes down', fallen.y < hp[iTop].y && after.placed.length === 3]);
  } else {
    out.push(['what rested on a moved box comes down', false]);
  }
  /* a box hanging half off its support is reported, not refused */
  const halfway = hp.slice();
  halfway[iTop] = Object.assign({}, hp[iTop], { x: baseBox.x + baseBox.l * 0.75, y: baseBox.y + baseBox.h, z: baseBox.z });
  const overhang = P.evaluate(handInput, halfway, []);
  out.push(['a hand-made overhang is reported as a support problem', overhang.check.problems.some((p) => p.kind === 'support')]);
  /* the list grows in manual mode: the hand-placed boxes stay, the new ones go around */
  const moved = P.dropAt(semi, hp, iTop, 9000, 0, { snap: false });
  const kept = hp.slice();
  kept[iTop] = moved.box;
  const grown = handItems.map((it) => Object.assign({}, it)).concat([box({ id: 3, name: 'Nova', l: 600, w: 400, h: 400, weight: 20, qty: 4, dest: 'A' })]);
  const filled = P.fill(Object.assign({}, handInput, { items: grown }), P.evaluate(handInput, kept, []).placed);
  const stillThere = filled.placed.find((b) => b.id === 2);
  out.push(['manual fill keeps hand-placed boxes and adds the new ones', filled.placed.length === 7 && stillThere &&
    stillThere.x === 9000 && stillThere.y === 0 && !filled.placed.some((a, i) => filled.placed.some((b, j) => i < j &&
      a.x < b.x + b.l - EPS && b.x < a.x + a.l - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS && a.z < b.z + b.w - EPS && b.z < a.z + a.w - EPS))]);
  const shrunk = P.fill(Object.assign({}, handInput, { items: [handItems[1]] }), kept);
  out.push(['manual fill drops boxes of items taken off the list', shrunk.placed.length === 1 && shrunk.placed[0].id === 2 && shrunk.placed[0].x === 9000]);

  /* axle limits while placing: 24 t that would overload the tractor if loaded from the front */
  const heavy = P.planSync({ vehicle: semi, tractor: t42, items: [box({ l: 1200, w: 1200, h: 900, weight: 2000, qty: 12 })] }, 0);
  out.push(['heavy load placed within every axle limit', heavy.placed.length === 12 && !heavy.check.problems.some((p) => p.hard)]);
  /* the linear statics model matches the full calculation */
  const model = P.axleModel(semi, t42);
  const cargo = { weight: 15000, cgx: 6200, cgz: semi.w / 2 };
  const full = Spaces.axleLoads(semi, t42, cargo);
  const lines = full.rows.filter((r) => r.max > 0).map((r) => r.load);
  out.push(['axle model equals the statics', model.lines.slice(0, lines.length).every((L, i) =>
    Math.abs(L.T + L.a * cargo.weight + L.b * cargo.weight * cargo.cgx - lines[i]) < 0.01)]);
  /* too heavy for any position: left out with the reason */
  /* 100 kg spare on the steering axle, 1 300 kg on the rear one: 1 500 kg fits nowhere */
  const tight = JSON.parse(JSON.stringify(Spaces.get('rigid')));
  tight.axles[0].max = 2700;
  tight.axles[1].max = 3000;
  const tooHeavy = P.planSync({ vehicle: tight, tractor: null, items: [box({ l: 1200, w: 800, h: 1000, weight: 1500, qty: 1 })] }, 0);
  out.push(['a box that would overload an axle anywhere is left out as "eixo"', tooHeavy.unplaced.some((u) => u.reason === 'eixo') &&
    !tooHeavy.check.problems.some((p) => p.hard)]);

  /* shares kᵢ, group limit and gross weight */
  const shared = JSON.parse(JSON.stringify(semi));
  shared.axles[1].share = 40;
  shared.axles[2].share = 30;
  shared.axles[3].share = 30;
  const sr = Spaces.axleLoads(shared, null, { weight: 20000, cgx: 8000, cgz: shared.w / 2 });
  const rearCargo = sr.rows.filter((r) => r.part === 'space').map((r) => r.cargo);
  const sum = rearCargo.reduce((a, b) => a + b, 0);
  out.push(['unequal shares: 40/30/30 of the group', Math.abs(rearCargo[0] / sum - 0.4) < 1e-9 && Math.abs(rearCargo[1] / sum - 0.3) < 1e-9]);
  const centre = 0.4 * 7985 + 0.3 * 9295 + 0.3 * 10605;
  out.push(['group centre is Σ kᵢ·xᵢ', Math.abs(sr.kingpin.cargo - (20000 * (centre - 8000)) / (centre - 1675)) < 0.01]);
  const badShares = JSON.parse(JSON.stringify(shared));
  badShares.axles[3].share = 20;
  out.push(['shares must add up to 100%', Spaces.validate(Spaces.clean(Object.assign(badShares, { name: 'x' }))).some((e) => e.field === 'axle1.share')]);
  const over = Spaces.axleLoads(semi, t42, { weight: 24000, cgx: 9000, cgz: semi.w / 2 });
  out.push(['group over its limit is reported', over.groups.some((g) => g.part === 'space' && g.max === 25500 && g.status === 'over')]);
  const rigid = Spaces.get('rigid');
  out.push(['gross weight from the cargo and every tare', Math.abs(Spaces.axleLoads(rigid, null, { weight: 3000, cgx: 3000, cgz: 1225 }).gross.load - (3000 + 2600 + 1700)) < 1e-9 &&
    Spaces.axleLoads(rigid, null, { weight: 3000, cgx: 3000, cgz: 1225 }).gross.max === 7500]);
  const atLimit = JSON.parse(JSON.stringify(rigid));
  atLimit.axles[1].max = Spaces.axleLoads(rigid, null, { weight: 3000, cgx: 3000, cgz: 1225 }).rows[1].load;
  out.push(['a load equal to its limit is not over (compared in grams)', Spaces.axleLoads(atLimit, null, { weight: 3000, cgx: 3000, cgz: 1225 }).rows[1].status !== 'over']);

  /* the checker: after each delivery, lateral balance, least load on the steering and drive axles */
  const at = (o) => Object.assign({ y: 0, z: 0, l: 1200, w: 1200, h: 1000, weight: 0, stop: 0 }, o);
  const frontHeavy = [
    at({ x: 0, z: 0, weight: 5000, stop: 1 }), at({ x: 0, z: 1200, weight: 5000, stop: 1 }),
    at({ x: 12000, z: 0, weight: 6000, stop: 0 }), at({ x: 12000, z: 1200, weight: 6000, stop: 0 })
  ];
  const v1 = P.verify(semi, t42, frontHeavy, ['A', 'B'], null);
  out.push(['fine as it leaves, overloaded after the first delivery', v1.states.length === 2 &&
    !v1.states[0].problems.some((p) => p.hard) && v1.states[1].problems.some((p) => p.hard) &&
    v1.problems.some((p) => p.state === 'Após a entrega 1 (A)')]);
  const leaning = [at({ x: 6000, z: 0, weight: 8000 })];
  out.push(['lateral imbalance reported', P.verify(semi, t42, leaning, [''], { lateral: 10 }).problems.some((p) => p.kind === 'lateral')]);
  const tail = [at({ x: 6000, z: 625, weight: 3000 })];
  out.push(['too little on the steering axle reported', P.verify(Spaces.get('rigid'), null, tail, [''], { minFront: 45 }).problems.some((p) => p.kind === 'minFront')]);
  const nose = [at({ x: 0, z: 625, weight: 3000 })];
  out.push(['too little on the drive axle reported', P.verify(Spaces.get('rigid'), null, nose, [''], { minDrive: 45 }).problems.some((p) => p.kind === 'minDrive')]);

  /* the search: same list, same plan; the first plan comes back at once */
  const demo = [box({ id: 1, l: 1200, w: 800, h: 1450, weight: 420, qty: 12, dest: 'X' }), box({ id: 2, l: 600, w: 400, h: 400, weight: 35, qty: 20, dest: 'Y', fragile: true })];
  const a = P.planSync({ vehicle: semi, tractor: t42, items: demo }, 15);
  const b = P.planSync({ vehicle: semi, tractor: t42, items: demo }, 15);
  out.push(['the search is repeatable', JSON.stringify(a.placed.map((p) => [p.x, p.y, p.z])) === JSON.stringify(b.placed.map((p) => [p.x, p.y, p.z]))]);
  const run = P.start({ vehicle: semi, tractor: t42, items: demo, rules: { budget: 1 } }, () => {});
  out.push(['first plan at once, search stoppable', run.best.placed.length === 32 && run.running() && (run.cancel(), !run.running())]);
  return out;
}

let importResults = [];
try {
  importResults = await importChecks();
} catch (err) {
  importResults = [['import checks ran: ' + (err && err.stack ? err.stack : err), false]];
}
checks.push(...importResults);
try {
  checks.push(...spaceChecks());
} catch (err) {
  checks.push(['space checks ran: ' + (err && err.stack ? err.stack : err), false]);
}
try {
  checks.push(...planChecks());
} catch (err) {
  checks.push(['load plan checks ran: ' + (err && err.stack ? err.stack : err), false]);
}

/* A plan saved before cargo spaces existed kept the vehicle as an index into
   the old fixed list (4 = 20 ft container): it must open on the same space. */
/* loading order and the PDF document, on the plan the page is showing */
{
  const P = window.SyncrofinLoadPlan;
  const data = window.SyncrofinApp.docData();
  const placed = data.placed;
  const ls = P.loadingSteps(placed);
  const pos = [];
  ls.order.forEach((idx, i) => { pos[idx] = i; });
  const restsOn = (hi, lo) => Math.abs(lo.y + lo.h - hi.y) <= 1 && hi.x < lo.x + lo.l && lo.x < hi.x + hi.l && hi.z < lo.z + lo.w && lo.z < hi.z + hi.w;
  checks.push(['loading order covers every box once', ls.order.length === placed.length && new Set(ls.order).size === placed.length &&
    ls.steps.reduce((s, st) => s + st.boxes.length, 0) === placed.length]);
  checks.push(['loading order: a box only after the boxes it rests on', placed.every((b, i) =>
    placed.every((u, j) => !(i !== j && restsOn(b, u)) || pos[j] < pos[i]))]);
  checks.push(['loading order starts at the far end', placed[ls.order[0]].x === Math.min(...placed.map((b) => b.x)) &&
    ls.steps[0].from <= ls.steps[ls.steps.length - 1].from]);

  const doc = window.SyncrofinLoadDoc.build(data);
  const bytes = doc.bytes;
  const text = Buffer.from(bytes).toString('latin1');
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
  const xref = text.slice(startxref);
  const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  checks.push(['PDF: header, cross-reference table and end of file', text.startsWith('%PDF-1.4') && xref.startsWith('xref') &&
    offsets.length > 5 && offsets.every((o, i) => text.startsWith((i + 1) + ' 0 obj', o))]);
  checks.push(['PDF: a cover and the steps, every page with its footer', doc.pages >= 2 && doc.steps === ls.steps.length &&
    (text.match(/\/Type \/Page /g) || []).length === doc.pages && (text.match(/\(P\\341gina /g) || []).length === doc.pages]);
  checks.push(['PDF: accents written in WinAnsi', text.includes('(Etapa 1 de ') && /\(Planejamento|PLANEJAMENTO/.test(text) &&
    text.includes('\\341') && /\.pdf$/.test(doc.name)]);
  /* securing (lashing.js) */
  const Lash = window.SyncrofinLashing;
  const flat = Spaces.get('flatbed');
  const semiL = Spaces.get('semi');
  const one = (vehicle, x, w) => [{ id: 1, name: 'Caixa', x: x, y: 0, z: 0, l: 1200, w: w, h: 1000, weight: 1000, fragile: false, maxTop: Infinity }];
  const onFlat = Lash.plan(flat, one(flat, 3000, 1000), { surface: 'padrao', stf: 400 });
  const sec = onFlat.sections[0];
  const per = (2 * 0.3 * sec.sinA * 400) / 1.1;
  const want = Math.ceil(((0.8 - 0.3) * 1000 * 0.981) / per - 1e-9);
  checks.push(['lashing: EN 12195-1 top-over count on a platform', sec.need.forward === want && sec.n === want && !sec.blockedFront && !sec.blockedSides &&
    sec.need.side === Math.ceil((0.2 * 981) / per - 1e-9)]);
  const blocked = Lash.plan(semiL, one(semiL, 0, semiL.w), { surface: 'padrao', stf: 400 });
  checks.push(['lashing: front and side walls hold a load against them', blocked.sections[0].blockedFront && blocked.sections[0].blockedSides &&
    blocked.sections[0].need.forward === 0 && blocked.sections[0].need.side === 0 && blocked.sections[0].need.backward > 0]);
  const away = Lash.plan(semiL, one(semiL, 2000, semiL.w), { surface: 'padrao', stf: 400 });
  const filled = Lash.plan(semiL, one(semiL, 300, semiL.w), { surface: 'padrao', stf: 400, fill: true });
  checks.push(['lashing: a gap to the wall unblocks, a filler closes it', !away.sections[0].blockedFront && filled.sections[0].blockedFront]);
  const choice = Lash.ideal(flat, one(flat, 3000, 1000), { surface: 'padrao', stf: 400 });
  checks.push(['lashing: the anti-slip mat cuts the straps and is recommended', choice.best.key !== 'base' &&
    choice.best.plan.total < choice.options[0].plan.total && /tapete/i.test(choice.recommendation)]);
  const full = Lash.ideal(data.space, placed, { surface: 'padrao', stf: 400 });
  const fp = full.options[0].plan;
  const covered = fp.sections.reduce((n, s) => n + s.boxes.length, 0);
  checks.push(['lashing: every box in one section, straps over the load', covered === placed.length && fp.total === fp.straps.length &&
    fp.straps.every((st) => {
      const s = fp.sections[st.section - 1];
      return st.x >= s.from && st.x <= s.to && st.top > 0 && st.zmax > st.zmin;
    }) && fp.sections.every((s) => s.n >= Math.ceil((s.to - s.from) / 2000 - 1e-9))]);
  /* the strap's path across the load: floor to floor over the top corners
     (a tall stack, a lower box beside it, a gap to the right wall) */
  const prof = [
    { id: 1, name: 'Alta', x: 1000, y: 0, z: 0, l: 1200, w: 800, h: 1000, weight: 400, fragile: false, maxTop: Infinity },
    { id: 2, name: 'Alta', x: 1000, y: 1000, z: 0, l: 1200, w: 800, h: 900, weight: 300, fragile: false, maxTop: Infinity },
    { id: 3, name: 'Baixa', x: 1000, y: 0, z: 800, l: 1200, w: 800, h: 700, weight: 300, fragile: false, maxTop: Infinity }
  ];
  const pathPlan = Lash.plan(flat, prof, { surface: 'padrao', stf: 400 });
  const pst = pathPlan.straps[0];
  const path = pst && pst.path;
  const under = (z) => {
    /* the height of the path at z (it is a polyline over z) */
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (z >= a.z - 1e-6 && z <= b.z + 1e-6) return b.z === a.z ? Math.max(a.y, b.y) : a.y + ((b.y - a.y) * (z - a.z)) / (b.z - a.z);
    }
    return -1;
  };
  const corners = prof.flatMap((b) => [[b.z, b.y + b.h], [b.z + b.w, b.y + b.h]]);
  checks.push(['lashing: each strap runs from the floor to the floor over the load', !!path && path.length >= 3 &&
    path[0].y === 0 && path[path.length - 1].y === 0 && path.every((p, i) => i === 0 || p.z >= path[i - 1].z)]);
  checks.push(['lashing: the strap rests on the top corners, never above the load as a flat roof', !!path &&
    corners.every(([z, y]) => under(z) >= y - 1e-6) &&
    path.some((p) => p.z === 1600 && p.y === 700) && path.some((p) => p.z === 0 && p.y === 1900) &&
    under(1600) === 700]);
  const withLash = window.SyncrofinLoadDoc.build(Object.assign({}, data, { lash: full }));
  const lashText = Buffer.from(withLash.bytes).toString('latin1');
  checks.push(['PDF: securing page when the lashing is on', lashText.includes('(Plano de amarra\\347\\343o)') && withLash.pages >= doc.pages &&
    !Buffer.from(doc.bytes).toString('latin1').includes('(Plano de amarra')]);

  const Pdf = window.SyncrofinPdf;
  checks.push(['PDF text width and wrapping', Math.abs(Pdf.textWidth('Ação', 10, false) - (667 + 500 + 556 + 556) / 100) < 0.01 &&
    Pdf.wrap('carregue sempre do fundo para as portas', 10, false, 80).every((l) => Pdf.textWidth(l, 10, false) <= 80)]);
}

{
  /* "Comparar veículos": the ranking, a real comparison and the panel */
  const P = window.SyncrofinLoadPlan;
  const u = (o) => Object.assign({ volume: 0, weight: 0, area: 0, length: 0, placed: 10, total: 10, hard: 0, soft: 0, fits: true }, o);
  const made = [
    { id: 'big', usage: u({ volume: 0.3, weight: 0.3 }) },
    { id: 'small', usage: u({ volume: 0.5, weight: 0.8 }) },
    { id: 'warn', usage: u({ volume: 0.6, weight: 0.9, soft: 1 }) },
    { id: 'over', usage: u({ volume: 0.7, weight: 0.95, hard: 1, fits: false }) },
    { id: 'short', usage: u({ placed: 4, fits: false, volume: 0.9, weight: 1 }) }
  ];
  checks.push(['compare: whole load within limits first, without warnings first, fullest first, then the rest',
    P.rankSpaces(made).map((r) => r.id).join() === 'small,big,warn,over,short']);

  const list = Spaces.cargoSpaces();
  const pick = (re) => list.find((s) => re.test(s.name));
  const cands = [pick(/minifurg/i), pick(/r[ií]gido 18/i), pick(/^Cont[eê]iner 40 p[eé]s$/i)].filter(Boolean);
  const pallets = [{ id: 1, name: 'Palete', l: 1200, w: 800, h: 1400, weight: 400, qty: 10, color: 'blue', dest: '' }];
  const res = cands.map((s) => ({
    space: s,
    usage: P.usage(s, P.planSync({ vehicle: s, tractor: null, items: pallets, stops: P.stopOrder(pallets, []), mode: 'normal', rules: null }, 10))
  }));
  const ranked = P.rankSpaces(res);
  checks.push(['compare: 4 t of pallets go in the rigid 18 t, not in the container or the small van', cands.length === 3 &&
    /18/.test(ranked[0].space.name) && ranked[0].usage.fits && ranked[0].usage.placed === 10 &&
    /minifurg/i.test(ranked[2].space.name) && !ranked[2].usage.fits]);
  const u18 = ranked[0].usage;
  checks.push(['compare: usage shares are of the vehicle', Math.abs(u18.weight - 4000 / ranked[0].space.payload) < 1e-6 &&
    Math.abs(u18.volume - (10 * 1.2 * 0.8 * 1.4) / ((ranked[0].space.l * ranked[0].space.w * ranked[0].space.h) / 1e9)) < 1e-6]);

  /* the panel, on the three favourites */
  const textOf = (n) => (n ? String(n.textContent || '') + (n.children || []).map(textOf).join('') : '');
  cands.forEach((s) => { if (!Spaces.isFavorite(s.id)) Spaces.toggleFavorite(s.id); });
  elements['#demo'].click();
  elements['#compare-fav'].checked = true;
  elements['#compare'].click();
  checks.push(['compare: the button opens the panel', elements['#compare-panel'].hidden === false &&
    elements['#compare'].getAttribute('aria-expanded') === 'true' && /Comparando/.test(textOf(elements['#compare-reco']))]);
  for (let i = 0; i < 400 && !/Recomendado|Nenhum veículo/.test(textOf(elements['#compare-reco'])); i++) await new Promise((r) => setTimeout(r, 25));
  const tbody = elements['#compare-table'].children[1];
  checks.push(['compare: the panel ranks the favourites and names the recommended one',
    /Recomendado: .*18/.test(textOf(elements['#compare-reco'])) && tbody &&
    tbody.children.length === Spaces.cargoSpaces().filter((s) => Spaces.isFavorite(s.id)).length && tbody.children.length >= 3 &&
    /Recomendado/.test(textOf(tbody.children[0])) && /minifurg/i.test(textOf(tbody.children[tbody.children.length - 1]))]);
  /* the yellow button: the plan switches to the recommended vehicle and the window closes */
  const press = (data) => elements['#compare-panel'].fire('click', { target: { closest: () => ({ dataset: data }) } });
  const before = String(elements['#vehicle-dims'].textContent);
  press({ use: '0' });
  checks.push(['compare: "Usar este veículo" closes the window and plans in the recommended vehicle',
    elements['#compare-panel'].hidden === true && elements['#compare'].getAttribute('aria-expanded') === 'false' &&
    /^Caminhão rígido 18 t/.test(String(elements['#vehicle-dims'].textContent)) && before !== String(elements['#vehicle-dims'].textContent)]);
  /* "Cancelar": back to the planner, the vehicle as it was */
  elements['#compare'].click();
  const kept = String(elements['#vehicle-dims'].textContent);
  press({ cancel: '1' });
  checks.push(['compare: "Cancelar" closes the window and keeps the vehicle',
    elements['#compare-panel'].hidden === true && String(elements['#vehicle-dims'].textContent) === kept]);
}

{
  store.clear();
  store.set('carga3d.v1', JSON.stringify({ vehicle: 4, items: [{ id: 1, name: 'Caixa', l: 1000, w: 800, h: 600, weight: 50, qty: 4, color: 'blue', dest: '' }] }));
  const sb2 = { ...sandbox, window: { ...window, localStorage: window.localStorage } };
  sb2.window.document = document;
  vm.createContext(sb2);
  for (const name of SCRIPTS) vm.runInContext(srcFile(name), sb2, { filename: name });
  checks.push(['old saved plan opens on the same vehicle', String(elements['#vehicle-dims'].textContent).startsWith('Contêiner 20 pés ·')]);
  checks.push(['container shows no axle loads', elements['#axle-list'].children.length === 1 &&
    elements['#axle-list'].children[0].className === 'axle-none']);
}

{
  /* help: the "?" button opens the manual, and the manual is whole */
  const page = srcFile('index.html');
  const help = srcFile('ajuda/index.html');
  checks.push(['help button in the top bar opens the manual in a new tab',
    /<a class="help-btn" id="help" href="ajuda\/index.html" target="_blank"/.test(page) &&
    page.indexOf('id="help"') > page.indexOf('id="top-actions"') && page.indexOf('id="help"') < page.indexOf('</header>')]);
  checks.push(['F1 opens the manual', srcFile('app.js').includes("e.key === 'F1'")]);
  const ids = new Set([...help.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const anchors = [...help.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  checks.push(['manual: every internal link has a target', anchors.length > 0 && anchors.every((a) => ids.has(a))]);
  const chapters = [...help.matchAll(/<section class="chapter" id="([^"]+)" data-title="([^"]+)"/g)];
  checks.push(['manual: chapters are numbered in order', chapters.length >= 15 &&
    chapters.every((c, i) => help.includes(`id="${c[1]}" data-title="${c[2]}">\n      <h2><span class="n">${i + 1}</span>`))]);
  const imgs = [...help.matchAll(/src="(img\/[^"]+)"/g)].map((m) => m[1]);
  checks.push(['manual: every picture is in src/ajuda/img', imgs.length > 0 &&
    imgs.every((rel) => fs.existsSync(path.join(here, '..', 'src', 'ajuda', rel)))]);
}

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name);
}
console.log(`fills=${log.fills} strokes=${log.strokes} moves=${log.moves}`);
process.exit(failed ? 1 : 0);
