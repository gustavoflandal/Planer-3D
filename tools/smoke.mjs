/* Smoke test: run src/app.js in a fake browser so a runtime error in the
   planner, the packer or the canvas drawing is caught before shipping.
   `node tools/smoke.mjs` — exits non-zero when the app throws. */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'src', 'app.js'), 'utf8');

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
  '#f-name', '#f-l', '#f-w', '#f-h', '#f-weight', '#f-qty', '#f-color', '#f-dest',
  '#vehicle', '#plan', '#demo', '#clear', '#report', '#status', '#vehicle-dims',
  '#axle-list', '#axle-cog', '#nav-toggle', '#topbar'
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
elements['#vehicle'].value = '2';

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

const sandbox = { window, document, console, Math, JSON, parseInt, parseFloat, isFinite, Array, Object, String, Number };
sandbox.window.document = document;

try {
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'app.js' });
} catch (err) {
  console.error('app.js threw: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
}

const checks = [];
const canvas = elements['#view'];
checks.push(['canvas sized', canvas.width > 0 && canvas.height > 0]);
checks.push(['3D drawing happened', log.fills > 3 && log.strokes > 0]);
checks.push(['vehicle select filled', elements['#vehicle'].children.length === 7]);
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
   the cargo's own weight, and the destination field must split the item list
   into the groups the demo items declare. */
const digits = (s) => parseInt(String(s).replace(/[^0-9]/g, '') || '0', 10);
const axleLoads = elements['#axle-list'].children.map((li) => {
  const val = li.children[2];
  return val ? digits(val.textContent) : 0;
});
const axleSum = axleLoads.reduce((a, b) => a + b, 0);
const cargoWeight = elements['#items'].children.reduce((sum, li) => {
  if (li.className !== 'item-row') return sum;
  const btn = li.children[0];
  const meta = btn && btn.children[1] && btn.children[1].children[1];
  if (!meta) return sum;
  const parts = String(meta.textContent).split('·');
  return sum + (parts[1] ? digits(parts[1]) : 0) * (parts[2] ? digits(parts[2]) : 0);
}, 0);

checks.push(['axle list written', axleLoads.length === 3]);
checks.push(['axle loads sum to cargo weight', Math.abs(axleSum - cargoWeight) <= 3]);
checks.push(['axle-cog written', String(elements['#axle-cog'].textContent).includes('Centro de gravidade')]);
checks.push([
  'destination groups rendered',
  elements['#items'].children.some(
    (li) => li.className === 'group-head' && li.textContent === 'FruitPlanet Corp'
  )
]);
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

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name);
}
console.log(`fills=${log.fills} strokes=${log.strokes} moves=${log.moves}`);
process.exit(failed ? 1 : 0);
