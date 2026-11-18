/* Syncrofin 3D Planner — the load plan: arranging the cargo and checking it.

   The problem is 3D container loading (a bin-packing variant, NP-hard) with
   a weight limit on every axle. It is solved the way the literature and the
   commercial planners do it, in three parts:

   1. A constructive heuristic places the boxes one by one, by Empty Maximal
      Spaces: a list of the largest empty boxes inside the cargo space; each
      box goes to the deepest, lowest, leftmost corner where it is allowed,
      and the space it used is cut into the spaces left over. Every candidate
      position must hold all the hard rules: it fits and overlaps nothing,
      its base is supported enough, it respects the box's rotations, nothing
      is put on a fragile box or above what a box can bear, it does not block
      a box that is delivered earlier, and — checked as each box goes in, from
      a linear model of the statics — no axle, axle group, fifth wheel or the
      gross weight goes over its limit.
   2. The statics (Spaces.axleLoads) give the load on every axle from the
      centre of gravity of the cargo: the checker. It runs on the plan as it
      leaves and again after every delivery, since unloading the back of the
      vehicle moves the centre of gravity forward.
   3. A metaheuristic on top (GRASP-style multi-start): the construction is
      run again and again with box orders perturbed at random, inside a time
      budget, keeping the plan with the best score — the volume loaded minus
      penalties for overloads, lateral imbalance and too little weight on the
      steering or drive axle. The first plan is ready at once; better ones
      replace it while the time lasts, and a new edit stops the search.
   After each construction a post-adjustment can slide the whole load
   backwards when that removes a problem (a light load stays against the
   front wall otherwise, where it is best secured).

   Everything about the vehicle (axle positions, groups and their shares,
   limits, tares, kingpin and fifth wheel) comes from the cargo-space
   catalogue (spaces.js). Plain functions, no DOM: the page and the tests
   use it as window.SyncrofinLoadPlan. */

