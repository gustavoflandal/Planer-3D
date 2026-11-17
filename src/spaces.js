/* Syncrofin 3D Planner — cargo spaces.

   The types of cargo space, the built-in catalogue, the spaces the user adds
   or edits, favourites, validation, and the axle-load arithmetic (including a
   semitrailer's kingpin load passed on to the axles of its tractor unit).
   Plain data and functions, no DOM: the page and the tests both use it as
   window.SyncrofinSpaces. Everything the user changes is kept in this
   browser's localStorage. */

(function (root) {
  'use strict';

  /* ----------------------------------------------------------------- types --- */
  /* kind decides how the supports carry the load:
       box      no axles of its own (a container on someone else's chassis)
       semi     A is the kingpin, B.. are the running axles
       lorry    A is the front (steering) axle, B.. the rear axles
       trailer  A is the front axle on the turntable, B.. the rear axles
       tractor  a tractor unit: A front axle, B.. rear axles, measured from
                the fifth wheel (where the semitrailer's kingpin sits)
     group is what the type filter in the list works with.
     front is how many of the supports form the front group (1 unless said):
     a bitruck and an 8×2 / 8×4 tractor steer on two front axles, which share
     the front load as the rear group shares its own. */
  var TYPES = [
    { id: 'container', label: 'Contentor', group: 'container', kind: 'box', supports: 0 },
    { id: 'flatbed1', label: 'Plataforma (1 eixo)', group: 'trailer', kind: 'semi', supports: 2 },
    { id: 'flatbed2', label: 'Plataforma (2 eixos)', group: 'trailer', kind: 'semi', supports: 3 },
    { id: 'flatbed3', label: 'Plataforma (3 eixos)', group: 'trailer', kind: 'semi', supports: 4 },
    { id: 'lorry2', label: 'Camião rígido (2 eixos)', group: 'lorry', kind: 'lorry', supports: 2 },
    { id: 'lorry3', label: 'Camião rígido (3 eixos)', group: 'lorry', kind: 'lorry', supports: 3 },
    { id: 'lorry4', label: 'Camião rígido (4 eixos, bitruck)', group: 'lorry', kind: 'lorry', supports: 4, front: 2 },
    { id: 'semi1', label: 'Semirreboque (1 eixo)', group: 'trailer', kind: 'semi', supports: 2 },
    { id: 'semi2', label: 'Semirreboque (2 eixos)', group: 'trailer', kind: 'semi', supports: 3 },
    { id: 'semi3', label: 'Semirreboque (3 eixos)', group: 'trailer', kind: 'semi', supports: 4 },
    { id: 'semi4', label: 'Semirreboque (4 eixos)', group: 'trailer', kind: 'semi', supports: 5 },
    { id: 'trailer2', label: 'Reboque (2 eixos)', group: 'trailer', kind: 'trailer', supports: 2 },
    { id: 'trailer3', label: 'Reboque (3 eixos)', group: 'trailer', kind: 'trailer', supports: 3 },
    { id: 'truck2', label: 'Cavalo mecânico (2 eixos)', group: 'tractor', kind: 'tractor', supports: 2 },
    { id: 'truck3', label: 'Cavalo mecânico (3 eixos)', group: 'tractor', kind: 'tractor', supports: 3 },
    { id: 'truck4', label: 'Cavalo mecânico (4 eixos, 8×2/8×4)', group: 'tractor', kind: 'tractor', supports: 4, front: 2 }
  ];

  TYPES.forEach(function (t) {
    if (!t.front) t.front = t.supports ? 1 : 0;
  });

  var TYPE_BY_ID = {};
  TYPES.forEach(function (t) {
    TYPE_BY_ID[t.id] = t;
  });

  var GROUPS = [
    { id: 'container', label: 'Contentores' },
    { id: 'lorry', label: 'Camiões' },
    { id: 'trailer', label: 'Reboques e semirreboques' }
  ];

  var LETTERS = ['A', 'B', 'C', 'D', 'E'];

  function typeOf(id) {
    return TYPE_BY_ID[id] || null;
  }

  /* What each support letter means for a type, as the form and the axle panel
     name it. */
  function roles(typeId) {
    var t = typeOf(typeId);
    if (!t || !t.supports) return [];
    var out = [];
    var front = t.front;
    var rear = t.supports - front;
    for (var i = 0; i < t.supports; i++) {
      var letter = LETTERS[i];
      var inFront = i < front;
      var nth = inFront ? i + 1 : i - front + 1; /* position inside its group */
      var role;
      var label;
      if (t.kind === 'semi') {
        role = i === 0 ? 'kingpin' : 'axle';
        label = i === 0 ? 'Pino-rei' : 'Eixo ' + i;
      } else {
        role = inFront ? 'front' : 'rear';
        if (inFront) {
          label = front > 1 ? 'Eixo dianteiro ' + nth : 'Eixo dianteiro';
        } else if (t.kind === 'tractor' && front === 1) {
          label = nth === 1 ? 'Eixo motriz' : 'Eixo de apoio';
        } else {
          label = rear > 1 ? 'Eixo traseiro ' + nth : 'Eixo traseiro';
        }
      }
      out.push({ letter: letter, role: role, label: label, group: inFront ? 'front' : 'rear' });
    }
    return out;
  }

  /* ------------------------------------------------------------- catalogue --- */
  /* Inner dimensions (mm) and the maximum load of the cargo space (kg).
     Axle distances are measured from the front wall of the cargo space —
     negative when the axle sits ahead of it, like a lorry's front axle under
     the cab. A tractor's are measured from its fifth wheel. */
  var SYSTEM_DATE = '2026-01-15';

  function ax(dist, tare, max) {
    return { dist: dist, tare: tare, max: max };
  }

  var SYSTEM = [
    {
      id: 'van', name: 'Furgão 3,5 t', type: 'lorry2',
      l: 4300, w: 1800, h: 1900, payload: 1100, track: 1700,
      axles: [ax(-1000, 1300, 1800), ax(2600, 900, 2300)]
    },
    {
      id: 'rigid', name: 'Camião rígido 7,5 t', type: 'lorry2',
      l: 6100, w: 2450, h: 2400, payload: 3200, track: 1850,
      axles: [ax(-1300, 2600, 3700), ax(3900, 1700, 5500)]
    },
    {
      id: 'rigid18', name: 'Camião rígido 18 t', type: 'lorry2',
      l: 7300, w: 2480, h: 2600, payload: 9500, track: 2000,
      axles: [ax(-1400, 4200, 7100), ax(4600, 2800, 11500)]
    },
    {
      id: 'rigid26', name: 'Camião rígido 26 t', type: 'lorry3',
      l: 8500, w: 2480, h: 2700, payload: 14000, track: 2000,
      axles: [ax(-1500, 5000, 7500), ax(5000, 2500, 9500), ax(6350, 2500, 9500)]
    },
    {
      /* bitruck: two steering axles under the cab, a tandem at the rear */
      id: 'bitruck', name: 'Camião bitruck 4 eixos', type: 'lorry4',
      l: 10400, w: 2480, h: 2700, payload: 19000, track: 2050,
      axles: [ax(-2300, 3000, 6000), ax(-950, 2500, 6000), ax(6800, 2300, 8500), ax(8150, 2200, 8500)]
    },
    {
      id: 'semi', name: 'Semirreboque 13,6 m', type: 'semi3',
      l: 13600, w: 2450, h: 2700, payload: 24000, track: 2050,
      axles: [ax(1675, 1300, 12000), ax(7985, 2000, 9000), ax(9295, 1700, 9000), ax(10605, 1500, 9000)]
    },
    {
      id: 'mega', name: 'Semirreboque mega', type: 'semi3',
      l: 13600, w: 2450, h: 3000, payload: 24000, track: 2050,
      axles: [ax(1675, 1400, 12000), ax(7985, 2050, 9000), ax(9295, 1750, 9000), ax(10605, 1550, 9000)]
    },
    {
      id: 'semi2ax', name: 'Semirreboque 2 eixos', type: 'semi2',
      l: 13600, w: 2480, h: 2700, payload: 20000, track: 2050,
      axles: [ax(1675, 1300, 12000), ax(8640, 2100, 9000), ax(9950, 1900, 9000)]
    },
    {
      id: 'semi4ax', name: 'Semirreboque 4 eixos', type: 'semi4',
      l: 15300, w: 2480, h: 2700, payload: 33000, track: 2050,
      axles: [ax(1700, 2000, 14000), ax(9200, 1800, 8500), ax(10450, 1800, 8500), ax(11700, 1800, 8500), ax(12950, 1800, 8500)]
    },
    {
      id: 'flatbed', name: 'Plataforma 13,6 m', type: 'flatbed3',
      l: 13600, w: 2480, h: 2700, payload: 27000, track: 2050,
      axles: [ax(1600, 1100, 12000), ax(7985, 1500, 9000), ax(9295, 1400, 9000), ax(10605, 1300, 9000)]
    },
    {
      id: 'trailer', name: 'Reboque 7,7 m', type: 'trailer2',
      l: 7700, w: 2480, h: 2700, payload: 11000, track: 2050,
      axles: [ax(1300, 1800, 9000), ax(6200, 1800, 9000)]
    },
    {
      id: 'ct20', name: 'Contentor 20 pés', type: 'container',
      l: 5900, w: 2350, h: 2390, payload: 28000, track: 0, axles: []
    },
    {
      id: 'ct40', name: 'Contentor 40 pés', type: 'container',
      l: 12030, w: 2350, h: 2390, payload: 26500, track: 0, axles: []
    },
    {
      id: 'ct40hc', name: 'Contentor 40 pés High Cube', type: 'container',
      l: 12030, w: 2350, h: 2690, payload: 26500, track: 0, axles: []
    },
    {
      id: 'tractor42', name: 'Cavalo padrão 4×2', type: 'truck2',
      l: 0, w: 0, h: 0, payload: 18000, track: 2050,
      axles: [ax(-3600, 5000, 8000), ax(550, 2500, 11500)]
    },
    {
      id: 'tractor62', name: 'Cavalo 6×2 com eixo de apoio', type: 'truck3',
      l: 0, w: 0, h: 0, payload: 20000, track: 2050,
      axles: [ax(-3600, 5200, 8000), ax(100, 2300, 11500), ax(1450, 1300, 7500)]
    },
    {
      /* 8×2 / 8×4: two steering axles, a tandem behind the fifth wheel */
      id: 'tractor84', name: 'Cavalo 8×4 (4 eixos)', type: 'truck4',
      l: 0, w: 0, h: 0, payload: 24000, track: 2050,
      axles: [ax(-3500, 4500, 6000), ax(-2100, 3000, 6000), ax(-250, 2400, 8500), ax(1100, 1600, 8500)]
    }
  ];

  SYSTEM.forEach(function (s) {
    s.origin = 'system';
    s.created = SYSTEM_DATE;
  });

  var DEFAULT_SPACE = 'semi';
  var DEFAULT_TRACTOR = 'tractor42';
  var DEFAULT_FAVORITES = ['semi', 'tractor42'];

  /* The planner used to keep its vehicle as an index into a fixed list. */
  var LEGACY_ORDER = ['van', 'rigid', 'semi', 'mega', 'ct20', 'ct40', 'ct40hc'];

  /* --------------------------------------------------------------- storage --- */
  var STORE_KEY = 'syncrofin.spaces.v1';
  var storage = null;
  var memory = { custom: [], overrides: {}, favorites: DEFAULT_FAVORITES.slice() };
  var loaded = false;

  function backend() {
    if (storage) return storage;
    try {
      return root.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function readStore() {
    if (loaded) return memory;
    loaded = true;
    var store = backend();
    if (!store) return memory;
    try {
      var raw = store.getItem(STORE_KEY);
      if (!raw) return memory;
      var data = JSON.parse(raw);
      memory = {
        custom: Array.isArray(data.custom)
          ? data.custom.map(clean).filter(function (s) {
            return s && !validate(s).length;
          })
          : [],
        overrides: {},
        favorites: Array.isArray(data.favorites) ? data.favorites.filter(isString) : DEFAULT_FAVORITES.slice()
      };
      if (data.overrides && typeof data.overrides === 'object') {
        Object.keys(data.overrides).forEach(function (id) {
          var s = clean(data.overrides[id]);
          if (s && systemById(id) && !validate(s).length) memory.overrides[id] = s;
        });
      }
    } catch (e) {
      /* a damaged entry: start again from the catalogue */
    }
    return memory;
  }

  function writeStore() {
    var store = backend();
    if (!store) return;
    try {
      store.setItem(STORE_KEY, JSON.stringify(memory));
    } catch (e) {
      /* private mode or full: the change still holds until the page closes */
    }
  }

  /* Tests (and anyone embedding the planner) can hand in their own storage. */
  function useStorage(s) {
    storage = s;
    loaded = false;
    memory = { custom: [], overrides: {}, favorites: DEFAULT_FAVORITES.slice() };
  }

  function isString(v) {
    return typeof v === 'string';
  }

  /* ---------------------------------------------------------------- shapes --- */
  function toNum(v, fallback) {
    if (typeof v === 'number') return isFinite(v) ? v : fallback;
    var n = parseFloat(String(v === undefined || v === null ? '' : v).replace(',', '.'));
    return isFinite(n) ? n : fallback;
  }

  /* A space as stored and used: numbers rounded, the axle list as long as the
     type asks for. Missing numbers stay NaN so validate() can name them. */
  function clean(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var t = typeOf(raw.type);
    if (!t) return null;
    var axles = [];
    for (var i = 0; i < t.supports; i++) {
      var a = (raw.axles && raw.axles[i]) || {};
      axles.push({
        dist: Math.round(toNum(a.dist, NaN)),
        tare: Math.round(toNum(a.tare, NaN)),
        max: Math.round(toNum(a.max, NaN))
      });
    }
    var tractor = t.kind === 'tractor';
    return {
      id: isString(raw.id) ? raw.id : '',
      name: String(raw.name || '').trim().slice(0, 40),
      type: t.id,
      l: tractor ? 0 : Math.round(toNum(raw.l, NaN)),
      w: tractor ? 0 : Math.round(toNum(raw.w, NaN)),
      h: tractor ? 0 : Math.round(toNum(raw.h, NaN)),
      payload: Math.round(toNum(raw.payload, NaN)),
      track: t.supports ? Math.round(toNum(raw.track, NaN)) : 0,
      axles: axles,
      origin: raw.origin === 'system' ? 'system' : 'custom',
      created: isString(raw.created) && /^\d{4}-\d{2}-\d{2}$/.test(raw.created) ? raw.created : today()
    };
  }

  function today() {
    var d = new Date();
    var p = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function copy(s) {
    return JSON.parse(JSON.stringify(s));
  }

  /* An empty space of a type, for the "create" form. */
  function blank(typeId) {
    var t = typeOf(typeId) || TYPES[0];
    var axles = [];
    for (var i = 0; i < t.supports; i++) axles.push({ dist: NaN, tare: NaN, max: NaN });
    return {
      id: '', name: '', type: t.id, l: NaN, w: NaN, h: NaN, payload: NaN,
      track: t.supports ? NaN : 0, axles: axles, origin: 'custom', created: today()
    };
  }

  /* Changing the type in the form keeps the values that still have a place. */
  function retype(space, typeId) {
    var t = typeOf(typeId);
    if (!t) return space;
    var next = copy(space);
    next.type = t.id;
    var axles = [];
    for (var i = 0; i < t.supports; i++) {
      axles.push(space.axles && space.axles[i] ? space.axles[i] : { dist: NaN, tare: NaN, max: NaN });
    }
    next.axles = axles;
    if (!t.supports) next.track = 0;
    else if (!(next.track > 0)) next.track = NaN;
    return next;
  }

  /* -------------------------------------------------------------- validate --- */
  var LIMITS = {
    l: [500, 20000], w: [500, 3000], h: [300, 4000],
    payload: [1, 60000], track: [1000, 2600],
    dist: [-8000, 20000], tare: [0, 15000], max: [1, 30000]
  };

  function inRange(v, key) {
    return isFinite(v) && v >= LIMITS[key][0] && v <= LIMITS[key][1];
  }

  function fmtLimit(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  /* Returns [{ field, message }]; empty when the space can be saved. Field
     names match the form: name, l, w, h, payload, track, axle0.dist, ... */
  function validate(s) {
    var errors = [];
    function err(field, message) {
      errors.push({ field: field, message: message });
    }
    var t = typeOf(s && s.type);
    if (!t) {
      err('type', 'Escolha o tipo de espaço de carga.');
      return errors;
    }
    if (!s.name || !String(s.name).trim()) err('name', 'Dê um nome ao espaço de carga.');

    var tractor = t.kind === 'tractor';
    if (!tractor) {
      ['l', 'w', 'h'].forEach(function (k) {
        var label = { l: 'O comprimento interno', w: 'A largura interna', h: 'A altura interna' }[k];
        if (!inRange(s[k], k)) {
          err(k, label + ' tem de ficar entre ' + fmtLimit(LIMITS[k][0]) + ' e ' + fmtLimit(LIMITS[k][1]) + ' mm.');
        }
      });
    }
    if (!inRange(s.payload, 'payload')) {
      err('payload', (tractor ? 'A carga máxima no prato' : 'A carga máxima do espaço') +
        ' tem de ficar entre 1 e ' + fmtLimit(LIMITS.payload[1]) + ' kg.');
    }
    if (t.supports && !inRange(s.track, 'track')) {
      err('track', 'A bitola tem de ficar entre ' + fmtLimit(LIMITS.track[0]) + ' e ' + fmtLimit(LIMITS.track[1]) + ' mm.');
    }

    var rs = roles(t.id);
    var axles = s.axles || [];
    for (var i = 0; i < t.supports; i++) {
      var a = axles[i] || {};
      var name = rs[i].label + ' (' + rs[i].letter + ')';
      if (!inRange(a.dist, 'dist')) err('axle' + i + '.dist', name + ': indique a distância em mm.');
      if (!inRange(a.tare, 'tare')) err('axle' + i + '.tare', name + ': a tara tem de ficar entre 0 e ' + fmtLimit(LIMITS.tare[1]) + ' kg.');
      if (!inRange(a.max, 'max')) err('axle' + i + '.max', name + ': a carga máxima tem de ficar entre 1 e ' + fmtLimit(LIMITS.max[1]) + ' kg.');
    }
    if (errors.length) return errors;

    /* Geometry: supports in order from the front, the right ones where they must be. */
    for (var j = 1; j < t.supports; j++) {
      if (axles[j].dist <= axles[j - 1].dist) {
        err('axle' + j + '.dist', rs[j].label + ' (' + rs[j].letter + ') tem de ficar atrás de ' +
          rs[j - 1].label.toLowerCase() + ' (' + rs[j - 1].letter + ').');
      }
    }
    if (t.kind === 'semi') {
      if (axles[0].dist < 0 || axles[0].dist > s.l / 2) {
        err('axle0.dist', 'O pino-rei (A) tem de ficar na metade da frente do espaço de carga.');
      }
      if (axles[t.supports - 1].dist > s.l + 3000) {
        err('axle' + (t.supports - 1) + '.dist', 'O último eixo fica longe demais da traseira do espaço de carga.');
      }
    }
    if (t.kind === 'lorry' || t.kind === 'trailer') {
      if (axles[t.supports - 1].dist <= 0) {
        err('axle' + (t.supports - 1) + '.dist', 'Os eixos traseiros têm de ficar sob o espaço de carga.');
      }
    }
    if (t.kind === 'tractor') {
      for (var f = 0; f < t.front; f++) {
        if (axles[f].dist >= 0) {
          err('axle' + f + '.dist', rs[f].label + ' (' + rs[f].letter + ') fica à frente do prato: a distância é negativa.');
        }
      }
      if (axles[t.supports - 1].dist < -2000 || axles[t.supports - 1].dist > 3000) {
        err('axle' + (t.supports - 1) + '.dist', 'Os eixos traseiros têm de ficar perto do prato (entre -2 000 e 3 000 mm).');
      }
    }
    return errors;
  }

  /* ---------------------------------------------------------------- lookup --- */
  function systemById(id) {
    for (var i = 0; i < SYSTEM.length; i++) if (SYSTEM[i].id === id) return SYSTEM[i];
    return null;
  }

  function all() {
    var store = readStore();
    var list = SYSTEM.map(function (s) {
      var o = store.overrides[s.id];
      if (!o) return copy(s);
      var merged = copy(o);
      merged.id = s.id;
      merged.origin = 'system';
      merged.created = s.created;
      merged.edited = true;
      return merged;
    });
    store.custom.forEach(function (s) {
      list.push(copy(s));
    });
    return list;
  }

  function get(id) {
    var list = all();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function isTractor(s) {
    var t = s && typeOf(s.type);
    return !!t && t.kind === 'tractor';
  }

  function cargoSpaces() {
    return all().filter(function (s) {
      return !isTractor(s);
    });
  }

  function tractors() {
    return all().filter(isTractor);
  }

  function takesTractor(s) {
    var t = s && typeOf(s.type);
    return !!t && t.kind === 'semi';
  }

  /* ------------------------------------------------------------- favourites --- */
  function isFavorite(id) {
    return readStore().favorites.indexOf(id) >= 0;
  }

  function toggleFavorite(id) {
    var store = readStore();
    var at = store.favorites.indexOf(id);
    if (at >= 0) store.favorites.splice(at, 1);
    else store.favorites.push(id);
    writeStore();
    return at < 0;
  }

  /* ----------------------------------------------------------------- writes --- */
  /* Saves a new or edited space. Built-in spaces keep their id: the edit is
     stored beside the catalogue and can be undone with reset(). */
  function save(raw) {
    var s = clean(raw);
    if (!s) return { ok: false, errors: [{ field: 'type', message: 'Escolha o tipo de espaço de carga.' }] };
    var errors = validate(s);
    if (errors.length) return { ok: false, errors: errors };
    var store = readStore();
    var sys = s.id && systemById(s.id);
    if (sys) {
      s.origin = 'system';
      s.created = sys.created;
      store.overrides[s.id] = s;
    } else {
      var at = -1;
      store.custom.forEach(function (c, i) {
        if (c.id === s.id) at = i;
      });
      s.origin = 'custom';
      if (at >= 0) {
        s.created = store.custom[at].created;
        store.custom[at] = s;
      } else {
        s.id = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
        s.created = today();
        store.custom.push(s);
      }
    }
    writeStore();
    return { ok: true, space: get(s.id) };
  }

  function remove(id) {
    var store = readStore();
    var before = store.custom.length;
    store.custom = store.custom.filter(function (c) {
      return c.id !== id;
    });
    if (store.custom.length === before) return false;
    store.favorites = store.favorites.filter(function (f) {
      return f !== id;
    });
    writeStore();
    return true;
  }

  function reset(id) {
    var store = readStore();
    if (!store.overrides[id]) return false;
    delete store.overrides[id];
    writeStore();
    return true;
  }

  /* --------------------------------------------------------------- filters --- */
  /* opts: { groups: ['container', 'lorry', 'trailer'] (empty = all),
             favoritesOnly: bool } */
  function filter(list, opts) {
    var groups = (opts && opts.groups) || [];
    var favOnly = !!(opts && opts.favoritesOnly);
    return list.filter(function (s) {
      var t = typeOf(s.type);
      if (!t) return false;
      if (groups.length && groups.indexOf(t.group) < 0) return false;
      if (favOnly && !isFavorite(s.id)) return false;
      return true;
    });
  }

  /* ------------------------------------------------------------ axle loads --- */
  /* Two supports at xf < xr carrying W at x: the lever rule. */
  function lever(W, x, xf, xr) {
    var span = xr - xf;
    if (Math.abs(span) < 1) return [W / 2, W / 2];
    var rear = (W * (x - xf)) / span;
    return [W - rear, rear];
  }

  function mean(list) {
    var s = 0;
    list.forEach(function (v) {
      s += v;
    });
    return list.length ? s / list.length : 0;
  }

  function status(load, max) {
    if (load < -0.5) return 'over'; /* the support lifts: load ahead of it */
    if (!(max > 0)) return 'ok';
    var r = load / max;
    if (r > 1) return 'over';
    if (r > 0.9) return 'warn';
    return 'ok';
  }

  /* cargo: { weight, cgx, cgz } — total placed weight (kg) and its centre of
     gravity in the cargo space (mm from the front wall / from the left wall).
     Returns { rows, kingpin, leftShare } where every row is
       { label, letter, part: 'space' | 'tractor' | 'kingpin', x, cargo, tare,
         load, max, status, left, right }
     x is the support's position from the cargo space's front wall. The
     kingpin row is informational when a tractor carries it: its load is then
     already counted in the tractor's axles. A rear axle group shares its load
     equally, as a load-equalising suspension does. */
  function axleLoads(space, tractor, cargo) {
    var t = space && typeOf(space.type);
    var out = { rows: [], kingpin: null, leftShare: 0.5 };
    if (!t || !t.supports || !space.axles || space.axles.length < 2) return out;

    var W = Math.max(0, (cargo && cargo.weight) || 0);
    var cgx = cargo && isFinite(cargo.cgx) ? cargo.cgx : space.l / 2;
    var cgz = cargo && isFinite(cargo.cgz) ? cargo.cgz : space.w / 2;
    var track = space.track > 0 ? space.track : space.w || 2000;
    /* share of the cargo carried by the left wheels (z grows to the right) */
    var leftShare = W > 0 ? Math.min(1, Math.max(0, 0.5 + (space.w / 2 - cgz) / track)) : 0.5;
    out.leftShare = leftShare;

    var rs = roles(space.type);
    /* front group (one axle, the kingpin, or a bitruck's two steering axles)
       and rear group, each sharing its load equally */
    var dist = function (a) {
      return a.dist;
    };
    var frontAx = space.axles.slice(0, t.front);
    var rearAx = space.axles.slice(t.front);
    var split = lever(W, cgx, mean(frontAx.map(dist)), mean(rearAx.map(dist)));

    function row(part, role, a, x, cargoKg) {
      var load = cargoKg + a.tare;
      return {
        label: role.label,
        letter: role.letter,
        part: part,
        x: x,
        cargo: cargoKg,
        tare: a.tare,
        load: load,
        max: a.max,
        status: status(load, a.max),
        left: a.tare / 2 + cargoKg * leftShare,
        right: a.tare / 2 + cargoKg * (1 - leftShare)
      };
    }

    var spaceRows = rearAx.map(function (a, i) {
      return row('space', rs[t.front + i], a, a.dist, split[1] / rearAx.length);
    });

    if (t.kind !== 'semi') {
      out.rows = frontAx.map(function (a, i) {
        return row('space', rs[i], a, a.dist, split[0] / frontAx.length);
      }).concat(spaceRows);
      return out;
    }

    /* Semitrailer: the front share sits on the kingpin. */
    var front = frontAx[0];
    var kingpin = row('kingpin', rs[0], front, front.dist, split[0]);
    out.kingpin = kingpin;

    var tt = tractor && typeOf(tractor.type);
    if (!tt || tt.kind !== 'tractor' || !tractor.axles || tractor.axles.length < 2) {
      out.rows = [kingpin].concat(spaceRows);
      return out;
    }

    /* With a tractor, the kingpin load (cargo share + the trailer's own weight
       on it) rests on the fifth wheel and is shared by the tractor's axles:
       its front group and its rear group, by the lever rule. */
    kingpin.status = status(kingpin.load, Math.min(front.max, tractor.payload || front.max));
    kingpin.max = Math.min(front.max, tractor.payload || front.max);
    var trs = roles(tractor.type);
    var tf = tt.front || 1;
    var tFront = tractor.axles.slice(0, tf);
    var tRear = tractor.axles.slice(tf);
    var K = kingpin.load;
    var tSplit = lever(K, 0, mean(tFront.map(dist)), mean(tRear.map(dist)));
    var tractorRows = tFront.map(function (a, i) {
      return row('tractor', trs[i], a, front.dist + a.dist, tSplit[0] / tFront.length);
    }).concat(tRear.map(function (a, i) {
      return row('tractor', trs[tf + i], a, front.dist + a.dist, tSplit[1] / tRear.length);
    }));
    /* the kingpin load on the left/right wheels follows the cargo's lean too */
    tractorRows.forEach(function (r) {
      var share = r.cargo / (K || 1);
      var kingpinCargo = split[0] * share;
      var rest = r.cargo - kingpinCargo;
      r.left = r.tare / 2 + kingpinCargo * leftShare + rest / 2;
      r.right = r.tare / 2 + kingpinCargo * (1 - leftShare) + rest / 2;
    });
    kingpin.info = true;
    out.rows = tractorRows.concat([kingpin]).concat(spaceRows);
    return out;
  }

  root.SyncrofinSpaces = {
    TYPES: TYPES,
    GROUPS: GROUPS,
    LETTERS: LETTERS,
    LIMITS: LIMITS,
    DEFAULT_SPACE: DEFAULT_SPACE,
    DEFAULT_TRACTOR: DEFAULT_TRACTOR,
    LEGACY_ORDER: LEGACY_ORDER,
    typeOf: typeOf,
    roles: roles,
    all: all,
    get: get,
    cargoSpaces: cargoSpaces,
    tractors: tractors,
    isTractor: isTractor,
    takesTractor: takesTractor,
    isFavorite: isFavorite,
    toggleFavorite: toggleFavorite,
    blank: blank,
    retype: retype,
    clean: clean,
    validate: validate,
    save: save,
    remove: remove,
    reset: reset,
    filter: filter,
    axleLoads: axleLoads,
    useStorage: useStorage
  };
})(typeof window !== 'undefined' ? window : this);
