/* Syncrofin 3D Planner — a load planner for trucks and containers.
   Everything runs in the browser: the cargo list is packed into the chosen
   vehicle by a simple extreme-point heuristic and drawn on a canvas with a
   hand-written 3D projection. No libraries. */

(function () {
  'use strict';

  /* --------------------------------------------------------- cargo spaces --- */
  /* The vehicles and containers live in spaces.js (window.SyncrofinSpaces):
     the built-in catalogue, the user's own spaces, favourites and the axle
     arithmetic. */
  var Spaces = window.SyncrofinSpaces;

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
    spaceId: Spaces.DEFAULT_SPACE,
    tractorId: Spaces.DEFAULT_TRACTOR, /* '' = semitrailer without a tractor */
    items: [],
    placed: [],
    unplaced: [],
    totals: { count: 0, volume: 0, weight: 0, area: 0 },
    selected: null,
    view: { az: -2.3, elev: 0.4, zoom: 1 }
  };

  var els = {};
  var ctx = null;
  var nextId = 1;
  var sceneDirty = true; /* the WebGL scene needs rebuilding (a new plan) */

  /* What the WebGL view needs to build its scene. */
  function sceneData() {
    var names = {};
    state.items.forEach(function (it) {
      names[it.id] = it.name;
    });
    return {
      space: currentVehicle(),
      tractor: currentTractor(),
      placed: state.placed,
      names: names,
      palette: PALETTE
    };
  }

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

  function fmtWeight(kg) {
    /* whole kilos as before; imported weights keep the decimals they had */
    var d = Math.abs(kg - Math.round(kg)) < 0.005 ? 0 : Math.abs(kg * 10 - Math.round(kg * 10)) < 0.05 ? 1 : 2;
    return fmt(kg, d);
  }

  function currentVehicle() {
    var s = Spaces.get(state.spaceId);
    if (!s || Spaces.isTractor(s)) s = Spaces.get(Spaces.DEFAULT_SPACE);
    return s;
  }

  /* The tractor unit pulling the chosen semitrailer, or null. */
  function currentTractor() {
    if (!Spaces.takesTractor(currentVehicle()) || !state.tractorId) return null;
    var t = Spaces.get(state.tractorId);
    return t && Spaces.isTractor(t) ? t : null;
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
        JSON.stringify({ space: state.spaceId, tractor: state.tractorId, items: state.items })
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
      if (typeof data.space === 'string') {
        state.spaceId = data.space;
        state.tractorId = typeof data.tractor === 'string' ? data.tractor : Spaces.DEFAULT_TRACTOR;
      } else {
        /* saved before cargo spaces: the vehicle was an index into a fixed list */
        var legacy = Spaces.LEGACY_ORDER[clamp(Math.round(num(data.vehicle, 2)), 0, Spaces.LEGACY_ORDER.length - 1)];
        state.spaceId = legacy || Spaces.DEFAULT_SPACE;
      }
      if (!Spaces.get(state.spaceId)) state.spaceId = Spaces.DEFAULT_SPACE;
      state.items = data.items
        .filter(function (it) {
          return it && typeof it.name === 'string';
        })
        .map(function (it) {
          return {
            id: it.id || nextId++,
            name: String(it.name).slice(0, 28),
            l: clamp(num(it.l, 1200), 50, Spaces.LIMITS.l[1]),
            w: clamp(num(it.w, 800), 50, Spaces.LIMITS.w[1]),
            h: clamp(num(it.h, 1000), 20, Spaces.LIMITS.h[1]),
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
      /* floor used: only what stands on the floor (stacked boxes sit on others,
         and counting them pushed the gauge past 100%) */
      if (b.y < 0.5) area += (b.l * b.w) / 1e6;
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

    /* WebGL view (scene3d.js) when the browser has it: this canvas then stays
       clear, on top, for the pointer and the description. */
    var gl = window.SyncrofinScene;
    if (gl && gl.active) {
      if (sceneDirty) {
        gl.update(sceneData());
        sceneDirty = false;
      }
      gl.render(state.view, state.selected);
      canvas.setAttribute(
        'aria-label',
        'Vista tridimensional de ' + currentVehicle().name + ' com ' + state.totals.count + ' volumes colocados.'
      );
      return;
    }

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

    var tractor = currentTractor();
    els.dims.textContent =
      v.name +
      (tractor ? ' + ' + tractor.name : '') +
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
          fmt(it.l) + ' × ' + fmt(it.w) + ' × ' + fmt(it.h) + ' mm · ' + it.qty + ' un · ' + fmtWeight(it.weight) + ' kg';
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

  /* Centre of gravity of the placed cargo, then the load on every support:
     the space's own axles, its kingpin and, for a semitrailer, the axles of
     the tractor that carries the kingpin. Loads include the tare weights. */
  function computeAxles(vehicle, placed) {
    var cgx = 0;
    var cgz = 0;
    var totalW = 0;
    placed.forEach(function (box) {
      var w = box.weight || 0;
      cgx += w * (box.x + box.l / 2);
      cgz += w * (box.z + box.w / 2);
      totalW += w;
    });
    var cargo = {
      weight: totalW,
      cgx: totalW ? cgx / totalW : vehicle.l / 2,
      cgz: totalW ? cgz / totalW : vehicle.w / 2
    };
    var res = Spaces.axleLoads(vehicle, currentTractor(), cargo);
    res.cgx = cargo.cgx;
    res.cgz = cargo.cgz;
    res.totalW = totalW;
    return res;
  }

  var AXLE_COLORS = { over: '#d64545', warn: '#e4a934', ok: '#5f9e54' };

  function drawAxle(res) {
    var cv = els.axleCanvas;
    if (!cv) return;
    var vehicle = currentVehicle();
    var tractor = currentTractor();
    var kind = (Spaces.typeOf(vehicle.type) || {}).kind;
    var dpr = window.devicePixelRatio || 1;
    var cssW = cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 720;
    var cssH = 170;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    var ac = cv.getContext('2d');
    if (!ac) return;
    ac.setTransform(dpr, 0, 0, dpr, 0, 0);
    ac.clearRect(0, 0, cssW, cssH);

    /* The drawing spans the cargo space and whatever sits ahead of it: a
       lorry's cab over its front axle, or the tractor pulling a semitrailer. */
    var minX = 0;
    var maxX = vehicle.l;
    res.rows.forEach(function (r) {
      minX = Math.min(minX, r.x);
      maxX = Math.max(maxX, r.x);
    });
    var cabFront = 0;
    if (kind === 'lorry' || tractor) cabFront = Math.min(minX - 700, -1700);
    minX = Math.min(minX, cabFront);
    if (maxX > vehicle.l) maxX += 400;

    var padL = minX < 0 ? 16 : 46;
    var padR = 12;
    var padT = 16;
    var padB = 46;
    var plotW = cssW - padL - padR;
    var plotH = cssH - padT - padB;
    var vH = vehicle.h;
    var sx = plotW / (maxX - minX);
    var sy = plotH / vH;

    function X(mm) {
      return padL + (mm - minX) * sx;
    }
    function Y(mm) {
      return padT + (vH - mm) * sy;
    }

    var floorY = padT + plotH;
    ac.font = '12px Arial, Tahoma, Verdana, sans-serif';
    ac.textAlign = 'center';

    /* cab and chassis ahead of the cargo space */
    if (cabFront < 0) {
      var cabRear = tractor ? Math.min(res.rows[0].x + 1700, (vehicle.axles[0] || { dist: 0 }).dist - 300) : -150;
      cabRear = Math.max(cabRear, cabFront + 900);
      ac.fillStyle = '#d5dbe0';
      ac.strokeStyle = '#5c5b5b';
      ac.lineWidth = 1.5;
      var cabTop = padT + plotH * 0.18;
      ac.beginPath();
      ac.moveTo(X(cabFront), floorY);
      ac.lineTo(X(cabFront), cabTop + 10);
      ac.lineTo(X(cabFront) + 10, cabTop);
      ac.lineTo(X(cabRear), cabTop);
      ac.lineTo(X(cabRear), floorY);
      ac.closePath();
      ac.fill();
      ac.stroke();
      if (tractor) {
        /* chassis from the cab back past the fifth wheel */
        var chassisEnd = res.rows.reduce(function (m, r) {
          return r.part === 'tractor' ? Math.max(m, r.x) : m;
        }, 0) + 500;
        ac.fillStyle = '#5c5b5b';
        ac.fillRect(X(cabFront), floorY + 2, X(chassisEnd) - X(cabFront), 4);
      }
    }

    /* the cargo space with what was placed in it */
    ac.strokeStyle = '#5c5b5b';
    ac.lineWidth = 2;
    ac.strokeRect(X(0), padT, vehicle.l * sx, plotH);

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
      ac.fillText('CG', cgx, cgy - 10);
    }

    if (!res.rows.length) {
      ac.fillStyle = '#5d5d5d';
      ac.fillText('Sem eixos próprios: escolha um camião, reboque ou semirreboque para ver as cargas por eixo.', cssW / 2, floorY + 30);
      return;
    }

    res.rows.forEach(function (r) {
      var x = X(r.x);
      var color = AXLE_COLORS[r.status] || AXLE_COLORS.ok;
      var ay = floorY + 8;
      if (r.part === 'kingpin') {
        /* the kingpin: a pin under the floor */
        ac.fillStyle = r.info ? '#5c5b5b' : color;
        ac.fillRect(x - 3, floorY, 6, 10);
        if (r.info) return; /* its load is already on the tractor's axles */
        ac.fillStyle = '#5d5d5d';
        ac.fillText(fmt(r.load) + ' kg', x, ay + 28);
        ac.fillText('PR', x, ay + 14);
        return;
      }
      ac.fillStyle = color;
      ac.beginPath();
      ac.moveTo(x, ay);
      ac.lineTo(x - 9, ay + 14);
      ac.lineTo(x + 9, ay + 14);
      ac.closePath();
      ac.fill();
      ac.fillStyle = '#5d5d5d';
      ac.fillText(fmt(r.load) + ' kg', x, ay + 28);
    });
  }

  function renderAxles() {
    var vehicle = currentVehicle();
    var res = computeAxles(vehicle, state.placed);

    if (els.axleList) {
      els.axleList.innerHTML = '';
      if (!res.rows.length) {
        var none = document.createElement('li');
        none.className = 'axle-none';
        none.textContent = 'Este espaço de carga não tem eixos próprios.';
        els.axleList.appendChild(none);
      }
      res.rows.forEach(function (r) {
        var li = document.createElement('li');
        li.className = 'axle-item' + (r.info ? ' info' : '') + (r.part === 'tractor' ? ' tractor' : '');
        var dot = document.createElement('span');
        dot.className = 'axle-dot ' + (r.info ? 'info' : r.status);
        dot.setAttribute('aria-hidden', 'true');
        var label = document.createElement('span');
        label.className = 'axle-name';
        label.textContent = (r.part === 'tractor' ? 'Cavalo · ' : '') + r.label + ' (' + r.letter + ')';
        var val = document.createElement('b');
        val.textContent = fmt(r.load) + ' kg';
        var lim = document.createElement('span');
        lim.className = 'axle-limit';
        lim.textContent = r.info
          ? 'apoiado no cavalo · máx ' + fmt(r.max) + ' kg'
          : 'máx ' + fmt(r.max) + ' kg · E ' + fmt(r.left) + ' · D ' + fmt(r.right);
        li.title =
          r.label + ': ' + fmt(r.cargo) + ' kg de carga + ' + fmt(r.tare) + ' kg de tara. Rodas: esquerda ' +
          fmt(r.left) + ' kg, direita ' + fmt(r.right) + ' kg.';
        li.appendChild(dot);
        li.appendChild(label);
        li.appendChild(val);
        li.appendChild(lim);
        els.axleList.appendChild(li);
      });
    }

    if (els.axleCog) {
      var latM = (res.cgz - vehicle.w / 2) / 1000;
      var latText = Math.abs(latM) < 0.005 ? 'centrado' : latM < 0 ? 'à esquerda' : 'à direita';
      var text =
        'Centro de gravidade: ' + fmt(res.cgx / 1000, 2) + ' m da frente · desvio lateral ' +
        (latM >= 0 ? '+' : '') + fmt(latM, 2) + ' m (' + latText + ')';
      if (res.rows.length && res.totalW > 0) {
        text += ' · carga nas rodas ' + Math.round(res.leftShare * 100) + '% esq. / ' +
          Math.round((1 - res.leftShare) * 100) + '% dir.';
      }
      if (Spaces.takesTractor(vehicle) && !currentTractor()) {
        text += ' · sem cavalo: só se calcula a carga no pino-rei.';
      }
      els.axleCog.textContent = text;
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
    sceneDirty = true;
    draw();
    notifyPlan();
  }

  /* -------------------------------------------------------------------- ui --- */
  /* What the cargo-space screens (spaces-ui.js) read from the planner. */
  function planSummary() {
    var listWeight = 0;
    var listVolume = 0;
    state.items.forEach(function (it) {
      listWeight += it.weight * it.qty;
      listVolume += (it.l * it.w * it.h * it.qty) / 1e9;
    });
    var used = 0;
    state.placed.forEach(function (b) {
      used = Math.max(used, b.x + b.l);
    });
    return {
      space: currentVehicle(),
      tractor: currentTractor(),
      tractorId: state.tractorId,
      totals: state.totals,
      listWeight: listWeight,
      listVolume: listVolume,
      usedLength: used,
      unplaced: state.unplaced.length
    };
  }

  /* Chooses the cargo space (and, for a semitrailer, its tractor: '' for none)
     and plans the load again. */
  function selectSpace(spaceId, tractorId) {
    var s = Spaces.get(spaceId);
    if (!s || Spaces.isTractor(s)) return false;
    state.spaceId = s.id;
    if (tractorId !== undefined) state.tractorId = tractorId || '';
    state.selected = null;
    save();
    runPlan();
    return true;
  }

  /* After the catalogue changed: the chosen space or tractor may be gone. */
  function refreshSpaces() {
    var s = Spaces.get(state.spaceId);
    if (!s || Spaces.isTractor(s)) state.spaceId = Spaces.DEFAULT_SPACE;
    if (state.tractorId) {
      var t = Spaces.get(state.tractorId);
      if (!t || !Spaces.isTractor(t)) state.tractorId = Spaces.get(Spaces.DEFAULT_TRACTOR) ? Spaces.DEFAULT_TRACTOR : '';
    }
    save();
    runPlan();
  }

  var planListeners = [];

  function notifyPlan() {
    var summary = planSummary();
    planListeners.forEach(function (fn) {
      try {
        fn(summary);
      } catch (e) {
        /* a broken listener must not stop the planner */
      }
    });
  }

  window.SyncrofinApp = {
    summary: planSummary,
    select: selectSpace,
    refresh: refreshSpaces,
    onPlan: function (fn) {
      planListeners.push(fn);
    },
    closeMenu: function () {
      setMenu(false);
    },
    /* the WebGL view arrived: build its scene and draw */
    redraw: function () {
      sceneDirty = true;
      draw();
    }
  };

  function addItemFromForm(event) {
    if (event) event.preventDefault();
    els.formMsg.classList.remove('ok');

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

  /* ---------------------------------------------------------------- import --- */
  /* Cargo can be read from a spreadsheet: a CSV file (separated by ; , or tab,
     as Excel saves it in any locale) or an Excel .xlsx workbook. An .xlsx file
     is a zip of XML parts; it is unpacked with the browser's own
     DecompressionStream, so no library is needed. Only the first sheet is read.
     Columns are found by their header (Descrição, Comprimento, Largura, Altura,
     Peso, Quantidade, Destino, Cor, or the English names); without a header
     the columns are taken in that order. Imported rows are added to the list. */

  var IMPORT_MAX_BYTES = 10 * 1024 * 1024;

  var COLOR_WORDS = {
    azul: 'blue', blue: 'blue',
    amarelo: 'yellow', amarela: 'yellow', yellow: 'yellow',
    verde: 'green', green: 'green',
    laranja: 'orange', orange: 'orange',
    cinza: 'grey', cinzento: 'grey', grey: 'grey', gray: 'grey'
  };
  var COLOR_CYCLE = ['blue', 'yellow', 'green', 'orange', 'grey'];
  var COLOR_LABEL = { blue: 'Azul', yellow: 'Amarelo', green: 'Verde', orange: 'Laranja', grey: 'Cinza' };

  var FIELD_ALIASES = {
    name: ['descricao', 'desc', 'nome', 'item', 'produto', 'artigo', 'mercadoria', 'name', 'description', 'product'],
    l: ['comprimento', 'comp', 'compr', 'c', 'length', 'len'],
    w: ['largura', 'larg', 'width', 'w'],
    h: ['altura', 'alt', 'a', 'height', 'h'],
    weight: ['peso', 'massa', 'kg', 'weight'],
    qty: ['quantidade', 'qtd', 'qtde', 'quant', 'unidades', 'unid', 'un', 'pecas', 'qty', 'quantity', 'units', 'pcs'],
    dest: ['destino', 'grupo', 'cliente', 'destinatario', 'destination', 'group', 'customer'],
    color: ['cor', 'color', 'colour']
  };
  var POSITIONAL = ['name', 'l', 'w', 'h', 'weight', 'qty', 'dest', 'color'];

  function cellText(v) {
    return v === undefined || v === null ? '' : String(v).trim();
  }

  function headerTokens(text) {
    return cellText(text)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);
  }

  /* "1.200,5", "1,200.5", "1200,5", "1 200" and "120 kg" all read as numbers. */
  function parseNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var s = cellText(v).replace(/[\s ]/g, '').replace(/[^\d.,\-]/g, '');
    if (!s || !/\d/.test(s)) return NaN;
    var lastDot = s.lastIndexOf('.');
    var lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      var dec = lastDot > lastComma ? '.' : ',';
      var thou = dec === '.' ? ',' : '.';
      s = s.split(thou).join('').replace(dec, '.');
    } else if (lastComma >= 0) {
      s = /^-?\d{1,3}(,\d{3}){2,}$/.test(s) ? s.split(',').join('') : s.replace(',', '.');
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.split('.').join('');
    }
    var n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }

  /* Reads a header row; returns null when the row does not look like one. */
  function headerMap(cells) {
    var cols = {};
    var unit = {};
    var weightTotal = false;
    var hits = 0;
    var ambiguousL = [];

    cells.forEach(function (cell, idx) {
      var tokens = headerTokens(cell);
      if (!tokens.length) return;
      var first = tokens[0];
      var field = null;
      if (first === 'l') {
        ambiguousL.push({ idx: idx, tokens: tokens });
        hits++;
        return;
      }
      Object.keys(FIELD_ALIASES).some(function (f) {
        if (FIELD_ALIASES[f].indexOf(first) >= 0) {
          field = f;
          return true;
        }
        return false;
      });
      if (!field) return;
      hits++;
      if (cols[field] !== undefined) return;
      cols[field] = idx;
      unit[field] = tokens.slice(1);
      if (field === 'weight' && tokens.indexOf('total') >= 0) weightTotal = true;
    });

    /* "L" is length in L × W × H and width in C × L × A. */
    ambiguousL.forEach(function (a) {
      var field = cols.l === undefined ? 'l' : cols.w === undefined ? 'w' : null;
      if (!field) return;
      cols[field] = a.idx;
      unit[field] = a.tokens.slice(1);
    });

    if (hits < 2) return null;

    function lengthFactor(tokens) {
      if (!tokens) return 1;
      if (tokens.indexOf('cm') >= 0) return 10;
      if (tokens.indexOf('m') >= 0 || tokens.indexOf('metro') >= 0 || tokens.indexOf('metros') >= 0) return 1000;
      return 1;
    }
    function weightFactor(tokens) {
      if (!tokens) return 1;
      if (tokens.indexOf('t') >= 0 || tokens.indexOf('ton') >= 0 || tokens.indexOf('toneladas') >= 0) return 1000;
      if (tokens.indexOf('g') >= 0 || tokens.indexOf('gramas') >= 0) return 0.001;
      return 1;
    }

    return {
      cols: cols,
      factor: {
        l: lengthFactor(unit.l),
        w: lengthFactor(unit.w),
        h: lengthFactor(unit.h),
        weight: weightFactor(unit.weight)
      },
      weightTotal: weightTotal
    };
  }

  function positionalMap(firstRow) {
    /* No header: the usual order, without the description when the first
       column already holds a number. */
    var order = isFinite(parseNumber(firstRow[0])) ? POSITIONAL.slice(1) : POSITIONAL;
    var cols = {};
    order.forEach(function (f, i) {
      cols[f] = i;
    });
    return { cols: cols, factor: { l: 1, w: 1, h: 1, weight: 1 }, weightTotal: false };
  }

  /* rows: [{ line: <row number in the file>, cells: [...] }] */
  function rowsToItems(rows, vehicle) {
    var data = rows.filter(function (r) {
      return r.cells.some(function (c) {
        return cellText(c) !== '';
      });
    });
    if (!data.length) return { error: 'A planilha está vazia.' };

    var map = null;
    var start = 0;
    for (var i = 0; i < Math.min(5, data.length); i++) {
      map = headerMap(data[i].cells);
      if (map) {
        start = i + 1;
        break;
      }
    }
    if (!map) map = positionalMap(data[0].cells);

    var cols = map.cols;
    if (cols.l === undefined || cols.w === undefined || cols.h === undefined) {
      return { error: 'Não encontrei as colunas de comprimento, largura e altura na planilha.' };
    }

    var items = [];
    var skipped = [];
    var colorTurn = 0;

    function get(cells, field) {
      return cols[field] === undefined ? undefined : cells[cols[field]];
    }

    for (var r = start; r < data.length; r++) {
      var row = data[r];
      var cells = row.cells;
      var l = Math.round(parseNumber(get(cells, 'l')) * map.factor.l);
      var w = Math.round(parseNumber(get(cells, 'w')) * map.factor.w);
      var h = Math.round(parseNumber(get(cells, 'h')) * map.factor.h);
      var qtyRaw = parseNumber(get(cells, 'qty'));
      var qty = isFinite(qtyRaw) ? Math.round(qtyRaw) : 1;
      var weightRaw = parseNumber(get(cells, 'weight'));
      var weight = isFinite(weightRaw) ? weightRaw * map.factor.weight : 0;
      if (map.weightTotal && qty > 0) weight = weight / qty;
      weight = Math.round(weight * 100) / 100;

      var reason = null;
      if (!isFinite(l) || !isFinite(w) || !isFinite(h)) reason = 'medidas em falta';
      else if (l < 50 || w < 50 || h < 20) reason = 'medidas abaixo de 50 × 50 × 20 mm';
      else if (l > vehicle.l || w > vehicle.w || h > vehicle.h) reason = 'não cabe no ' + vehicle.name;
      else if (qty < 1 || qty > 500) reason = 'quantidade fora de 1 a 500';
      else if (!(weight >= 0) || weight > 30000) reason = 'peso inválido';
      if (reason) {
        skipped.push({ line: row.line, reason: reason });
        continue;
      }

      var colorWord = headerTokens(get(cells, 'color'))[0];
      var color = COLOR_WORDS[colorWord] || COLOR_CYCLE[colorTurn++ % COLOR_CYCLE.length];
      var name = cellText(get(cells, 'name')) || 'Volume ' + (items.length + 1);

      items.push({
        name: name.slice(0, 28),
        l: l,
        w: w,
        h: h,
        weight: weight,
        qty: qty,
        color: color,
        dest: cellText(get(cells, 'dest')).slice(0, 40)
      });
    }

    return { items: items, skipped: skipped };
  }

  /* ---- CSV ---- */
  function decodeText(bytes) {
    var text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      /* Excel on Windows saves CSV in the ANSI code page */
      text = new TextDecoder('windows-1252').decode(bytes);
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  function detectDelimiter(text) {
    var firstLine = text.split(/\r?\n/).filter(function (s) {
      return s.trim() !== '';
    })[0] || '';
    var counts = { ';': 0, '\t': 0, ',': 0 };
    var quoted = false;
    for (var i = 0; i < firstLine.length; i++) {
      var ch = firstLine[i];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch in counts) counts[ch]++;
    }
    var best = ';';
    [';', '\t', ','].forEach(function (d) {
      if (counts[d] > counts[best]) best = d;
    });
    return best;
  }

  function parseCsv(text) {
    var delim = detectDelimiter(text);
    var rows = [];
    var row = [];
    var field = '';
    var quoted = false;
    var line = 1;
    var rowLine = 1;

    function endField() {
      row.push(field);
      field = '';
    }
    function endRow() {
      endField();
      rows.push({ line: rowLine, cells: row });
      row = [];
    }

    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          if (ch === '\n') line++;
          field += ch;
        }
      } else if (ch === '"' && field === '') {
        quoted = true;
      } else if (ch === delim) {
        endField();
      } else if (ch === '\r') {
        /* handled with the \n that follows */
      } else if (ch === '\n') {
        endRow();
        line++;
        rowLine = line;
      } else {
        field += ch;
      }
    }
    if (field !== '' || row.length) endRow();
    return rows;
  }

  /* ---- XLSX ---- */
  function readZip(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('zip');
    var count = view.getUint16(eocd + 10, true);
    var p = view.getUint32(eocd + 16, true);
    var utf8 = new TextDecoder('utf-8');
    var entries = {};
    for (var n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error('zip');
      var method = view.getUint16(p + 10, true);
      var size = view.getUint32(p + 20, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      var local = view.getUint32(p + 42, true);
      var name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      var start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      entries[name] = { method: method, data: bytes.subarray(start, start + size) };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  function unzipText(entries, name) {
    var entry = entries[name];
    if (!entry) return Promise.resolve(null);
    var utf8 = new TextDecoder('utf-8');
    if (entry.method === 0) return Promise.resolve(utf8.decode(entry.data));
    if (entry.method !== 8) return Promise.reject(new Error('zip'));
    var stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (buf) {
      return utf8.decode(new Uint8Array(buf));
    });
  }

  function xmlDecode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (m, e) {
      var k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    });
  }

  function xmlAttr(attrs, name) {
    var m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(attrs);
    return m ? xmlDecode(m[1]) : null;
  }

  function xmlTexts(xml) {
    /* the text of every <t> inside a string, without phonetic hints */
    var out = '';
    var re = /<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g;
    var m;
    xml = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
    while ((m = re.exec(xml))) out += m[1] ? xmlDecode(m[1]) : '';
    return out;
  }

  function columnIndex(ref) {
    var letters = /^[A-Z]+/i.exec(ref || '');
    if (!letters) return -1;
    var n = 0;
    var s = letters[0].toUpperCase();
    for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  function parseSheet(xml, shared) {
    var rows = [];
    var rowRe = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
    var cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    var rm;
    var nextLine = 1;
    while ((rm = rowRe.exec(xml))) {
      var line = parseInt(xmlAttr(rm[1], 'r'), 10) || nextLine;
      nextLine = line + 1;
      var cells = [];
      var col = 0;
      var cm;
      var body = rm[2] || '';
      cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(body))) {
        var ref = xmlAttr(cm[1], 'r');
        var idx = ref ? columnIndex(ref) : col;
        if (idx < 0) idx = col;
        col = idx + 1;
        var type = xmlAttr(cm[1], 't') || 'n';
        var inner = cm[2] || '';
        var vm = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner);
        var raw = vm ? xmlDecode(vm[1]) : '';
        var value;
        if (type === 's') value = shared[parseInt(raw, 10)] || '';
        else if (type === 'inlineStr') value = xmlTexts(inner);
        else if (type === 'n') value = raw === '' ? '' : parseFloat(raw);
        else if (type === 'e') value = '';
        else value = raw;
        cells[idx] = value;
      }
      for (var k = 0; k < cells.length; k++) if (cells[k] === undefined) cells[k] = '';
      rows.push({ line: line, cells: cells });
    }
    return rows;
  }

  function parseXlsx(bytes) {
    var entries;
    try {
      entries = readZip(bytes);
    } catch (e) {
      return Promise.reject(new Error('O ficheiro .xlsx está danificado.'));
    }
    if (!entries['xl/workbook.xml']) {
      return Promise.reject(new Error('Este ficheiro não é uma planilha Excel (.xlsx). Guarde-a como .xlsx ou .csv.'));
    }
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('Este navegador não abre ficheiros .xlsx. Guarde a planilha como .csv e importe de novo.'));
    }
    return Promise.all([
      unzipText(entries, 'xl/workbook.xml'),
      unzipText(entries, 'xl/_rels/workbook.xml.rels'),
      unzipText(entries, 'xl/sharedStrings.xml')
    ]).then(function (parts) {
      var sheetPath = null;
      var first = /<(?:\w+:)?sheet\b([^>]*)\/?>/.exec(parts[0] || '');
      var rid = first ? xmlAttr(first[1], 'r:id') : null;
      if (rid && parts[1]) {
        var relRe = /<(?:\w+:)?Relationship\b([^>]*)\/?>/g;
        var rel;
        while ((rel = relRe.exec(parts[1]))) {
          if (xmlAttr(rel[1], 'Id') === rid) {
            var target = xmlAttr(rel[1], 'Target') || '';
            sheetPath = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
            break;
          }
        }
      }
      if (!sheetPath || !entries[sheetPath]) {
        sheetPath = Object.keys(entries).filter(function (k) {
          return /^xl\/worksheets\/[^/]+\.xml$/.test(k);
        }).sort()[0];
      }
      if (!sheetPath) throw new Error('A planilha não tem nenhuma folha.');

      var shared = [];
      var siRe = /<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g;
      var si;
      while ((si = siRe.exec(parts[2] || ''))) shared.push(si[1] ? xmlTexts(si[1]) : '');

      return unzipText(entries, sheetPath).then(function (xml) {
        return parseSheet(xml || '', shared);
      });
    });
  }

  /* bytes: Uint8Array of the chosen file */
  function readSpreadsheet(bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return parseXlsx(bytes);
    }
    if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      return Promise.reject(new Error('Ficheiros .xls antigos não são lidos. No Excel, guarde a planilha como .xlsx ou .csv.'));
    }
    try {
      return Promise.resolve(parseCsv(decodeText(bytes)));
    } catch (e) {
      return Promise.reject(new Error('Não consegui ler o ficheiro como CSV.'));
    }
  }

  function setMsg(text, ok) {
    els.formMsg.textContent = text;
    els.formMsg.classList[ok ? 'add' : 'remove']('ok');
  }

  function importReport(fileName, result) {
    var units = result.items.reduce(function (s, it) {
      return s + it.qty;
    }, 0);
    var msg = '';
    if (result.items.length) {
      msg =
        'Importados ' + result.items.length + (result.items.length === 1 ? ' item' : ' itens') +
        ' (' + units + (units === 1 ? ' volume' : ' volumes') + ') de ' + fileName + '.';
    } else {
      msg = 'Nenhuma linha de ' + fileName + ' foi importada.';
    }
    if (result.skipped.length) {
      var shown = result.skipped.slice(0, 3).map(function (s) {
        return 'linha ' + s.line + ': ' + s.reason;
      });
      var more = result.skipped.length - shown.length;
      msg +=
        ' ' + result.skipped.length + (result.skipped.length === 1 ? ' linha ignorada' : ' linhas ignoradas') +
        ' (' + shown.join('; ') + (more > 0 ? '; e mais ' + more : '') + ').';
    }
    return msg;
  }

  function importFile(file) {
    if (!file) return Promise.resolve();
    if (file.size > IMPORT_MAX_BYTES) {
      setMsg('O ficheiro tem mais de 10 MB. Importe uma planilha mais pequena.', false);
      return Promise.resolve();
    }
    setMsg('A ler ' + file.name + '…', true);
    return file
      .arrayBuffer()
      .then(function (buf) {
        return readSpreadsheet(new Uint8Array(buf));
      })
      .then(function (rows) {
        var result = rowsToItems(rows, currentVehicle());
        if (result.error) {
          setMsg(result.error, false);
          return;
        }
        result.items.forEach(function (it) {
          it.id = nextId++;
          state.items.push(it);
        });
        setMsg(importReport(file.name, result), result.items.length > 0);
        if (result.items.length) {
          state.selected = null;
          save();
          runPlan();
        }
      })
      .catch(function (err) {
        setMsg(err && err.message ? err.message : 'Não consegui ler a planilha.', false);
      });
  }

  function templateCsv() {
    var lines = ['Descrição;Comprimento (mm);Largura (mm);Altura (mm);Peso (kg);Quantidade;Destino;Cor'];
    DEMO.forEach(function (it) {
      lines.push([it.name, it.l, it.w, it.h, it.weight, it.qty, it.dest, COLOR_LABEL[it.color]].join(';'));
    });
    return lines.join('\r\n') + '\r\n';
  }

  function downloadTemplate() {
    if (typeof Blob === 'undefined' || !window.URL || !window.URL.createObjectURL) return;
    /* the BOM makes Excel open the accents as UTF-8 */
    var blob = new Blob(['﻿' + templateCsv()], { type: 'text/csv;charset=utf-8' });
    var url = window.URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'modelo-carga.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () {
      window.URL.revokeObjectURL(url);
    }, 1000);
  }

  /* exposed so the import can be checked outside the page */
  window.SyncrofinImport = {
    parseNumber: parseNumber,
    parseCsv: parseCsv,
    readSpreadsheet: readSpreadsheet,
    rowsToItems: rowsToItems,
    importFile: importFile,
    templateCsv: templateCsv
  };

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
      /* from the front left, high: the cab and the load in one picture */
      state.view.az = -2.3;
      state.view.elev = 0.4;
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
    if (els.importBtn && els.importFile) {
      els.importBtn.addEventListener('click', function () {
        setMenu(false);
        els.importFile.value = '';
        els.importFile.click();
      });
      els.importFile.addEventListener('change', function () {
        var file = els.importFile.files && els.importFile.files[0];
        if (file) importFile(file);
      });
    }
    if (els.template) els.template.addEventListener('click', downloadTemplate);
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
    els.plan = $('#plan');
    els.demo = $('#demo');
    els.clear = $('#clear');
    els.importBtn = $('#import');
    els.importFile = $('#import-file');
    els.template = $('#template');
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
