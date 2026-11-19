/* Syncrofin 3D Planner — load securing (amarração).

   How many straps the planned load needs, and where, by the frictional
   ("top-over") lashing method of EN 12195-1: a strap over the top of the
   load presses it on the floor, and friction holds it against the
   accelerations of the road —

     forward 0.8 g, backward 0.5 g, sideways 0.5 g, vertical 1.0 g

   n ≥ (c − μ·cz) · m · g · fs / (2 · μ · sin α · STF)        fs = 1.1

   where m is the mass of a section of the load, μ the friction between the
   load and the floor, α the angle of the strap with the floor and STF the
   standard tension force of the strap (the force its ratchet puts in).

   Blocking counts too: a load standing against the front wall (or against
   load that does, with no gap between) is held forward by the wall, up to
   what the wall takes — 40% of the payload, at most 5 000 daN (EN 12642 L
   bodies; a container's end wall 40% of the payload). A load that fills the
   width between the side walls is held sideways by them (30% of the
   payload; 60% for a container). The rear doors are not counted, nor are
   the walls of a platform, which has none.

   The "ideal" securing compares what the load needs as it is with an
   anti-slip mat under it (μ 0.6) and with the gaps filled (void fillers
   between sections and against the walls), and recommends the option with
   the fewest straps.

   Plain functions, no DOM: the page and the tests use it as
   window.SyncrofinLashing. Check the result with Resolução CONTRAN nº 552/2015
   and with the strap maker's label. */