(function (root) {
  'use strict';

  var Spaces = root.SyncrofinSpaces;

  /* ----------------------------------------------------------------- rules --- */
  /* support   % of a box's base that must rest on the floor or on boxes
     lateral   most the load may lean to one side: points from 50/50 (10 = 60/40)
     minFront  least share of the truck's (or tractor's) weight on its front axles, %
     minDrive  least share of the gross weight on the drive axle, %
     budget    seconds the search for a better plan may run (0 = first plan only) */
  var RULES = { support: 80, lateral: 10, minFront: 20, minDrive: 20, budget: 2 };
  var RULE_LIMITS = { support: [50, 100], lateral: [1, 50], minFront: [0, 60], minDrive: [0, 60], budget: [0, 30] };

  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  }

  function has(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function cleanRules(raw) {
    var out = {};
    Object.keys(RULES).forEach(function (k) {
      var v = raw && raw[k] !== '' && raw[k] !== null && raw[k] !== undefined ? Number(raw[k]) : NaN;
      out[k] = isFinite(v) ? clamp(v, RULE_LIMITS[k][0], RULE_LIMITS[k][1]) : RULES[k];
    });
    return out;
  }

  function fmt(n) {
    return Math.round(n).toLocaleString('pt-PT');
  }

  /* ----------------------------------------------------------------- stops --- */
  /* The delivery order: the destinations of the list, in the order the user
     set (saved), with any new one added at the end. Index 0 is delivered
     first, so it is loaded last, next to the doors. */
  function stopOrder(items, saved) {
    var seen = [];
    items.forEach(function (it) {
      var d = it.dest || '';
      if (seen.indexOf(d) < 0) seen.push(d);
    });
    var out = (saved || []).filter(function (d) {
      return seen.indexOf(d) >= 0;
    });
    seen.forEach(function (d) {
      if (out.indexOf(d) < 0) out.push(d);
    });
    return out;
  }

  /* One entry per physical box. */
  function expand(items, stops) {
    var queue = [];
    items.forEach(function (it) {
      var stop = Math.max(0, stops.indexOf(it.dest || ''));
      for (var i = 0; i < it.qty; i++) {
        queue.push({
          id: it.id,
          name: it.name,
          color: it.color,
          weight: it.weight || 0,
          l: it.l,
          w: it.w,
          h: it.h,
          orient: it.orient === 'any' ? 'any' : 'upright',
          fragile: !!it.fragile,
          maxTop: has(it.maxTop) && it.maxTop >= 0 ? it.maxTop : Infinity,
          stop: stop
        });
      }
    });
    return queue;
  }

  /* The ways a box may lie: only turned about the vertical when it must stay
     this side up, any of the six otherwise (upright preferred). */
  function orientations(b) {
    var d = [b.l, b.w, b.h];
    var seen = {};
    var out = [];
    for (var a = 0; a < 3; a++) {
      for (var c2 = 0; c2 < 3; c2++) {
        if (a === c2) continue;
        var c = 3 - a - c2;
        if (b.orient !== 'any' && c !== 2) continue;
        var key = d[a] + 'x' + d[c2] + 'x' + d[c];
        if (seen[key]) continue;
        seen[key] = 1;
        out.push({ l: d[a], w: d[c2], h: d[c], upright: c === 2 });
      }
    }
    return out;
  }

  /* --------------------------------------------------------- axle model --- */
  /* Every axle load, group load, the fifth wheel and the gross weight are
     affine in the cargo weight W and its moment M = W·x about the front wall:
     load = T + a·W + b·M. Three evaluations of the statics give T, a and b,
     so checking a candidate position costs a few multiplications. */
  function axleModel(vehicle, tractor) {
    var t = Spaces.typeOf(vehicle.type);
    if (!t) return null;
    var mid = vehicle.w / 2;
    var r0 = Spaces.axleLoads(vehicle, tractor, { weight: 0, cgx: 0, cgz: mid });
    var r1 = Spaces.axleLoads(vehicle, tractor, { weight: 1000, cgx: 0, cgz: mid });
    var r2 = Spaces.axleLoads(vehicle, tractor, { weight: 1000, cgx: 1000, cgz: mid });
    var lines = [];
    function line(l0, l1, l2, max) {
      if (!(max > 0)) return;
      lines.push({ T: l0, a: (l1 - l0) / 1000, b: (l2 - l1) / 1e6, max: max });
    }
    r0.rows.forEach(function (r, i) {
      line(r.load, r1.rows[i].load, r2.rows[i].load, r.max);
    });
    r0.groups.forEach(function (g, i) {
      line(g.load, r1.groups[i].load, r2.groups[i].load, g.max);
    });
    line(r0.gross.load, r1.gross.load, r2.gross.load, r0.gross.max);
    return lines.length ? { lines: lines } : null;
  }

  function withinAxles(model, W, M) {
    for (var i = 0; i < model.lines.length; i++) {
      var L = model.lines[i];
      if (Math.round((L.T + L.a * W + L.b * M) * 1000) > Math.round(L.max * 1000)) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------- geometry --- */
  var EPS = 0.5;

  function overlaps(a, b) {
    return (
      a.x < b.x + b.l - EPS && b.x < a.x + a.l - EPS &&
      a.z < b.z + b.w - EPS && b.z < a.z + a.w - EPS &&
      a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS
    );
  }

  /* The boxes a box at this position would rest on, with the area each one
     carries; on the floor the list is empty and the whole base is held. */
  function supporters(box, placed) {
    if (box.y <= EPS) return { area: box.l * box.w, list: [] };
    var area = 0;
    var list = [];
    for (var i = 0; i < placed.length; i++) {
      var p = placed[i];
      if (Math.abs(p.y + p.h - box.y) > 1) continue;
      var ox = Math.min(box.x + box.l, p.x + p.l) - Math.max(box.x, p.x);
      var oz = Math.min(box.z + box.w, p.z + p.w) - Math.max(box.z, p.z);
      if (ox > 0 && oz > 0) {
        area += ox * oz;
        list.push({ p: p, area: ox * oz });
      }
    }
    return { area: area, list: list };
  }

  /* The weight a new box adds on each box under it, all the way down: it is
     shared among the boxes it rests on by the area each one carries, and each
     of those passes its part on to the boxes under it the same way. */
  function pressure(weight, list) {
    var add = [];
    function push(p, kg) {
      var found = null;
      for (var i = 0; i < add.length; i++) {
        if (add[i].p === p) {
          found = add[i];
          break;
        }
      }
      if (found) found.kg += kg;
      else add.push({ p: p, kg: kg });
      (p.below || []).forEach(function (s) {
        push(s.p, kg * s.share);
      });
    }
    var total = 0;
    list.forEach(function (s) {
      total += s.area;
    });
    list.forEach(function (s) {
      push(s.p, (weight * s.area) / (total || 1));
    });
    return add;
  }

  /* Stacking rules: nothing on a fragile box, and no box made to bear more
     than it can take on top. */
  function stackAllowed(add) {
    for (var i = 0; i < add.length; i++) {
      var p = add[i].p;
      if (p.fragile) return false;
      if (p.above + add[i].kg > p.maxTop + EPS) return false;
    }
    return true;
  }

  /* Unloading order: the doors are at the back (x = length). A box must not
     sit between a box delivered earlier and the doors, nor on top of it. */
  function blocks(box, stop, placed) {
    for (var i = 0; i < placed.length; i++) {
      var p = placed[i];
      if (p.stop === stop) continue;
      var zOver = box.z < p.z + p.w - EPS && p.z < box.z + box.w - EPS;
      if (!zOver) continue;
      var yOver = box.y < p.y + p.h - EPS && p.y < box.y + box.h - EPS;
      var xOver = box.x < p.x + p.l - EPS && p.x < box.x + box.l - EPS;
      var first = p.stop < stop ? p : box; /* the one delivered earlier */
      var other = first === p ? box : p;
      if (yOver && other.x >= first.x + first.l - EPS) return true;
      if (xOver && other.y >= first.y + first.h - EPS) return true;
    }
    return false;
  }

  function intersects(s, b) {
    return (
      s.x < b.x + b.l - EPS && b.x < s.x + s.l - EPS &&
      s.y < b.y + b.h - EPS && b.y < s.y + s.h - EPS &&
      s.z < b.z + b.w - EPS && b.z < s.z + s.w - EPS
    );
  }

  /* What is left of an empty space once a box takes part of it: up to six
     maximal spaces, one on each side of the box (ahead, behind, below,
     above, left, right), each as large as the space allows. */
  function cut(s, b) {
    var out = [];
    if (b.x > s.x + EPS) out.push({ x: s.x, y: s.y, z: s.z, l: b.x - s.x, w: s.w, h: s.h });
    if (b.x + b.l < s.x + s.l - EPS) out.push({ x: b.x + b.l, y: s.y, z: s.z, l: s.x + s.l - b.x - b.l, w: s.w, h: s.h });
    if (b.y > s.y + EPS) out.push({ x: s.x, y: s.y, z: s.z, l: s.l, w: s.w, h: b.y - s.y });
    if (b.y + b.h < s.y + s.h - EPS) out.push({ x: s.x, y: b.y + b.h, z: s.z, l: s.l, w: s.w, h: s.y + s.h - b.y - b.h });
    if (b.z > s.z + EPS) out.push({ x: s.x, y: s.y, z: s.z, l: s.l, w: b.z - s.z, h: s.h });
    if (b.z + b.w < s.z + s.w - EPS) out.push({ x: s.x, y: s.y, z: b.z + b.w, l: s.l, w: s.z + s.w - b.z - b.w, h: s.h });
    return out;
  }

  /* Every space the new box touches is cut around it, so the list always
     holds the maximal empty spaces and nothing else. */
  function recut(spaces, b) {
    var next = [];
    spaces.forEach(function (s) {
      if (intersects(s, b)) next.push.apply(next, cut(s, b));
      else next.push(s);
    });
    return tidySpaces(next);
  }

  var MAX_SPACES = 300;

  function tidySpaces(spaces) {
    /* drop spaces swallowed by a bigger one, and slivers too small to use */
    var usable = [];
    for (var i = 0; i < spaces.length; i++) {
      var a = spaces[i];
      if (a.l < 5 || a.w < 5 || a.h < 5) continue;
      var dominated = false;
      for (var j = 0; j < spaces.length; j++) {
        if (i === j) continue;
        var b = spaces[j];
        if (
          a.x >= b.x - EPS && a.y >= b.y - EPS && a.z >= b.z - EPS &&
          a.x + a.l <= b.x + b.l + EPS && a.y + a.h <= b.y + b.h + EPS && a.z + a.w <= b.z + b.w + EPS &&
          (b.l > a.l || b.w > a.w || b.h > a.h)
        ) {
          dominated = true;
          break;
        }
      }
      if (!dominated) usable.push(a);
    }
    /* nearest the front, bottom and left first (the order positions are
       preferred in); the cap only matters for very fragmented loads */
    usable.sort(function (a, b) {
      return a.x - b.x || a.y - b.y || a.z - b.z;
    });
    return usable.slice(0, MAX_SPACES);
  }

  /* --------------------------------------------------------- construction --- */
  /* ctx: { vehicle, model (or null), rules }. Returns { placed, unplaced }
     where an unplaced box says why: peso (payload), eixo (no position left
     that keeps every axle within its limit), regras (stacking or unloading
     order) or espaco (no room). */
  function construct(ctx, queue) {
    var V = ctx.vehicle;
    var need = ctx.rules.support / 100;
    var placed = [];
    var unplaced = [];
    var W = 0;
    var M = 0; /* moment about the front wall (kg·mm) */
    var Mz = 0; /* moment about the left wall (kg·mm) */
    var spaces = [{ x: 0, y: 0, z: 0, l: V.l, w: V.w, h: V.h }];

    /* Length to keep free at the back for the deliveries that come off
       before stop s: the floor their boxes need (a box's base divided by
       how many fit one above the other), spread over 90% of the width. A box
       pushed back to relieve an axle stops short of it. */
    var floorByStop = {};
    queue.forEach(function (it) {
      var high = it.orient === 'any' ? Math.min(it.l, it.w, it.h) : it.h;
      var layers = it.maxTop === 0 || it.fragile ? 1 : Math.max(1, Math.floor(V.h / high));
      floorByStop[it.stop] = (floorByStop[it.stop] || 0) + (it.l * it.w) / layers;
    });
    function reserveFor(stop) {
      var area = 0;
      Object.keys(floorByStop).forEach(function (k) {
        if (Number(k) < stop) area += floorByStop[k];
      });
      return area / (V.w * 0.9);
    }

    queue.forEach(function (it) {
      var backLimit = V.l - reserveFor(it.stop);
      if (W + it.weight > V.payload + EPS) {
        unplaced.push({ id: it.id, name: it.name, reason: 'peso' });
        return;
      }
      var orients = orientations(it);
      var best = null;
      var why = { axle: false, rules: false };

      for (var s = 0; s < spaces.length; s++) {
        var sp = spaces[s];
        for (var o = 0; o < orients.length; o++) {
          var or = orients[o];
          if (or.l > sp.l + EPS || or.w > sp.w + EPS || or.h > sp.h + EPS) continue;
          /* the corners of the space on its floor: front or back, left or
             right. The back ones are only taken when the front is not
             allowed — when the axles need the weight further back. */
          var xs = [sp.x];
          var back = Math.min(sp.x + sp.l, backLimit) - or.l;
          if (back > sp.x + EPS) xs.push(back);
          var zs = [sp.z];
          if (sp.w - or.w > EPS) zs.push(sp.z + sp.w - or.w);
          for (var xi = 0; xi < xs.length; xi++) {
          for (var zi = 0; zi < zs.length; zi++) {
          var box = { x: xs[xi], y: sp.y, z: zs[zi], l: or.l, w: or.w, h: or.h };

          /* deepest, then lowest, then the side that keeps the load
             balanced; the tightest fit and upright boxes among equals */
          var lean = Math.abs((Mz + it.weight * (box.z + box.w / 2)) / (W + it.weight || 1) - V.w / 2);
          if (!(W + it.weight > 0)) lean = box.z;
          /* a box that eats into the length kept for earlier deliveries is
             the last resort */
          var intoReserve = box.x + box.l > backLimit + EPS ? 1e14 : 0;
          var score =
            intoReserve + box.x * 1e9 + box.y * 1e6 + lean * 100 + box.z * 0.01 +
            (sp.l * sp.w * sp.h - or.l * or.w * or.h) / 1e9 +
            (or.upright ? 0 : 0.5);
          if (best && score >= best.score) continue;
          /* the spaces are empty by construction, so a box inside one
             overlaps nothing */
          var sup = supporters(box, placed);
          if (sup.area < box.l * box.w * need - EPS) continue;
          var add = sup.list.length ? pressure(it.weight, sup.list) : [];
          if (!stackAllowed(add)) {
            why.rules = true;
            continue;
          }
          if (blocks(box, it.stop, placed)) {
            why.rules = true;
            continue;
          }
          if (ctx.model && !withinAxles(ctx.model, W + it.weight, M + it.weight * (box.x + box.l / 2))) {
            why.axle = true;
            continue;
          }
          best = { box: box, space: sp, index: s, score: score, sup: sup, add: add };
          }
          }
        }
      }

      if (!best) {
        unplaced.push({ id: it.id, name: it.name, reason: why.axle ? 'eixo' : why.rules ? 'regras' : 'espaco' });
        return;
      }

      var b = best.box;
      b.id = it.id;
      b.name = it.name;
      b.color = it.color;
      b.weight = it.weight;
      b.stop = it.stop;
      b.fragile = it.fragile;
      b.maxTop = it.maxTop;
      b.above = 0;
      var total = 0;
      best.sup.list.forEach(function (s2) {
        total += s2.area;
      });
      b.below = best.sup.list.map(function (s2) {
        return { p: s2.p, share: s2.area / (total || 1) };
      });
      best.add.forEach(function (a) {
        a.p.above += a.kg;
      });
      placed.push(b);
      W += it.weight;
      M += it.weight * (b.x + b.l / 2);
      Mz += it.weight * (b.z + b.w / 2);

      spaces = recut(spaces, b);
    });

    return { placed: placed, unplaced: unplaced };
  }

  /* --------------------------------------------------------------- checker --- */
  function cargoOf(boxes, vehicle) {
    var W = 0;
    var mx = 0;
    var mz = 0;
    boxes.forEach(function (b) {
      W += b.weight || 0;
      mx += (b.weight || 0) * (b.x + b.l / 2);
      mz += (b.weight || 0) * (b.z + b.w / 2);
    });
    return { weight: W, cgx: W ? mx / W : vehicle.l / 2, cgz: W ? mz / W : vehicle.w / 2 };
  }

  function prefix(r) {
    return (r.part === 'tractor' ? 'Cavalo · ' : '') + r.label + ' (' + r.letter + ')';
  }

  /* The problems of one state of the load. Each has { kind, hard, text,
     excess } where excess is how far past the limit, as a share of it. */
  function problemsOf(res, cargo, rules) {
    var out = [];
    res.rows.forEach(function (r) {
      if (r.load < -0.5) {
        out.push({ kind: 'lift', hard: true, text: prefix(r) + ' levanta: a carga está toda atrás dele.', excess: 1 });
      } else if (r.max > 0 && Math.round(r.load * 1000) > Math.round(r.max * 1000)) {
        out.push({
          kind: r.info ? 'kingpin' : 'axle', hard: true,
          text: prefix(r) + ': ' + fmt(r.load) + ' kg, máx. ' + fmt(r.max) + ' kg.',
          excess: (r.load - r.max) / r.max
        });
      }
    });
    (res.groups || []).forEach(function (g) {
      if (g.max && Math.round(g.load * 1000) > Math.round(g.max * 1000)) {
        out.push({
          kind: 'group', hard: true,
          text: (g.part === 'tractor' ? 'Cavalo · ' : '') + g.label + ' (' + g.letters + '): ' + fmt(g.load) + ' kg, máx. ' + fmt(g.max) + ' kg.',
          excess: (g.load - g.max) / g.max
        });
      }
    });
    if (res.gross && res.gross.max && Math.round(res.gross.load * 1000) > Math.round(res.gross.max * 1000)) {
      out.push({
        kind: 'gross', hard: true,
        text: 'Peso bruto: ' + fmt(res.gross.load) + ' kg, máx. ' + fmt(res.gross.max) + ' kg.',
        excess: (res.gross.load - res.gross.max) / res.gross.max
      });
    }
    if (!res.rows.length || !(cargo.weight > 0)) return out;

    var lean = Math.abs(res.leftShare - 0.5) * 100;
    if (lean > rules.lateral + 1e-9) {
      var left = Math.round(res.leftShare * 100);
      out.push({
        kind: 'lateral', hard: false,
        text: 'Desbalanceamento lateral: ' + left + '% do peso à esquerda e ' + (100 - left) + '% à direita (máx. ' +
          (50 + rules.lateral) + '% de um lado).',
        excess: (lean - rules.lateral) / 100
      });
    }

    /* the powered unit: the truck itself, or the tractor of a semitrailer */
    var unit = res.rows.filter(function (r) {
      return r.part === 'tractor';
    });
    var isTractor = unit.length > 0;
    if (!isTractor) {
      var lorry = res.rows.some(function (r) {
        return r.part === 'space' && r.x < 0 && r.group === 'front';
      });
      if (lorry) unit = res.rows.filter(function (r) {
        return r.part === 'space';
      });
    }
    if (!unit.length) return out;
    var unitLoad = 0;
    var frontLoad = 0;
    var drive = null;
    unit.forEach(function (r) {
      unitLoad += r.load;
      if (r.group === 'front') frontLoad += r.load;
      else if (!drive) drive = r;
    });
    var who = isTractor ? 'do cavalo' : 'do caminhão';
    if (unitLoad > 0 && frontLoad < (rules.minFront / 100) * unitLoad - 0.5) {
      out.push({
        kind: 'minFront', hard: false,
        text: 'Eixo dianteiro com ' + Math.round((frontLoad / unitLoad) * 100) + '% do peso ' + who +
          ' (mín. ' + rules.minFront + '%): pouca carga para a direção.',
        excess: rules.minFront / 100 - frontLoad / unitLoad
      });
    }
    var gross = res.gross ? res.gross.load : 0;
    if (drive && gross > 0 && drive.load < (rules.minDrive / 100) * gross - 0.5) {
      out.push({
        kind: 'minDrive', hard: false,
        text: prefix(drive) + ' com ' + Math.round((drive.load / gross) * 100) + '% do peso bruto (mín. ' + rules.minDrive +
          '%): pouca carga para a tração.',
        excess: rules.minDrive / 100 - drive.load / gross
      });
    }
    return out;
  }

  /* The plan as it leaves and after each delivery. stops: the destinations
     in delivery order. Returns { states: [{ label, stop, boxes, cargo, res,
     problems }], problems, penalty }. */
  function verify(vehicle, tractor, placed, stops, rules) {
    rules = cleanRules(rules);
    var states = [];
    function add(label, stop, boxes) {
      var cargo = cargoOf(boxes, vehicle);
      var res = Spaces.axleLoads(vehicle, tractor, cargo);
      states.push({ label: label, stop: stop, boxes: boxes, cargo: cargo, res: res, problems: problemsOf(res, cargo, rules) });
    }
    add('Saída', -1, placed);
    var used = [];
    placed.forEach(function (b) {
      if (used.indexOf(b.stop) < 0) used.push(b.stop);
    });
    if (used.length > 1) {
      for (var k = 0; k < stops.length - 1; k++) {
        var left = placed.filter(function (b) {
          return b.stop > k;
        });
        if (!left.length) break;
        if (left.length === placed.length) continue;
        add('Após a entrega ' + (k + 1) + (stops[k] ? ' (' + stops[k] + ')' : ''), k, left);
      }
    }
    var problems = [];
    var penalty = 0;
    states.forEach(function (st) {
      st.problems.forEach(function (p) {
        problems.push({ state: st.label, kind: p.kind, hard: p.hard, text: p.text, excess: p.excess });
        penalty += (p.hard ? 10 : 2) * Math.max(0.001, p.excess);
      });
    });
    return { states: states, problems: problems, penalty: penalty };
  }

  /* ------------------------------------------------------- post-adjustment --- */
  function shifted(placed, dx) {
    return placed.map(function (b) {
      var c = {};
      Object.keys(b).forEach(function (k) {
        c[k] = b[k];
      });
      c.x = b.x + dx;
      return c;
    });
  }

  /* Slide the whole load back when that lowers the penalty — the smallest
     slide that removes every problem, or else the one that leaves the least.
     Without a problem the load stays against the front wall. */
  function slide(ctx, placed, check) {
    if (!ctx.model || !placed.length || check.penalty <= 0) return { placed: placed, check: check, shift: 0 };
    var end = 0;
    placed.forEach(function (b) {
      end = Math.max(end, b.x + b.l);
    });
    var room = ctx.vehicle.l - end;
    if (room < 50) return { placed: placed, check: check, shift: 0 };
    var step = Math.max(50, room / 40);
    var best = { placed: placed, check: check, shift: 0 };
    for (var dx = step; dx <= room + 0.5; dx += step) {
      var moved = shifted(placed, Math.min(dx, room));
      var c = verify(ctx.vehicle, ctx.tractor, moved, ctx.stops, ctx.rules);
      if (c.penalty < best.check.penalty - 1e-9) {
        best = { placed: moved, check: c, shift: Math.min(dx, room) };
        if (c.penalty <= 0) break;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------ the search --- */
  function summarize(placed, unplaced) {
    var volume = 0;
    var area = 0;
    var weight = 0;
    placed.forEach(function (b) {
      volume += (b.l * b.w * b.h) / 1e9;
      weight += b.weight || 0;
      if (b.y < EPS) area += (b.l * b.w) / 1e6;
    });
    return { count: placed.length, volume: volume, weight: weight, area: area, queue: placed.length + unplaced.length };
  }

  /* Higher is better: the volume loaded, less the penalties (an overload of
     5% costs as much as leaving 5 m³ behind; softer problems a fifth of that). */
  function scoreOf(totals, check) {
    return totals.volume * 100 + totals.count * 0.001 - check.penalty * 1000;
  }

  /* A small seeded random generator, so the same list gives the same plan. */
  function random(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seedOf(items, vehicle) {
    var s = JSON.stringify([vehicle && vehicle.id, items.map(function (it) {
      return [it.l, it.w, it.h, it.weight, it.qty, it.dest, it.orient, it.fragile, it.maxTop];
    })]);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  var KEYS = {
    volume: function (b) {
      return b.l * b.w * b.h;
    },
    longest: function (b) {
      return Math.max(b.l, b.w, b.h);
    },
    weight: function (b) {
      return b.weight;
    },
    base: function (b) {
      return b.l * b.w;
    }
  };

  /* Last delivery first (it goes to the front), fragile boxes last within a
     delivery (they end up on top), then by the key, biggest first; noise
     perturbs the key for the randomised runs. */
  function ordered(queue, keyName, rand, noise) {
    var key = KEYS[keyName];
    var tagged = queue.map(function (b) {
      var k = key(b);
      return { b: b, k: noise ? k * (1 + (rand() - 0.5) * noise) : k };
    });
    tagged.sort(function (p, q) {
      return q.b.stop - p.b.stop || (p.b.fragile ? 1 : 0) - (q.b.fragile ? 1 : 0) || q.k - p.k;
    });
    return tagged.map(function (t) {
      return t.b;
    });
  }

  function attempt(ctx, order) {
    var r = construct(ctx, order);
    var check = verify(ctx.vehicle, ctx.tractor, r.placed, ctx.stops, ctx.rules);
    var adj = slide(ctx, r.placed, check);
    var totals = summarize(adj.placed, r.unplaced);
    return {
      placed: adj.placed,
      unplaced: r.unplaced,
      totals: totals,
      check: adj.check,
      shift: adj.shift,
      score: scoreOf(totals, adj.check)
    };
  }

  function better(a, b) {
    return !b || a.score > b.score + 1e-9;
  }

  function context(input) {
    var rules = cleanRules(input.rules);
    var stops = input.stops || stopOrder(input.items || [], []);
    return {
      vehicle: input.vehicle,
      tractor: input.tractor || null,
      rules: rules,
      stops: stops,
      model: axleModel(input.vehicle, input.tractor || null),
      queue: expand(input.items || [], stops)
    };
  }

  /* The first plan, at once: three deterministic orders (one for a very
     large list), the best kept. */
  function firstPlan(ctx) {
    var keys = ctx.queue.length > 150 ? ['volume'] : ['volume', 'longest', 'weight'];
    var best = null;
    keys.forEach(function (k) {
      var r = attempt(ctx, ordered(ctx.queue, k));
      r.tries = 1;
      if (better(r, best)) best = r;
    });
    return best;
  }

  function randomTry(ctx, rand) {
    var names = Object.keys(KEYS);
    var key = names[Math.floor(rand() * names.length)];
    var noise = 0.15 + rand() * 0.6;
    return attempt(ctx, ordered(ctx.queue, key, rand, noise));
  }

  /* For the tests and scripts: the first plan, then `tries` random runs, all
     at once. */
  function planSync(input, tries) {
    var ctx = context(input);
    var best = firstPlan(ctx);
    var rand = random(input.seed !== undefined ? input.seed : seedOf(input.items || [], input.vehicle));
    for (var i = 0; i < (tries || 0); i++) {
      var r = randomTry(ctx, rand);
      if (better(r, best)) best = r;
    }
    best.stops = ctx.stops;
    best.rules = ctx.rules;
    return best;
  }

  /* The planner's entry point. Returns { best, cancel } with the first plan
     in best; while the budget lasts it keeps trying in short slices (so the
     page stays responsive) and calls onUpdate(best, progress) whenever it
     finds a better plan, and once more when it stops. progress: { tries,
     elapsed (ms), done }. */
  var SLICE_TRIES = 40; /* attempts per slice at most */
  var MAX_TRIES = 3000; /* attempts per search at most */

  function start(input, onUpdate) {
    var ctx = context(input);
    var t0 = Date.now();
    var best = firstPlan(ctx);
    best.stops = ctx.stops;
    best.rules = ctx.rules;
    var tries = 3;
    var searchStarted = false;
    var stopped = false;
    var timer = null;
    var budget = ctx.rules.budget * 1000;
    var rand = random(input.seed !== undefined ? input.seed : seedOf(input.items || [], input.vehicle));

    function slice() {
      timer = null;
      if (stopped) return;
      var sliceStart = Date.now();
      if (!searchStarted) {
        /* the budget is for the search itself, not for the page around it */
        searchStarted = true;
        t0 = sliceStart;
      }
      var improved = false;
      var inSlice = 0;
      /* bounded by time and also by count, so a clock that does not move
         (a background tab, a headless browser) cannot hold the page */
      while (Date.now() - sliceStart < 25 && Date.now() - t0 < budget && inSlice < SLICE_TRIES && tries < MAX_TRIES) {
        inSlice++;
        var r = randomTry(ctx, rand);
        tries++;
        if (better(r, best)) {
          r.stops = ctx.stops;
          r.rules = ctx.rules;
          best = r;
          improved = true;
        }
      }
      var done = Date.now() - t0 >= budget || tries >= MAX_TRIES;
      if ((improved || done) && onUpdate) onUpdate(best, { tries: tries, elapsed: Date.now() - t0, done: done, improved: improved });
      if (!done) timer = root.setTimeout(slice, 0);
    }

    if (budget > 0 && ctx.queue.length > 1 && typeof root.setTimeout === 'function') {
      timer = root.setTimeout(slice, 0);
    }
    return {
      best: best,
      running: function () {
        return !!timer;
      },
      cancel: function () {
        stopped = true;
        if (timer && typeof root.clearTimeout === 'function') root.clearTimeout(timer);
        timer = null;
      }
    };
  }

  root.SyncrofinLoadPlan = {
    RULES: RULES,
    RULE_LIMITS: RULE_LIMITS,
    cleanRules: cleanRules,
    stopOrder: stopOrder,
    expand: expand,
    orientations: orientations,
    axleModel: axleModel,
    verify: verify,
    planSync: planSync,
    start: start
  };
})(typeof window !== 'undefined' ? window : this);
