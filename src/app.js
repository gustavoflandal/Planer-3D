/* Syncrofin 3D Planner — a load planner for trucks and containers.
   Everything runs in the browser: the cargo list is packed into the chosen
   vehicle by a simple extreme-point heuristic and drawn on a canvas with a
   hand-written 3D projection. No libraries. */

(function () {
  'use strict';

  /* ------------------------------------------------------------- vehicles --- */
  var VEHICLES = [
    { id: 'van', name: 'Furgão 3,5 t', l: 6000, w: 2100, h: 2300, payload: 1200, axles: [{ x: 1400, limit: 1600 }, { x: 4800, limit: 2400 }] },
    { id: 'rigid', name: 'Camião rígido 7,5 t', l: 7500, w: 2400, h: 2500, payload: 3500, axles: [{ x: 1300, limit: 2800 }, { x: 6400, limit: 5200 }] },
    { id: 'semi', name: 'Semirreboque 13,6 m', l: 13600, w: 2450, h: 2700, payload: 24000, axles: [{ x: 1000, limit: 8000 }, { x: 4500, limit: 13000 }, { x: 11800, limit: 19000 }] },
    { id: 'mega', name: 'Semirreboque mega', l: 13600, w: 2450, h: 3000, payload: 24000, axles: [{ x: 1000, limit: 8000 }, { x: 4500, limit: 13000 }, { x: 11800, limit: 19000 }] },
    { id: 'ct20', name: 'Contentor 20 pés', l: 5900, w: 2350, h: 2390, payload: 28000, axles: [{ x: 800, limit: 11000 }, { x: 4500, limit: 19000 }] },
    { id: 'ct40', name: 'Contentor 40 pés', l: 12030, w: 2350, h: 2390, payload: 26500, axles: [{ x: 900, limit: 10500 }, { x: 10500, limit: 18500 }] },
    { id: 'ct40hc', name: 'Contentor 40 pés High Cube', l: 12030, w: 2350, h: 2690, payload: 26500, axles: [{ x: 900, limit: 10500 }, { x: 10500, limit: 18500 }] }
  ];

  var PALETTE = {
    blue: '#5fc2ea',
    yellow: '#fec528',
    green: '#8fc98a',
    orange: '#f0a35e',
    grey: '#bfc1c5'
  };

  var DEMO = [
    { name: 'Palete EUR', l: 1200, w: 800, h: 1450, weight: 420, qty: 12, color: 'blue', dest: 'FruitPlanet Corp' },
    { name: 'Caixa grande', l: 1200, w: 1000, h: 900, weight: 180, qty: 6, color: 'yellow', dest: 'FruitPlanet Corp' },
    { name: 'Caixa pequena', l: 600, w: 400, h: 400, weight: 35, qty: 20, color: 'green', dest: 'Grupo 1' },
    { name: 'Barril', l: 600, w: 600, h: 900, weight: 150, qty: 4, color: 'orange', dest: 'Grupo 1' }
  ];

  var STORE_KEY = 'carga3d.v1';

  /* ---------------------------------------------------------------- state --- */
  var state = {
    vehicleIndex: 2,
    items: [],
    placed: [],
    unplaced: [],
    totals: { count: 0, volume: 0, weight: 0, area: 0 },
    selected: null,
    view: { az: 0.95, elev: 0.42, zoom: 1 }
  };

  var els = {};
  var ctx = null;
  var nextId = 1;

  /* -------------------------------------------------------------- helpers --- */
  function $(sel) {
    return document.querySelector(sel);
  }

  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  }

  function num(value, fallback) {
    var n = parseFloat(String(value).replace(',', '.'));
    return isFinite(n) ? n : fallback;
  }

  function fmt(n, digits) {
    var d = digits === undefined ? 0 : digits;
    return n.toLocaleString('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function currentVehicle() {
    return VEHICLES[state.vehicleIndex] || VEHICLES[0];
  }

  function rgb(hex) {
    var h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  /* --------------------------------------------------------------- storage --- */
  function save() {
    try {
      window.localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ vehicle: state.vehicleIndex, items: state.items })
      );
    } catch (e) {
      /* private mode: the planner still works, it just forgets on reload */
    }
  }

  function load() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) return false;
      state.vehicleIndex = clamp(num(data.vehicle, 2), 0, VEHICLES.length - 1);
      state.items = data.items
        .filter(function (it) {
          return it && typeof it.name === 'string';
        })
        .map(function (it) {
          return {
            id: it.id || nextId++,
            name: String(it.name).slice(0, 28),
            l: clamp(num(it.l, 1200), 50, 13600),
            w: clamp(num(it.w, 800), 50, 2450),
            h: clamp(num(it.h, 1000), 20, 3000),
            weight: clamp(num(it.weight, 100), 0, 30000),
            qty: clamp(Math.round(num(it.qty, 1)), 1, 500),
            color: PALETTE[it.color] ? it.color : 'blue',
            dest: typeof it.dest === 'string' ? String(it.dest).slice(0, 40) : ''
          };
        });
      return true;
    } catch (e) {
      return false;
    }
  }

  /* --------------------------------------------------------------- packing --- */
  /* Constructive heuristic for the 3D Container Loading Problem.

     The vehicle is filled with the Empty Maximal Space (EMS) method: the
     algorithm keeps a list of empty rectangular spaces and, for each box,
     places it at the back-bottom-left corner of the space that gives the
     deepest, lowest, tightest fit, then splits the space that was used into
     (at most) three new maximal spaces. This is the classic "deepest-bottom-
     left-fill" constructive heuristic for CLP / 3D-BPP. To make the greedy
     choice robust, several box orders (biggest volume, longest side, heaviest)
     are tried and the packing that loads the most cargo volume is kept. */

  var SUPPORT_FRACTION = 0.6; /* a box not on the floor needs this share of its base supported */

  function overlaps(a, b) {
    return (
      a.x < b.x + b.l - 0.5 &&
      b.x < a.x + a.l - 0.5 &&
      a.z < b.z + b.w - 0.5 &&
      b.z < a.z + a.w - 0.5 &&
      a.y < b.y + b.h - 0.5 &&
      b.y < a.y + a.h - 0.5
    );
  }

  function supportArea(box, placed) {
    if (box.y <= 0.5) return box.l * box.w; /* the floor holds the whole base */
    var area = 0;
    for (var i = 0; i < placed.length; i++) {
      var p = placed[i];
      if (Math.abs(p.y + p.h - box.y) > 1) continue;
      var ox = Math.min(box.x + box.l, p.x + p.l) - Math.max(box.x, p.x);
      var oz = Math.min(box.z + box.w, p.z + p.w) - Math.max(box.z, p.z);
      if (ox > 0 && oz > 0) area += ox * oz;
    }
    return area;
  }

  function isSupported(box, placed) {
    return supportArea(box, placed) >= box.l * box.w * SUPPORT_FRACTION - 0.5;
  }

  function orientations(it) {
    /* Every way to lay the three dimensions onto (length, width, height).
       "upright" keeps the box's own height as the height, which is preferred;
       tipped orientations are still tried when they pack better. */
    var d = [it.l, it.w, it.h];
    var seen = {};
    var out = [];
    for (var a = 0; a < 3; a++) {
      for (var b = 0; b < 3; b++) {
        if (a === b) continue;
        var c = 3 - a - b;
        var L = d[a];
        var W = d[b];
        var H = d[c];
        var key = L + 'x' + W + 'x' + H;
        if (seen[key]) continue;
        seen[key] = 1;
        out.push({ l: L, w: W, h: H, upright: c === 2 });
      }
    }
    return out;
  }

  function tidySpaces(spaces) {
    /* Drop spaces swallowed by a bigger one, and slivers too small to use. */
    var usable = [];
    for (var i = 0; i < spaces.length; i++) {
      var a = spaces[i];
      if (a.l < 5 || a.w < 5 || a.h < 5) continue;
      var dominated = false;
      for (var j = 0; j < spaces.length; j++) {
        if (i === j) continue;
        var b = spaces[j];
        if (
          a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.z >= b.z - 0.5 &&
          a.x + a.l <= b.x + b.l + 0.5 &&
          a.y + a.h <= b.y + b.h + 0.5 &&
          a.z + a.w <= b.z + b.w + 0.5 &&
          (b.l > a.l || b.w > a.w || b.h > a.h)
        ) {
          dominated = true;
          break;
        }
      }
      if (!dominated) usable.push(a);
    }
    usable.sort(function (a, b) {
      return b.l * b.w * b.h - a.l * a.w * a.h;
    });
    return usable.slice(0, 64);
  }

  function packVehicle(vehicle, queue) {
    var placed = [];
    var unplaced = [];
    var weight = 0;
    var spaces = [{ x: 0, y: 0, z: 0, l: vehicle.l, w: vehicle.w, h: vehicle.h }];

    queue.forEach(function (it) {
      if (weight + it.weight > vehicle.payload + 0.5) {
        unplaced.push({ id: it.id, name: it.name, reason: 'peso' });
        return;
      }

      var orients = orientations(it);
      var best = null;

      for (var s = 0; s < spaces.length; s++) {
        var sp = spaces[s];
        for (var o = 0; o < orients.length; o++) {
          var or = orients[o];
          if (or.l > sp.l + 0.5 || or.w > sp.w + 0.5 || or.h > sp.h + 0.5) continue;

          var box = { x: sp.x, y: sp.y, z: sp.z, l: or.l, w: or.w, h: or.h };
          if (!isSupported(box, placed)) continue;

          var clash = false;
          for (var k = 0; k < placed.length; k++) {
            if (overlaps(box, placed[k])) {
              clash = true;
              break;
            }
          }
          if (clash) continue;

          /* Deepest-bottom-left: prefer the far wall, then the floor, then the
             left side; among equal corners take the tightest fit into the
             space, and keep the box upright unless tipping clearly helps. */
          var score =
            box.x * 1e9 +
            box.y * 1e6 +
            box.z * 1e3 +
            (sp.l * sp.w * sp.h - or.l * or.w * or.h) / 1e9 +
            (or.upright ? 0 : 0.5);

          if (!best || score < best.score) {
            best = { box: box, space: sp, index: s, score: score };
          }
        }
      }

      if (!best) {
        unplaced.push({ id: it.id, name: it.name, reason: 'espaco' });
        return;
      }

      best.box.id = it.id;
      best.box.name = it.name;
      best.box.color = it.color;
      best.box.weight = it.weight;
      placed.push(best.box);
      weight += it.weight;

      /* Split the space that was used into the three maximal spaces left
         behind (above, to the side, in front). */
      var sp = best.space;
      var box = best.box;
      var next = [];
      if (box.h < sp.h - 0.5) {
        next.push({ x: sp.x, y: box.y + box.h, z: sp.z, l: sp.l, w: sp.w, h: sp.h - box.h });
      }
      if (box.w < sp.w - 0.5) {
        next.push({ x: sp.x, y: sp.y, z: box.z + box.w, l: sp.l, w: sp.w - box.w, h: sp.h });
      }
      if (box.l < sp.l - 0.5) {
        next.push({ x: box.x + box.l, y: sp.y, z: sp.z, l: sp.l - box.l, w: sp.w, h: sp.h });
      }

      spaces = spaces.slice(0, best.index).concat(spaces.slice(best.index + 1), next);
      spaces = tidySpaces(spaces);
    });

    return { placed: placed, unplaced: unplaced, weight: weight };
  }

  function summarize(placed, unplaced, weight) {
    var volume = 0;
    var area = 0;
    placed.forEach(function (b) {
      volume += (b.l * b.w * b.h) / 1e9;
      area += (b.l * b.w) / 1e6;
    });
    return {
      placed: placed,
      unplaced: unplaced,
      totals: {
        count: placed.length,
        volume: volume,
        weight: weight,
        area: area,
        queue: placed.length + unplaced.length
      }
    };
  }

  function betterThan(a, b) {
    if (a.totals.volume !== b.totals.volume) return a.totals.volume > b.totals.volume;
    if (a.totals.count !== b.totals.count) return a.totals.count > b.totals.count;
    return a.totals.area > b.totals.area;
  }

  function pack(vehicle, items) {
    var queue = [];
    items.forEach(function (it) {
      for (var i = 0; i < it.qty; i++) {
        queue.push({ id: it.id, name: it.name, color: it.color, weight: it.weight, l: it.l, w: it.w, h: it.h });
      }
    });

    var byVolume = queue.slice().sort(function (a, b) {
      return b.l * b.w * b.h - a.l * a.w * a.h;
    });
    var byLongest = queue.slice().sort(function (a, b) {
      return Math.max(b.l, b.w, b.h) - Math.max(a.l, a.w, a.h);
    });
    var byWeight = queue.slice().sort(function (a, b) {
      return b.weight - a.weight;
    });

    /* Three greedy orders, best packing kept; one pass for very large jobs. */
    var orders = queue.length > 150 ? [byVolume] : [byVolume, byLongest, byWeight];
    var best = null;
    orders.forEach(function (ordered) {
      var r = packVehicle(vehicle, ordered);
      var result = summarize(r.placed, r.unplaced, r.weight);
      if (!best || betterThan(result, best)) best = result;
    });

    return best;
  }

  /* ------------------------------------------------------------ projection --- */
  function camera(vehicle) {
    var cx = vehicle.l / 2;
    var cy = vehicle.h / 2;
    var cz = vehicle.w / 2;
    var dist = Math.max(vehicle.l, vehicle.w, vehicle.h) * 2.4;
    var ce = Math.cos(state.view.elev);
    var se = Math.sin(state.view.elev);

    var pos = {
      x: cx + dist * ce * Math.cos(state.view.az),
      y: cy + dist * se,
      z: cz + dist * ce * Math.sin(state.view.az)
    };

    var fx = cx - pos.x;
    var fy = cy - pos.y;
    var fz = cz - pos.z;
    var fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
    var f = { x: fx / fl, y: fy / fl, z: fz / fl };

    var rx = -f.z;
    var rz = f.x;
    var rl = Math.sqrt(rx * rx + rz * rz) || 1;
    var r = { x: rx / rl, y: 0, z: rz / rl };

    var u = {
      x: r.y * f.z - r.z * f.y,
      y: r.z * f.x - r.x * f.z,
      z: r.x * f.y - r.y * f.x
    };

    return { pos: pos, f: f, r: r, u: u };
  }

  function projectFactory(cam, scale, W, H) {
    return function (p) {
      var dx = p.x - cam.pos.x;
      var dy = p.y - cam.pos.y;
      var dz = p.z - cam.pos.z;
      return {
        x: W / 2 + (dx * cam.r.x + dy * cam.r.y + dz * cam.r.z) * scale,
        y: H / 2 - (dx * cam.u.x + dy * cam.u.y + dz * cam.u.z) * scale,
        depth: dx * cam.f.x + dy * cam.f.y + dz * cam.f.z
      };
    };
  }

  function fitScale(vehicle, cam, W, H) {
    var xs = [0, vehicle.l];
    var ys = [0, vehicle.h];
    var zs = [0, vehicle.w];
    var maxX = 1;
    var maxY = 1;
    for (var i = 0; i < 2; i++) {
      for (var j = 0; j < 2; j++) {
        for (var k = 0; k < 2; k++) {
          var dx = xs[i] - cam.pos.x;
          var dy = ys[j] - cam.pos.y;
          var dz = zs[k] - cam.pos.z;
          maxX = Math.max(maxX, Math.abs(dx * cam.r.x + dy * cam.r.y + dz * cam.r.z));
          maxY = Math.max(maxY, Math.abs(dx * cam.u.x + dy * cam.u.y + dz * cam.u.z));
        }
      }
    }
    return Math.min((W * 0.86) / (2 * maxX), (H * 0.82) / (2 * maxY));
  }

  /* ---------------------------------------------------------------- drawing --- */
  var LIGHT = (function () {
    var v = { x: -0.45, y: 0.82, z: 0.36 };
    var len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  })();

  function shade(hex, n) {
    var lam = Math.max(0, n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z);
    var k = 0.6 + 0.42 * lam;
    var c = rgb(hex);
    return (
      'rgb(' +
      Math.round(clamp(c[0] * k, 0, 255)) +
      ',' +
      Math.round(clamp(c[1] * k, 0, 255)) +
      ',' +
      Math.round(clamp(c[2] * k, 0, 255)) +
      ')'
    );
  }

  function polygon(c, pts, fill, stroke) {
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    c.closePath();
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = 1;
      c.stroke();
    }
  }

  function draw() {
    var canvas = els.canvas;
    if (!canvas || !ctx) return;

    var rect = canvas.getBoundingClientRect();
    var W = Math.max(1, Math.round(rect.width));
    var H = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#f8fafc');
    bg.addColorStop(1, '#e6ecf1');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    var vehicle = currentVehicle();
    var cam = camera(vehicle);
    var scale = fitScale(vehicle, cam, W, H) * state.view.zoom;
    var project = projectFactory(cam, scale, W, H);

    /* floor ---------------------------------------------------------------- */
    var floor = [
      project({ x: 0, y: 0, z: 0 }),
      project({ x: vehicle.l, y: 0, z: 0 }),
      project({ x: vehicle.l, y: 0, z: vehicle.w }),
      project({ x: 0, y: 0, z: vehicle.w })
    ];
    polygon(ctx, floor, '#dde4ea', 'rgba(92,91,91,0.45)');

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(floor[0].x, floor[0].y);
    for (var fi = 1; fi < floor.length; fi++) ctx.lineTo(floor[fi].x, floor[fi].y);
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = 'rgba(92,91,91,0.16)';
    ctx.lineWidth = 1;
    var step = vehicle.l > 9000 ? 1000 : 500;
    var gx;
    for (gx = step; gx < vehicle.l; gx += step) {
      var a = project({ x: gx, y: 0, z: 0 });
      var b = project({ x: gx, y: 0, z: vehicle.w });
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (gx = step; gx < vehicle.w; gx += step) {
      var c1 = project({ x: 0, y: 0, z: gx });
      var c2 = project({ x: vehicle.l, y: 0, z: gx });
      ctx.beginPath();
      ctx.moveTo(c1.x, c1.y);
      ctx.lineTo(c2.x, c2.y);
      ctx.stroke();
    }
    ctx.restore();

    /* boxes ---------------------------------------------------------------- */
    var faces = [];
    state.placed.forEach(function (box) {
      var xs = [box.x, box.x + box.l];
      var ys = [box.y, box.y + box.h];
      var zs = [box.z, box.z + box.w];
      var P = function (i, j, k) {
        return { x: xs[i], y: ys[j], z: zs[k] };
      };

      var defs = [
        { n: { x: 1, y: 0, z: 0 }, pts: [P(1, 0, 0), P(1, 0, 1), P(1, 1, 1), P(1, 1, 0)] },
        { n: { x: -1, y: 0, z: 0 }, pts: [P(0, 0, 1), P(0, 0, 0), P(0, 1, 0), P(0, 1, 1)] },
        { n: { x: 0, y: 0, z: 1 }, pts: [P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)] },
        { n: { x: 0, y: 0, z: -1 }, pts: [P(1, 0, 0), P(0, 0, 0), P(0, 1, 0), P(1, 1, 0)] },
        { n: { x: 0, y: 1, z: 0 }, pts: [P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1)] }
      ];

      defs.forEach(function (def) {
        var fx = 0;
        var fy = 0;
        var fz = 0;
        def.pts.forEach(function (p) {
          fx += p.x / 4;
          fy += p.y / 4;
          fz += p.z / 4;
        });
        var toward = {
          x: cam.pos.x - fx,
          y: cam.pos.y - fy,
          z: cam.pos.z - fz
        };
        if (def.n.x * toward.x + def.n.y * toward.y + def.n.z * toward.z <= 0) return;

        var pts = def.pts.map(project);
        var depth = 0;
        pts.forEach(function (p) {
          depth += p.depth / 4;
        });
        faces.push({
          pts: pts,
          depth: depth,
          fill: shade(PALETTE[box.color] || PALETTE.blue, def.n),
          sel: state.selected !== null && box.id === state.selected
        });
      });
    });

    faces.sort(function (a, b) {
      return b.depth - a.depth;
    });

    faces.forEach(function (f) {
      polygon(ctx, f.pts, f.fill, f.sel ? '#ffffff' : 'rgba(40,50,60,0.22)');
      if (f.sel) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });

    /* vehicle frame -------------------------------------------------------- */
    var corners = [
      { x: 0, y: 0, z: 0 },
      { x: vehicle.l, y: 0, z: 0 },
      { x: vehicle.l, y: 0, z: vehicle.w },
      { x: 0, y: 0, z: vehicle.w },
      { x: 0, y: vehicle.h, z: 0 },
      { x: vehicle.l, y: vehicle.h, z: 0 },
      { x: vehicle.l, y: vehicle.h, z: vehicle.w },
      { x: 0, y: vehicle.h, z: vehicle.w }
    ].map(project);

    var edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7]
    ];

    ctx.strokeStyle = 'rgba(92,91,91,0.62)';
    ctx.lineWidth = 1.6;
    edges.forEach(function (e) {
      ctx.beginPath();
      ctx.moveTo(corners[e[0]].x, corners[e[0]].y);
      ctx.lineTo(corners[e[1]].x, corners[e[1]].y);
      ctx.stroke();
    });

    var t = state.totals;
    canvas.setAttribute(
      'aria-label',
      'Vista tridimensional de ' + currentVehicle().name + ' com ' + t.count + ' volumes colocados.'
    );
  }

  /* ------------------------------------------------------------------ view --- */
  function renderGauges() {
    var v = currentVehicle();
    var t = state.totals;
    var capacity = (v.l * v.w * v.h) / 1e9;
    var floorArea = (v.l * v.w) / 1e6;
    var linearMeters = 0;
    state.placed.forEach(function (b) {
      linearMeters = Math.max(linearMeters, (b.x + b.l) / 1000);
    });
    var vehicleMeters = v.l / 1000;
    var values = {
      volume: capacity ? (t.volume / capacity) * 100 : 0,
      weight: v.payload ? (t.weight / v.payload) * 100 : 0,
      area: floorArea ? (t.area / floorArea) * 100 : 0,
      linear: vehicleMeters ? (linearMeters / vehicleMeters) * 100 : 0
    };
    Object.keys(values).forEach(function (key) {
      var el = els.gauges[key];
      if (!el) return;
      var pct = clamp(values[key], 0, 100);
      el.bar.style.width = pct.toFixed(1) + '%';
      el.value.textContent = key === 'linear' ? fmt(linearMeters, 2) + ' m' : Math.round(values[key]) + '%';
    });
  }

  function renderStatus() {
    var v = currentVehicle();
    var t = state.totals;
    var weightRoom = Math.max(0, v.payload - t.weight);

    if (!state.items.length) {
      els.status.textContent = 'Lista vazia — adicione volumes para começar.';
    } else if (state.unplaced.length) {
      var byWeight = state.unplaced.filter(function (u) {
        return u.reason === 'peso';
      }).length;
      var parts = [];
      parts.push(t.count + ' de ' + t.queue + ' volumes colocados');
      if (byWeight) parts.push(byWeight + ' ficaram de fora por excesso de peso');
      if (state.unplaced.length - byWeight) {
        parts.push(state.unplaced.length - byWeight + ' não couberam no espaço livre');
      }
      els.status.textContent = parts.join(' · ') + '.';
    } else {
      els.status.textContent =
        'Tudo colocado: ' + t.count + ' volumes, ' + fmt(t.volume, 1) + ' m³ de carga.';
    }

    els.dims.textContent =
      v.name +
      ' · ' +
      fmt(v.l) +
      ' × ' +
      fmt(v.w) +
      ' × ' +
      fmt(v.h) +
      ' mm · ' +
      fmt(v.payload) +
      ' kg de carga útil (' +
      fmt(weightRoom) +
      ' kg livres)';
  }

  function renderItems() {
    var missing = {};
    state.unplaced.forEach(function (u) {
      missing[u.id] = (missing[u.id] || 0) + 1;
    });

    var groups = [];
    var order = {};
    state.items.forEach(function (it) {
      var key = it.dest || '';
      if (!(key in order)) {
        order[key] = groups.length;
        groups.push({ name: key, items: [] });
      }
      groups[order[key]].items.push(it);
    });

    els.items.innerHTML = '';
    groups.forEach(function (group) {
      if (group.name) {
        var head = document.createElement('li');
        head.className = 'group-head';
        head.textContent = group.name;
        els.items.appendChild(head);
      }
      group.items.forEach(function (it) {
        var li = document.createElement('li');
        li.className = 'item-row';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'item';
        btn.setAttribute('aria-pressed', state.selected === it.id ? 'true' : 'false');
        btn.dataset.id = String(it.id);

        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.style.background = PALETTE[it.color] || PALETTE.blue;
        chip.setAttribute('aria-hidden', 'true');

        var text = document.createElement('span');
        var name = document.createElement('span');
        name.className = 'item-name';
        name.textContent = it.name;
        if (missing[it.id]) {
          var warn = document.createElement('span');
          warn.className = 'warn';
          warn.textContent = missing[it.id] + ' sem lugar';
          name.appendChild(warn);
        }
        var meta = document.createElement('span');
        meta.className = 'item-meta';
        meta.textContent =
          fmt(it.l) + ' × ' + fmt(it.w) + ' × ' + fmt(it.h) + ' mm · ' + it.qty + ' un · ' + fmt(it.weight) + ' kg';
        text.appendChild(name);
        text.appendChild(meta);

        btn.appendChild(chip);
        btn.appendChild(text);

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.setAttribute('aria-label', 'Remover ' + it.name + ' da lista');
        del.dataset.remove = String(it.id);
        del.textContent = '×';

        li.appendChild(btn);
        li.appendChild(del);
        els.items.appendChild(li);
      });
    });

    els.empty.hidden = state.items.length > 0;
    var units = state.items.reduce(function (sum, it) {
      return sum + it.qty;
    }, 0);
    els.count.textContent = units + (units === 1 ? ' volume' : ' volumes');
  }

  function computeAxles(vehicle, placed) {
    var axles = (vehicle.axles || []).slice().sort(function (a, b) {
      return a.x - b.x;
    });
    var loads = axles.map(function () {
      return 0;
    });
    var cgx = 0;
    var cgz = 0;
    var totalW = 0;

    placed.forEach(function (box) {
      var w = box.weight || 0;
      var cx = box.x + box.l / 2;
      var cz = box.z + box.w / 2;
      cgx += w * cx;
      cgz += w * cz;
      totalW += w;

      if (!axles.length) return;
      if (cx <= axles[0].x) {
        loads[0] += w;
      } else if (cx >= axles[axles.length - 1].x) {
        loads[axles.length - 1] += w;
      } else {
        for (var i = 0; i < axles.length - 1; i++) {
          if (cx >= axles[i].x && cx <= axles[i + 1].x) {
            var span = axles[i + 1].x - axles[i].x;
            if (span <= 0) {
              loads[i] += w / 2;
              loads[i + 1] += w / 2;
            } else {
              loads[i] += (w * (axles[i + 1].x - cx)) / span;
              loads[i + 1] += (w * (cx - axles[i].x)) / span;
            }
            break;
          }
        }
      }
    });

    return {
      axles: axles,
      loads: loads,
      cgx: totalW ? cgx / totalW : 0,
      cgz: totalW ? cgz / totalW : 0,
      totalW: totalW
    };
  }

  function axleStatus(ratio) {
    if (ratio > 1) return 'over';
    if (ratio > 0.9) return 'warn';
    return 'ok';
  }

  function drawAxle(res) {
    var cv = els.axleCanvas;
    if (!cv) return;
    var vehicle = currentVehicle();
    var dpr = window.devicePixelRatio || 1;
    var cssW = cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 720;
    var cssH = 170;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    var ac = cv.getContext('2d');
    if (!ac) return;
    ac.setTransform(dpr, 0, 0, dpr, 0, 0);
    ac.clearRect(0, 0, cssW, cssH);

    var padL = 46;
    var padR = 12;
    var padT = 16;
    var padB = 46;
    var plotW = cssW - padL - padR;
    var plotH = cssH - padT - padB;
    var vL = vehicle.l;
    var vH = vehicle.h;
    var sx = plotW / vL;
    var sy = plotH / vH;

    function X(mm) {
      return padL + mm * sx;
    }
    function Y(mm) {
      return padT + (vH - mm) * sy;
    }

    ac.strokeStyle = '#5c5b5b';
    ac.lineWidth = 2;
    ac.strokeRect(padL, padT, plotW, plotH);

    state.placed.forEach(function (b) {
      var x = X(b.x);
      var y = Y(b.y + b.h);
      var w = b.l * sx;
      var h = b.h * sy;
      ac.fillStyle = PALETTE[b.color] || PALETTE.blue;
      ac.globalAlpha = 0.55;
      ac.fillRect(x, y, w, h);
      ac.globalAlpha = 1;
      ac.strokeStyle = 'rgba(92,91,91,0.5)';
      ac.lineWidth = 1;
      ac.strokeRect(x, y, w, h);
    });

    if (res.totalW > 0) {
      var cgx = X(res.cgx);
      var cgy = padT + plotH * 0.35;
      ac.strokeStyle = '#5fc2ea';
      ac.lineWidth = 2;
      ac.beginPath();
      ac.moveTo(cgx - 7, cgy - 7);
      ac.lineTo(cgx + 7, cgy + 7);
      ac.moveTo(cgx - 7, cgy + 7);
      ac.lineTo(cgx + 7, cgy - 7);
      ac.stroke();
      ac.fillStyle = '#5fc2ea';
      ac.font = '12px Arial, Tahoma, Verdana, sans-serif';
      ac.textAlign = 'center';
      ac.fillText('CG', cgx, cgy - 10);
    }

    res.axles.forEach(function (a, i) {
      var x = X(a.x);
      var ratio = a.limit ? res.loads[i] / a.limit : 0;
      var status = axleStatus(ratio);
      var color = status === 'over' ? '#d64545' : status === 'warn' ? '#e4a934' : '#5f9e54';
      var ay = padT + plotH + 8;
      ac.fillStyle = color;
      ac.strokeStyle = color;
      ac.lineWidth = 2;
      ac.beginPath();
      ac.moveTo(x, ay);
      ac.lineTo(x - 9, ay + 14);
      ac.lineTo(x + 9, ay + 14);
      ac.closePath();
      ac.fill();
      ac.fillStyle = '#5d5d5d';
      ac.font = '12px Arial, Tahoma, Verdana, sans-serif';
      ac.textAlign = 'center';
      ac.fillText(fmt(res.loads[i]) + ' kg', x, ay + 28);
    });
  }

  function renderAxles() {
    var vehicle = currentVehicle();
    var res = computeAxles(vehicle, state.placed);
    var widthCenter = vehicle.w / 2;

    if (els.axleList) {
      els.axleList.innerHTML = '';
      res.axles.forEach(function (a, i) {
        var load = res.loads[i];
        var ratio = a.limit ? load / a.limit : 0;
        var status = axleStatus(ratio);
        var li = document.createElement('li');
        li.className = 'axle-item';
        var dot = document.createElement('span');
        dot.className = 'axle-dot ' + status;
        dot.setAttribute('aria-hidden', 'true');
        var label = document.createElement('span');
        label.className = 'axle-name';
        label.textContent = 'Eixo ' + (i + 1);
        var val = document.createElement('b');
        val.textContent = fmt(load) + ' kg';
        var lim = document.createElement('span');
        lim.className = 'axle-limit';
        lim.textContent = 'máx ' + fmt(a.limit) + ' kg';
        li.appendChild(dot);
        li.appendChild(label);
        li.appendChild(val);
        li.appendChild(lim);
        els.axleList.appendChild(li);
      });
    }

    if (els.axleCog) {
      var latM = (res.cgz - widthCenter) / 1000;
      var latText = Math.abs(latM) < 0.005 ? 'centrado' : latM < 0 ? 'à esquerda' : 'à direita';
      els.axleCog.textContent =
        'Centro de gravidade: ' + fmt(res.cgx / 1000, 2) + ' m da frente · desvio lateral ' +
        (latM >= 0 ? '+' : '') + fmt(latM, 2) + ' m (' + latText + ')';
    }

    drawAxle(res);
  }

  function runPlan() {
    var vehicle = currentVehicle();
    var result = pack(vehicle, state.items);
    state.placed = result.placed;
    state.unplaced = result.unplaced;
    state.totals = result.totals;
    renderItems();
    renderGauges();
    renderStatus();
    renderAxles();
    draw();
  }

  /* -------------------------------------------------------------------- ui --- */
  function selectedVehicleIndexFromUI() {
    var idx = parseInt(els.vehicle.value, 10);
    return isFinite(idx) ? clamp(idx, 0, VEHICLES.length - 1) : 0;
  }

  function fillVehicles() {
    els.vehicle.innerHTML = '';
    VEHICLES.forEach(function (v, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      /* Short name only: a long option string sets the select's minimum width and
         pushes the phone layout past the screen edge. Dimensions live in the
         status bar under the canvas. */
      opt.textContent = v.name;
      els.vehicle.appendChild(opt);
    });
    els.vehicle.value = String(state.vehicleIndex);
  }

  function addItemFromForm(event) {
    if (event) event.preventDefault();

    var name = els.name.value.trim();
    var l = Math.round(num(els.length.value, 0));
    var w = Math.round(num(els.width.value, 0));
    var h = Math.round(num(els.height.value, 0));
    var weight = Math.round(num(els.weight.value, 0));
    var qty = Math.round(num(els.qty.value, 0));
    var vehicle = currentVehicle();

    if (!name) {
      els.formMsg.textContent = 'Dê um nome ao volume.';
      els.name.focus();
      return;
    }
    if (l < 50 || w < 50 || h < 20) {
      els.formMsg.textContent = 'As medidas têm de ser pelo menos 50 × 50 × 20 mm.';
      return;
    }
    if (l > vehicle.l || w > vehicle.w || h > vehicle.h) {
      els.formMsg.textContent =
        'Um volume maior do que o ' + vehicle.name + ' nunca vai caber.';
      return;
    }
    if (qty < 1 || qty > 500) {
      els.formMsg.textContent = 'A quantidade tem de ficar entre 1 e 500.';
      return;
    }

    els.formMsg.textContent = '';
    state.items.push({
      id: nextId++,
      name: name.slice(0, 28),
      l: l,
      w: w,
      h: h,
      weight: weight,
      qty: qty,
      color: PALETTE[els.color.value] ? els.color.value : 'blue',
      dest: els.dest ? els.dest.value.trim().slice(0, 40) : ''
    });
    state.selected = null;
    save();
    runPlan();
  }

  function setDemo() {
    state.items = DEMO.map(function (it) {
      return {
        id: nextId++,
        name: it.name,
        l: it.l,
        w: it.w,
        h: it.h,
        weight: it.weight,
        qty: it.qty,
        color: it.color,
        dest: it.dest || ''
      };
    });
    state.selected = null;
    save();
    runPlan();
  }

  function clearAll() {
    state.items = [];
    state.selected = null;
    save();
    runPlan();
  }

  function setView(kind) {
    if (kind === 'top') {
      state.view.az = Math.PI / 2;
      state.view.elev = 1.54;
    } else if (kind === 'side') {
      state.view.az = 0;
      state.view.elev = 0.04;
    } else if (kind === 'left') {
      state.view.az = -Math.PI / 2;
      state.view.elev = 0.04;
    } else if (kind === 'right') {
      state.view.az = Math.PI / 2;
      state.view.elev = 0.04;
    } else {
      state.view.az = 0.95;
      state.view.elev = 0.42;
    }
    state.view.zoom = 1;
    Array.prototype.forEach.call(els.viewButtons, function (b) {
      var on = b.dataset.view === kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    draw();
  }

  function wireCanvas() {
    var dragging = false;
    var lastX = 0;
    var lastY = 0;

    els.canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      if (els.canvas.setPointerCapture) els.canvas.setPointerCapture(e.pointerId);
    });

    els.canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX;
      var dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      state.view.az -= dx * 0.009;
      state.view.elev = clamp(state.view.elev + dy * 0.006, 0.04, 1.54);
      draw();
    });

    function stop(e) {
      dragging = false;
      if (els.canvas.releasePointerCapture && e.pointerId !== undefined) {
        try {
          els.canvas.releasePointerCapture(e.pointerId);
        } catch (err) {
          /* pointer already gone */
        }
      }
    }

    els.canvas.addEventListener('pointerup', stop);
    els.canvas.addEventListener('pointercancel', stop);
    els.canvas.addEventListener('pointerleave', function () {
      dragging = false;
    });

    els.canvas.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        var factor = e.deltaY > 0 ? 0.92 : 1.08;
        state.view.zoom = clamp(state.view.zoom * factor, 0.55, 2.4);
        draw();
      },
      { passive: false }
    );

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(draw, 80);
    });

    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        draw();
      }).observe(els.canvas);
    }
  }

  function setMenu(open) {
    if (!els.navToggle || !els.topbar) return;
    if (open) {
      els.topbar.classList.add('menu-open');
    } else {
      els.topbar.classList.remove('menu-open');
    }
    els.navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function wireUi() {
    if (els.navToggle) {
      els.navToggle.addEventListener('click', function () {
        setMenu(els.navToggle.getAttribute('aria-expanded') !== 'true');
      });
    }

    els.vehicle.addEventListener('change', function () {
      state.vehicleIndex = selectedVehicleIndexFromUI();
      state.selected = null;
      save();
      runPlan();
    });

    els.form.addEventListener('submit', addItemFromForm);
    els.plan.addEventListener('click', function () {
      setMenu(false);
      runPlan();
    });
    els.demo.addEventListener('click', function () {
      setMenu(false);
      setDemo();
    });
    els.clear.addEventListener('click', function () {
      setMenu(false);
      clearAll();
    });
    if (els.report) {
      els.report.addEventListener('click', function () {
        if (typeof window.print === 'function') window.print();
      });
    }

    els.items.addEventListener('click', function (e) {
      var del = e.target.closest('[data-remove]');
      if (del) {
        var id = parseInt(del.dataset.remove, 10);
        state.items = state.items.filter(function (it) {
          return it.id !== id;
        });
        if (state.selected === id) state.selected = null;
        save();
        runPlan();
        return;
      }
      var row = e.target.closest('.item');
      if (!row) return;
      var rowId = parseInt(row.dataset.id, 10);
      state.selected = state.selected === rowId ? null : rowId;
      renderItems();
      draw();
    });

    Array.prototype.forEach.call(els.viewButtons, function (b) {
      b.addEventListener('click', function () {
        setView(b.dataset.view);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      setMenu(false);
      if (state.selected !== null) {
        state.selected = null;
        renderItems();
        draw();
      }
    });
  }

  function cacheEls() {
    els.canvas = $('#view');
    els.items = $('#items');
    els.empty = $('#empty');
    els.count = $('#cargo-count');
    els.form = $('#item-form');
    els.formMsg = $('#form-msg');
    els.name = $('#f-name');
    els.length = $('#f-l');
    els.width = $('#f-w');
    els.height = $('#f-h');
    els.weight = $('#f-weight');
    els.qty = $('#f-qty');
    els.color = $('#f-color');
    els.dest = $('#f-dest');
    els.vehicle = $('#vehicle');
    els.plan = $('#plan');
    els.demo = $('#demo');
    els.clear = $('#clear');
    els.report = $('#report');
    els.status = $('#status');
    els.dims = $('#vehicle-dims');
    els.navToggle = $('#nav-toggle');
    els.topbar = $('#topbar');
    els.axleCanvas = $('#axle-view');
    els.axleList = $('#axle-list');
    els.axleCog = $('#axle-cog');
    els.viewButtons = document.querySelectorAll('[data-view]');
    els.gauges = {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-gauge]'), function (g) {
      els.gauges[g.dataset.gauge] = {
        root: g,
        bar: g.querySelector('.bar i'),
        value: g.querySelector('b')
      };
    });
  }

  function init() {
    cacheEls();
    if (!els.canvas || !els.items) return;
    ctx = els.canvas.getContext('2d');

    if (!load()) {
      state.items = DEMO.map(function (it) {
        return {
          id: nextId++,
          name: it.name,
          l: it.l,
          w: it.w,
          h: it.h,
          weight: it.weight,
          qty: it.qty,
          color: it.color,
          dest: it.dest || ''
        };
      });
    }

    fillVehicles();
    wireUi();
    wireCanvas();
    runPlan();
    setView('3d');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