(function (root) {
  'use strict';

  var Spaces = root.SyncrofinSpaces;

  var G = 0.981; /* daN per kg */
  var C = { forward: 0.8, backward: 0.5, side: 0.5, vertical: 1.0 };
  var FS = 1.1;

  /* friction between the load and the floor (dynamic, EN 12195-1 annex B,
     rounded down) */
  var SURFACES = [
    { id: 'padrao', label: 'Piso comum, sem tapete (μ 0,30)', mu: 0.3 },
    { id: 'madeira', label: 'Palete de madeira sobre piso de madeira (μ 0,45)', mu: 0.45 },
    { id: 'tapete', label: 'Tapete antiderrapante (μ 0,60)', mu: 0.6 },
    { id: 'liso', label: 'Piso metálico liso ou úmido (μ 0,20)', mu: 0.2 }
  ];
  var MAT_MU = 0.6;

  var DEFAULTS = { surface: 'padrao', stf: 400 };
  var STF_LIMITS = [100, 2000];

  var SECTION_MAX = 2500; /* mm: the longest section a group of straps holds */
  var SPACING = 2000; /* mm: at least one strap this often */
  var CONTACT = 50; /* mm: closer than this is touching */
  var FILL_LENGTH = 400; /* mm: a gap along the length a void filler can close */
  var SIDE_TOUCH = 80; /* mm: free width with the load still held by the walls */
  var FILL_SIDE = 300; /* mm: free width a filler can close */
  var UNEVEN = 300; /* mm: a column this much lower than the one the strap rests on is not held */
  var STRAP_ANCHOR = 15; /* mm from the side wall: the lashing points on the floor */

  function surfaceOf(id) {
    for (var i = 0; i < SURFACES.length; i++) if (SURFACES[i].id === id) return SURFACES[i];
    return SURFACES[0];
  }

  function cleanOptions(o) {
    o = o || {};
    var stf = Number(o.stf);
    return {
      surface: surfaceOf(o.surface).id,
      stf: isFinite(stf) && stf > 0 ? Math.min(STF_LIMITS[1], Math.max(STF_LIMITS[0], Math.round(stf))) : DEFAULTS.stf
    };
  }

  /* What holds the load in this vehicle: front wall, side walls and their
     strength in daN. */
  function walls(vehicle) {
    var t = (Spaces && Spaces.typeOf(vehicle.type)) || { kind: 'box', id: 'container' };
    var P = (vehicle.payload || 0) * G;
    if (/^flatbed/.test(t.id)) return { front: 0, side: 0, kind: 'plataforma' };
    if (t.kind === 'box') return { front: 0.4 * P, side: 0.6 * P, kind: 'contêiner' };
    return { front: Math.min(0.4 * P, 5000), side: 0.3 * P, kind: 'baú' };
  }

  /* ------------------------------------------------------------ sections --- */
  /* The load cut across into sections: runs of boxes that touch along the
     length, cut where no box crosses (between two rows of pallets), each at
     most SECTION_MAX long when the load allows. */
  function sectionsOf(placed) {
    var boxes = placed.map(function (b, i) {
      return { b: b, i: i };
    }).sort(function (p, q) {
      return p.b.x - q.b.x;
    });
    /* contiguous runs */
    var runs = [];
    boxes.forEach(function (e) {
      var run = runs[runs.length - 1];
      if (run && e.b.x <= run.to + 1) {
        run.items.push(e);
        run.to = Math.max(run.to, e.b.x + e.b.l);
      } else {
        runs.push({ from: e.b.x, to: e.b.x + e.b.l, items: [e] });
      }
    });
    var sections = [];
    runs.forEach(function (run) {
      /* where a cut crosses no box */
      var marks = [];
      run.items.forEach(function (e) {
        marks.push(e.b.x, e.b.x + e.b.l);
      });
      var clean = marks.filter(function (c) {
        return c > run.from + 1 && c < run.to - 1 && run.items.every(function (e) {
          return !(e.b.x < c - 1 && e.b.x + e.b.l > c + 1);
        });
      }).sort(function (a, b) {
        return a - b;
      }).filter(function (c, i, a) {
        return i === 0 || c - a[i - 1] > 1;
      });
      var cuts = [];
      var start = run.from;
      while (run.to - start > SECTION_MAX) {
        var within = clean.filter(function (c) {
          return c > start + 1 && c <= start + SECTION_MAX;
        });
        var next = within.length ? within[within.length - 1] : undefined;
        if (next === undefined) {
          /* boxes staggered across every line: cut at the box edge nearest
             the longest section (the boxes go to the side of their centre) */
          var edgesNear = marks.filter(function (c) {
            return c > start + 600 && c <= start + SECTION_MAX && c < run.to - 300;
          });
          next = edgesNear.length ? Math.max.apply(null, edgesNear) : undefined;
        }
        if (next === undefined) break;
        cuts.push(next);
        start = next;
      }
      var edges = [run.from].concat(cuts, [run.to]);
      for (var k = 0; k < edges.length - 1; k++) {
        var lo = edges[k];
        var hi = edges[k + 1];
        var items = run.items.filter(function (e) {
          var c = e.b.x + e.b.l / 2;
          return c >= lo && (c < hi || (k === edges.length - 2 && c <= hi));
        });
        if (items.length) sections.push(describe(items));
      }
    });
    return sections;
  }

  function describe(items) {
    var s = { boxes: [], from: Infinity, to: 0, weight: 0, top: 0, zmin: Infinity, zmax: 0, fragileTop: false };
    items.forEach(function (e) {
      var b = e.b;
      s.boxes.push(e.i);
      s.from = Math.min(s.from, b.x);
      s.to = Math.max(s.to, b.x + b.l);
      s.weight += b.weight || 0;
      s.top = Math.max(s.top, b.y + b.h);
      s.zmin = Math.min(s.zmin, b.z);
      s.zmax = Math.max(s.zmax, b.z + b.w);
    });
    /* a fragile box at the top would take the strap's pressure */
    items.forEach(function (e) {
      var b = e.b;
      var covered = items.some(function (o) {
        return o !== e && Math.abs(o.b.y - (b.y + b.h)) <= 1 &&
          o.b.x < b.x + b.l && b.x < o.b.x + o.b.l && o.b.z < b.z + b.w && b.z < o.b.z + o.b.w;
      });
      if (b.fragile && !covered) s.fragileTop = true;
    });
    return s;
  }

  /* the top of the load and its width under a strap at x */
  function profileAt(placed, s, x) {
    var top = 0;
    var zmin = Infinity;
    var zmax = 0;
    s.boxes.forEach(function (i) {
      var b = placed[i];
      if (b.x <= x && x <= b.x + b.l) {
        top = Math.max(top, b.y + b.h);
        zmin = Math.min(zmin, b.z);
        zmax = Math.max(zmax, b.z + b.w);
      }
    });
    if (!(zmax > 0)) return { top: s.top, zmin: s.zmin, zmax: s.zmax, low: s.top };
    /* the lowest column under the strap: the strap rests on the highest,
       so a much lower column beside it is not pressed down */
    var low = top;
    s.boxes.forEach(function (i) {
      var b = placed[i];
      if (b.y > 1 || !(b.x <= x && x <= b.x + b.l)) return;
      var col = b.h;
      s.boxes.forEach(function (j) {
        var o = placed[j];
        if (o.x <= x && x <= o.x + o.l && o.z < b.z + b.w - 1 && b.z < o.z + o.w - 1) col = Math.max(col, o.y + o.h);
      });
      low = Math.min(low, col);
    });
    return { top: top, zmin: zmin, zmax: zmax, low: low };
  }

  /* The strap's path across the load at x, as a tensioned strap lies on it:
     from a lashing point on the floor by one side wall, straight to the
     outermost top corner of the load, over the top corners (the upper hull
     of the boxes' cross-section: it touches the corners and spans the dips,
     never floating as a flat roof over lower boxes) and down to the floor
     by the other wall. [{ z, y }] in mm, z growing; the ends have y = 0. */
  function strapPath(placed, s, x, W) {
    var topAt = {};
    s.boxes.forEach(function (i) {
      var b = placed[i];
      if (!(b.x <= x && x <= b.x + b.l)) return;
      var y = b.y + b.h;
      [b.z, b.z + b.w].forEach(function (z) {
        z = Math.round(z);
        if (!(topAt[z] >= y)) topAt[z] = y;
      });
    });
    var pts = Object.keys(topAt).map(Number).sort(function (a, b) {
      return a - b;
    }).map(function (z) {
      return { z: z, y: topAt[z] };
    });
    if (!pts.length) return [];
    /* upper hull, left to right (monotone chain) */
    var hull = [];
    pts.forEach(function (p) {
      while (hull.length >= 2) {
        var o = hull[hull.length - 2];
        var a = hull[hull.length - 1];
        if ((a.z - o.z) * (p.y - o.y) - (a.y - o.y) * (p.z - o.z) >= 0) hull.pop();
        else break;
      }
      hull.push(p);
    });
    var left = { z: Math.min(STRAP_ANCHOR, hull[0].z), y: 0 };
    var right = { z: Math.max(W - STRAP_ANCHOR, hull[hull.length - 1].z), y: 0 };
    return [left].concat(hull, [right]);
  }

  /* High, narrow stacks may tip over before they slide. */
  function tipping(placed, s, blockedFront, blockedSides) {
    var risk = [];
    s.boxes.forEach(function (i) {
      var b = placed[i];
      if (b.y > 1) return;
      var top = b.y + b.h;
      s.boxes.forEach(function (j) {
        var o = placed[j];
        if (o.x < b.x + b.l && b.x < o.x + o.l && o.z < b.z + b.w && b.z < o.z + o.w) top = Math.max(top, o.y + o.h);
      });
      if (!blockedSides && top / b.w > C.vertical / C.side) risk.push('lado');
      else if (!blockedFront && top / b.l > C.vertical / C.forward) risk.push('frente');
      else if (top / b.l > C.vertical / C.backward) risk.push('trás');
    });
    return risk.filter(function (d, i) {
      return risk.indexOf(d) === i;
    });
  }

  /* -------------------------------------------------------------- the plan --- */
  /* opts: { surface, stf, mu (overrides the surface), fill (gaps filled) } */
  function plan(vehicle, placed, opts) {
    var o = cleanOptions(opts);
    var mu = opts && opts.mu > 0 ? opts.mu : surfaceOf(o.surface).mu;
    var fill = !!(opts && opts.fill);
    var wall = walls(vehicle);
    var W = vehicle.w;
    var sections = placed.length ? sectionsOf(placed) : [];
    var result = {
      mu: mu, stf: o.stf, surface: o.surface, fill: fill, walls: wall,
      sections: sections, straps: [], total: 0, notes: [], gaps: []
    };
    if (!sections.length) return result;

    /* forward: the chain of sections standing against the front wall */
    var gapTol = fill ? FILL_LENGTH : CONTACT;
    var chain = wall.front > 0;
    sections.forEach(function (s, k) {
      var gap = k === 0 ? s.from : s.from - sections[k - 1].to;
      if (gap > CONTACT && gap <= FILL_LENGTH) result.gaps.push({ at: k === 0 ? 0 : sections[k - 1].to, size: gap });
      chain = chain && gap <= gapTol;
      s.blockedFront = chain;
      var free = s.zmin + (W - s.zmax);
      s.freeWidth = free;
      s.blockedSides = wall.side > 0 && free <= (fill ? FILL_SIDE : SIDE_TOUCH);
    });

    function demand(c, m) {
      return Math.max(0, c - mu * C.vertical) * m * G;
    }
    /* what the walls cannot take is left to the straps, shared by the
       sections leaning on them */
    function leftover(key, c, capacity) {
      var total = 0;
      sections.forEach(function (s) {
        if (s[key]) total += demand(c, s.weight);
      });
      return total > capacity && total > 0 ? 1 - capacity / total : 0;
    }
    var restFront = leftover('blockedFront', C.forward, wall.front);
    var restSide = leftover('blockedSides', C.side, wall.side);

    sections.forEach(function (s, k) {
      s.index = k + 1;
      var len = s.to - s.from;
      /* the strap's angle with the floor, on the worse side: up the side
         of the load from a lashing point by the wall */
      var gapSide = Math.min(s.zmin, W - s.zmax) + 30;
      s.sinA = s.top / Math.hypot(s.top, gapSide);
      s.alpha = Math.round((Math.asin(Math.min(1, s.sinA)) * 180) / Math.PI);
      var per = 2 * mu * s.sinA * o.stf / FS; /* daN one strap holds */
      var force = {
        forward: demand(C.forward, s.weight) * (s.blockedFront ? restFront : 1),
        backward: demand(C.backward, s.weight),
        side: demand(C.side, s.weight) * (s.blockedSides ? restSide : 1)
      };
      s.force = force;
      var need = {};
      Object.keys(force).forEach(function (d) {
        need[d] = force[d] > 0 ? Math.ceil(force[d] / per - 1e-9) : 0;
      });
      s.need = need;
      var n = Math.max(need.forward, need.backward, need.side);
      s.why = n === 0 ? '' : need.forward === n ? 'frente' : need.side === n ? 'lados' : 'trás';
      var minimum = Math.max(1, Math.ceil(len / SPACING - 1e-9));
      if (n < minimum) {
        /* the forces need fewer: the spacing rule sets the number */
        n = minimum;
        s.why = 'espaçamento';
      }
      s.tipping = tipping(placed, s, s.blockedFront, s.blockedSides);
      if (s.tipping.length && n < 2) {
        n = 2;
        s.why = 'tombamento';
      }
      s.n = n;
      result.total += n;
      /* the straps, spread evenly over the section */
      for (var j = 0; j < n; j++) {
        var x = s.from + ((j + 0.5) * len) / n;
        var p = profileAt(placed, s, x);
        var uneven = p.top - p.low > UNEVEN;
        if (uneven) s.uneven = true;
        result.straps.push({
          x: Math.round(x), top: p.top, zmin: p.zmin, zmax: p.zmax, section: s.index, uneven: uneven,
          path: strapPath(placed, s, x, W)
        });
      }
    });

    /* what the loader should know */
    result.notes.push('Use cantoneiras nas arestas da carga sob as cintas e confira a tensão a cada parada.');
    if (sections.some(function (s) {
      return s.fragileTop;
    })) {
      result.notes.push('Há volumes frágeis no topo: proteja-os com uma placa ou cantoneira larga e não aperte demais as cintas.');
    }
    if (sections.some(function (s) {
      return s.tipping.length;
    })) {
      result.notes.push('Pilhas altas e estreitas podem tombar: amarre-as com cintas próprias ou trave-as contra outras cargas.');
    }
    var uneven = sections.filter(function (s) {
      return s.uneven;
    }).map(function (s) {
      return s.index;
    });
    if (uneven.length) {
      result.notes.push('Alturas diferentes sob a mesma cinta (seção ' + uneven.join(', ') + '): a cinta apoia na pilha mais alta ' +
        'e não prende as mais baixas. Nivele com calços ou passe cintas separadas sobre as pilhas baixas.');
    }
    if (wall.front === 0) result.notes.push('Plataforma sem paredes: toda a carga depende das cintas (e de batentes, se houver).');
    if (restFront > 0) {
      result.notes.push('A carga encostada na parede frontal passa do que a parede aguenta (' +
        Math.round(wall.front).toLocaleString('pt-BR') + ' daN): as cintas cobrem o resto.');
    }
    return result;
  }

  /* The options compared, fewest straps recommended. */
  function ideal(vehicle, placed, opts) {
    var o = cleanOptions(opts);
    var base = surfaceOf(o.surface);
    var list = [
      { key: 'base', label: 'Como está (' + base.label.replace(/ \(μ.*$/, '').toLowerCase() + ')', plan: plan(vehicle, placed, o) }
    ];
    if (base.mu < MAT_MU) {
      list.push({ key: 'mat', label: 'Com tapete antiderrapante', plan: plan(vehicle, placed, { surface: 'tapete', stf: o.stf }) });
    }
    list.push({ key: 'fill', label: 'Com calços nos vãos', plan: plan(vehicle, placed, { surface: o.surface, stf: o.stf, fill: true }) });
    if (base.mu < MAT_MU) {
      list.push({ key: 'both', label: 'Tapete antiderrapante + calços', plan: plan(vehicle, placed, { surface: 'tapete', stf: o.stf, fill: true }) });
    }
    var best = list[0];
    list.forEach(function (x) {
      if (x.plan.total < best.plan.total) best = x;
    });
    var text;
    if (!placed.length) text = 'Não há carga para amarrar.';
    else if (best === list[0]) text = 'Amarre como está: ' + best.plan.total + (best.plan.total === 1 ? ' cinta.' : ' cintas.');
    else {
      text = best.label + ': ' + best.plan.total + ' cintas em vez de ' + list[0].plan.total + '.';
      if (best.key === 'fill' || best.key === 'both') {
        var gaps = list[0].plan.gaps.concat([]);
        var wide = list[0].plan.sections.filter(function (s) {
          return !s.blockedSides && s.freeWidth > SIDE_TOUCH && s.freeWidth <= FILL_SIDE;
        }).length;
        var parts = [];
        if (gaps.length) parts.push(gaps.length + (gaps.length === 1 ? ' vão' : ' vãos') + ' ao longo do baú');
        if (wide) parts.push('folga lateral em ' + wide + (wide === 1 ? ' seção' : ' seções'));
        if (parts.length) text += ' Preencha ' + parts.join(' e ') + ' com calços, paletes vazios ou bolsas de ar.';
      }
    }
    return { best: best, options: list, recommendation: text };
  }

  root.SyncrofinLashing = {
    SURFACES: SURFACES,
    DEFAULTS: DEFAULTS,
    ACCEL: C,
    FS: FS,
    cleanOptions: cleanOptions,
    walls: walls,
    sectionsOf: sectionsOf,
    plan: plan,
    ideal: ideal
  };
})(typeof window !== 'undefined' ? window : this);
