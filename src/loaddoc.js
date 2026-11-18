/* Syncrofin 3D Planner — the loading-order document (PDF).

   One button, "Ordem de carregamento (PDF)": a document for the people who
   load the vehicle, always from the far end of the cargo space (the front
   wall, by the cab) towards the doors.

   - Cover: the vehicle, the totals, the load on each axle, what the checker
     found and a picture of the whole load.
   - Then the steps (LoadPlan.loadingSteps): a box goes in only after the
     boxes it rests on, deepest first, then lowest, then on the left; each
     step is a section of the load about 1,25 m long. Per step: a picture
     from the doors with what is loaded so far and the step marked, a plan
     view and a side view to scale with the sequence numbers, and a table —
     number, box, client, size, weight, distance from the far end, height,
     side and notes (fragile, laid down, turned).

   The PDF is written here (SyncrofinPdf, no library) and opened in a new
   tab, where it can be printed or saved; if the browser blocks the tab it
   is downloaded instead. Pictures need the WebGL view (SyncrofinScene); the
   drawings and tables do not. */

(function () {
  'use strict';

  var Pdf = window.SyncrofinPdf;
  var LoadPlan = window.SyncrofinLoadPlan;

  var INK = [47, 51, 55];
  var MUTED = [107, 107, 107];
  var LINE = [207, 212, 217];
  var DARK = [92, 91, 91];
  var AMBER = [228, 169, 52];
  var STATUS = { ok: [63, 140, 70], warn: [190, 130, 20], over: [200, 50, 50] };

  var M = 36; /* page margin, pt */
  var FOOT = 34; /* room kept for the footer */

  var MODE_NAMES = { normal: 'Normal', cliente: 'Por cliente', itinerario: 'Por itinerário' };

  function fmt(n, digits) {
    return Number(n || 0).toLocaleString('pt-BR', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits || 0
    });
  }

  function metres(mm) {
    return fmt(mm / 1000, 2) + ' m';
  }

  function today() {
    var d = new Date();
    var p = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function slug(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  }

  /* how a box sits compared with how its item was entered */
  function notes(b, item) {
    var out = [];
    if (item) {
      if (Math.round(b.h) !== Math.round(item.h)) out.push('deitado');
      else if (b.l !== b.w && Math.round(b.l) === Math.round(item.w) && Math.round(b.w) === Math.round(item.l)) out.push('girado');
      if (item.fragile) out.push('frágil');
      else if (item.maxTop === 0) out.push('não empilhar');
    }
    return out.join(', ');
  }

  function sideOf(b, W) {
    if (b.w >= W * 0.8) return 'toda a largura';
    var c = b.z + b.w / 2;
    return c < W / 3 ? 'esquerdo' : c > (W * 2) / 3 ? 'direito' : 'centro';
  }

  /* ------------------------------------------------------------ the build --- */
  function build(data) {
    var doc = Pdf.create();
    var PW = doc.width;
    var PH = doc.height;
    var CW = PW - 2 * M;
    var V = data.space;
    var tractor = data.tractor;
    var gl = window.SyncrofinScene && window.SyncrofinScene.active && window.SyncrofinScene.snapshot ? window.SyncrofinScene : null;
    var itemsById = {};
    (data.items || []).forEach(function (it) {
      itemsById[it.id] = it;
    });
    var placed = data.placed || [];
    var plan = LoadPlan.loadingSteps(placed);
    var seq = [];
    plan.order.forEach(function (idx, i) {
      seq[idx] = i + 1;
    });
    var vehicleName = V.name + (tractor ? ' + ' + tractor.name : '');
    var y = 0;

    function newPage() {
      doc.addPage();
      y = M;
    }

    function room(h) {
      if (y + h > PH - FOOT - 6) {
        newPage();
        return true;
      }
      return false;
    }

    function paragraph(text, size, opts) {
      opts = opts || {};
      var lines = doc.wrap(text, size, opts.bold, opts.width || CW);
      lines.forEach(function (ln) {
        room(size * 1.35);
        y += size * 1.2;
        doc.text(opts.x || M, y, ln, { size: size, bold: opts.bold, color: opts.color || INK });
        y += size * 0.15;
      });
    }

    function picture(o, x, top, w, h) {
      if (!gl) return false;
      var shot = null;
      try {
        shot = gl.snapshot(Object.assign({
          space: V, tractor: tractor, names: data.names, palette: data.palette,
          width: Math.round(w * 2.4), height: Math.round(h * 2.4)
        }, o));
      } catch (e) {
        shot = null;
      }
      if (!shot || !shot.url) return false;
      doc.image(shot.url, shot.width, shot.height, x, top, w, h);
      doc.rect(x, top, w, h, { stroke: LINE, lw: 0.6 });
      return true;
    }

    /* plan view (from above) and side view (from the left) to scale: earlier
       boxes in grey, this step's boxes in their colour with their numbers */
    function drawings(x0, top, w, maxH, loaded, current) {
      /* one above the other; a short vehicle (a van) draws larger with the
         two side by side */
      var GAP = 34;
      var scStack = Math.min(w / V.l, (maxH - 30) / (V.w + V.h));
      var scSide = Math.min((w - GAP - 30) / (2 * V.l), (maxH - 12) / Math.max(V.w, V.h));
      var sideBySide = scSide > scStack * 1.25;
      var sc = sideBySide ? scSide : scStack;
      var pw = V.l * sc;
      var ph = V.w * sc;
      var sh = V.h * sc;
      var x = x0;
      var cur = {};
      current.forEach(function (i) {
        cur[i] = true;
      });
      /* the title over the drawing, "portas »" at its right end; when they
         would touch, the short title, and "portas »" beside the drawing */
      function caption(cx, cy, long, short, bodyH) {
        var doorsW = doc.textWidth('portas »', 6.5, false);
        var room = Math.max(pw, sideBySide ? 0 : w) - 6;
        var inline = pw - doorsW - 8 >= doc.textWidth(short, 6.5, true);
        if (inline) room = pw - doorsW - 8;
        var text = doc.textWidth(long, 6.5, true) <= room ? long : short;
        doc.text(cx, cy, text, { size: 6.5, bold: true, color: MUTED });
        if (inline) doc.text(cx + pw, cy, 'portas »', { size: 6.5, color: MUTED, align: 'right' });
        else doc.text(cx + pw + 4, cy + 2 + bodyH / 2 + 2, 'portas »', { size: 6.5, color: MUTED });
      }
      function boxFill(i) {
        var b = placed[i];
        return cur[i] ? Pdf.hex((data.palette || {})[b.color] || '#5fc2ea') : [226, 229, 232];
      }
      function label(i, bx, by, bw, bh) {
        if (!cur[i] || bw < 7 || bh < 6) return;
        var size = Math.min(6.5, bh * 0.7, bw / (String(seq[i]).length * 0.6));
        if (size < 3.2) return;
        doc.text(bx + bw / 2, by + bh / 2 + size * 0.35, String(seq[i]), { size: size, bold: true, color: INK, align: 'center' });
      }
      /* plan view: x to the right (far end on the left), the vehicle's left side on top */
      var py = top + 9;
      caption(x, py - 2, 'PLANTA (DE CIMA) · fundo à esquerda, lado esquerdo em cima', 'PLANTA (DE CIMA)', ph);
      doc.rect(x, py, pw, ph, { fill: [250, 251, 252], stroke: DARK, lw: 0.8 });
      loaded.slice().sort(function (a, b) {
        return placed[a].y + placed[a].h - (placed[b].y + placed[b].h);
      }).forEach(function (i) {
        var b = placed[i];
        var bx = x + b.x * sc;
        var by = py + b.z * sc;
        doc.rect(bx, by, b.l * sc, b.w * sc, { fill: boxFill(i), stroke: cur[i] ? INK : [170, 175, 180], lw: cur[i] ? 0.5 : 0.3 });
        label(i, bx, by, b.l * sc, b.w * sc);
      });
      doc.rect(x - 2.2, py, 2.2, ph, { fill: DARK }); /* the far wall */
      /* side view from the left: the floor at the bottom */
      var sy = sideBySide ? py : py + ph + 15;
      if (sideBySide) x = x0 + pw + GAP;
      caption(x, sy - 2, 'VISTA LATERAL ESQUERDA · fundo à esquerda', 'LATERAL ESQUERDA', sh);
      doc.rect(x, sy, pw, sh, { fill: [250, 251, 252], stroke: DARK, lw: 0.8 });
      loaded.slice().sort(function (a, b) {
        return placed[b].z - placed[a].z; /* the far side first, the near side over it */
      }).forEach(function (i) {
        var b = placed[i];
        var bx = x + b.x * sc;
        var by = sy + sh - (b.y + b.h) * sc;
        doc.rect(bx, by, b.l * sc, b.h * sc, { fill: boxFill(i), stroke: cur[i] ? INK : [170, 175, 180], lw: cur[i] ? 0.5 : 0.3 });
        label(i, bx, by, b.l * sc, b.h * sc);
      });
      doc.rect(x - 2.2, sy, 2.2, sh, { fill: DARK });
      if (sideBySide) {
        doc.text(x0, py + ph + 10, 'Lado esquerdo do veículo em cima; a barra escura é o fundo.', { size: 6, color: MUTED });
        return Math.max(ph + 12, sh) + 9;
      }
      return sy + sh - top;
    }

    /* ---- the step table ---- */
    var COLS = [
      { key: 'n', title: 'Nº', w: 24, align: 'right' },
      { key: 'name', title: 'Volume', w: 106 },
      { key: 'client', title: 'Cliente', w: 78 },
      { key: 'size', title: 'C × L × A (mm)', w: 94 },
      { key: 'kg', title: 'Peso', w: 42, align: 'right' },
      { key: 'x', title: 'Do fundo', w: 44, align: 'right' },
      { key: 'y', title: 'Altura', w: 38, align: 'right' },
      { key: 'side', title: 'Lado', w: 46 },
      { key: 'notes', title: 'Obs.', w: 51 }
    ];
    var ROW = 12.5;

    function tableHead() {
      doc.rect(M, y, CW, 13, { fill: [238, 241, 244] });
      var cx = M;
      COLS.forEach(function (c) {
        var tx = c.align === 'right' ? cx + c.w - 4 : cx + 4;
        doc.text(tx, y + 9, c.title, { size: 7, bold: true, color: MUTED, align: c.align === 'right' ? 'right' : 'left' });
        cx += c.w;
      });
      y += 13;
    }

    function fit(text, w, size, bold) {
      var s = String(text);
      if (doc.textWidth(s, size, bold) <= w) return s;
      while (s.length > 1 && doc.textWidth(s + '…', size, bold) > w) s = s.slice(0, -1);
      return s + '…';
    }

    function tableRow(i, stepNo) {
      if (room(ROW)) {
        doc.text(M, y + 8, 'Etapa ' + stepNo + ' (continuação)', { size: 8, bold: true, color: MUTED });
        y += 12;
        tableHead();
      }
      var b = placed[i];
      var item = itemsById[b.id];
      var cells = {
        n: String(seq[i]),
        name: (item && item.name) || b.name || 'Volume',
        client: (item && item.dest) || '—',
        size: fmt(b.l) + ' × ' + fmt(b.w) + ' × ' + fmt(b.h),
        kg: fmt(b.weight || 0) + ' kg',
        x: metres(b.x),
        y: metres(b.y),
        side: sideOf(b, V.w),
        notes: notes(b, item)
      };
      doc.line(M, y + ROW, M + CW, y + ROW, { stroke: [228, 231, 234], lw: 0.4 });
      var cx = M;
      COLS.forEach(function (c) {
        var size = 7.5;
        var bold = c.key === 'n';
        var tx = c.align === 'right' ? cx + c.w - 4 : cx + 4;
        var avail = c.w - 8;
        if (c.key === 'name') {
          /* the colour of the item, as in the list */
          doc.rect(cx + 4, y + 3.2, 6, 6, { fill: Pdf.hex((data.palette || {})[b.color] || '#5fc2ea'), stroke: [120, 120, 120], lw: 0.3 });
          tx += 9;
          avail -= 9;
        }
        doc.text(tx, y + 8.8, fit(cells[c.key], avail, size, bold), { size: size, bold: bold, color: INK, align: c.align === 'right' ? 'right' : 'left' });
        cx += c.w;
      });
      y += ROW;
    }

    /* ================================================================ cover */
    newPage();
    doc.rect(0, 0, PW, 54, { fill: DARK });
    doc.rect(0, 54, PW, 3, { fill: AMBER });
    doc.text(M, 33, 'Ordem de carregamento', { size: 19, bold: true, color: [255, 255, 255] });
    doc.text(PW - M, 24, 'Syncrofin 3D Planner', { size: 9, bold: true, color: [255, 255, 255], align: 'right' });
    doc.text(PW - M, 38, today(), { size: 9, color: [235, 235, 235], align: 'right' });
    y = 76;
    paragraph(vehicleName, 13, { bold: true });
    paragraph('Espaço interno ' + fmt(V.l) + ' × ' + fmt(V.w) + ' × ' + fmt(V.h) + ' mm · carga útil ' + fmt(V.payload) + ' kg', 9, { color: MUTED });
    y += 8;

    /* the rule of the document, in a box */
    var rule = 'Carregue sempre do FUNDO para as PORTAS. Comece pela parede do fundo (junto à cabine) e siga a numeração: ' +
      'cada volume só entra depois dos volumes que ficam embaixo dele. Nas etapas, os volumes da etapa aparecem em destaque ' +
      '(laranja na imagem, coloridos na planta e na vista lateral) e os já carregados em cinza.';
    var ruleLines = doc.wrap(rule, 9, false, CW - 24);
    var ruleH = ruleLines.length * 11.5 + 14;
    doc.rect(M, y, CW, ruleH, { fill: [253, 246, 232], stroke: AMBER, lw: 0.8 });
    doc.rect(M, y, 4, ruleH, { fill: AMBER });
    ruleLines.forEach(function (ln, i) {
      doc.text(M + 14, y + 16 + i * 11.5, ln, { size: 9, color: INK });
    });
    y += ruleH + 12;

    /* totals */
    var t = data.totals || {};
    var used = 0;
    placed.forEach(function (b) {
      used = Math.max(used, b.x + b.l);
    });
    var facts = [
      ['Volumes', fmt(t.count || placed.length) + (data.unplaced && data.unplaced.length ? ' de ' + fmt(t.queue) : '')],
      ['Peso da carga', fmt(t.weight) + ' kg'],
      ['Volume da carga', fmt(t.volume, 1) + ' m³'],
      ['Comprimento usado', metres(used)],
      ['Etapas', fmt(plan.steps.length)],
      ['Planejamento', (MODE_NAMES[data.mode] || '') + (data.control === 'manual' ? ' · ajuste manual' : '')]
    ];
    var colW = CW / 3;
    facts.forEach(function (f, i) {
      var fx = M + (i % 3) * colW;
      var fy = y + Math.floor(i / 3) * 30;
      doc.text(fx, fy + 9, f[0].toUpperCase(), { size: 7, bold: true, color: MUTED });
      doc.text(fx, fy + 23, f[1], { size: 12, bold: true, color: INK });
    });
    y += 64;

    /* the whole load */
    var overviewH = 215;
    if (picture({ placed: placed, whole: true, az: data.view ? data.view.az : -2.3, elev: data.view ? Math.max(0.25, Math.min(0.9, data.view.elev)) : 0.4 }, M, y, CW, overviewH)) {
      y += overviewH + 12;
    }

    /* axle loads as the vehicle leaves */
    var st = data.check && data.check.states && data.check.states[0];
    var rows = st ? st.res.rows.filter(function (r) {
      return !(r.info && !(r.max > 0));
    }) : [];
    if (rows.length) {
      room(30 + rows.length * 12);
      doc.text(M, y + 10, 'CARGA POR EIXO NA SAÍDA', { size: 8, bold: true, color: MUTED });
      y += 16;
      var aw = [190, 90, 90, 70];
      var heads = ['Eixo', 'Carga', 'Máximo', 'Uso'];
      doc.rect(M, y, 440, 12, { fill: [238, 241, 244] });
      var ax = M;
      heads.forEach(function (hd, i) {
        doc.text(i ? ax + aw[i] - 4 : ax + 4, y + 8.5, hd, { size: 7, bold: true, color: MUTED, align: i ? 'right' : 'left' });
        ax += aw[i];
      });
      y += 12;
      var lines = rows.map(function (r) {
        return [(r.part === 'tractor' ? 'Cavalo · ' : '') + r.label + ' (' + r.letter + ')', r.load, r.max, r.status];
      });
      if (st.res.gross && st.res.gross.max) lines.push(['Peso bruto', st.res.gross.load, st.res.gross.max, st.res.gross.status]);
      lines.forEach(function (l) {
        var cx = M;
        var vals = [l[0], fmt(l[1]) + ' kg', l[2] ? fmt(l[2]) + ' kg' : '—', l[2] ? Math.round((l[1] / l[2]) * 100) + '%' : '—'];
        vals.forEach(function (v, i) {
          doc.text(i ? cx + aw[i] - 4 : cx + 4, y + 9, v, {
            size: 8, bold: i === 3, color: i === 3 ? STATUS[l[3]] || INK : INK, align: i ? 'right' : 'left'
          });
          cx += aw[i];
        });
        doc.line(M, y + 12, M + 440, y + 12, { stroke: [228, 231, 234], lw: 0.4 });
        y += 12;
      });
      y += 8;
    }

    /* what the checker found, and what was left out */
    var problems = (data.check && data.check.problems) || [];
    if (problems.length || (data.unplaced && data.unplaced.length)) {
      room(30);
      doc.text(M, y + 10, 'ATENÇÃO', { size: 8, bold: true, color: STATUS.over });
      y += 14;
      if (data.unplaced && data.unplaced.length) {
        paragraph('• ' + fmt(data.unplaced.length) + (data.unplaced.length === 1 ? ' volume ficou' : ' volumes ficaram') +
          ' de fora do plano e não constam desta ordem.', 8.5, { x: M + 4, width: CW - 4 });
      }
      problems.slice(0, 8).forEach(function (p) {
        paragraph('• ' + (data.check.states.length > 1 ? p.state + ': ' : '') + p.text, 8.5, { x: M + 4, width: CW - 4 });
      });
      if (problems.length > 8) paragraph('• e mais ' + (problems.length - 8) + ' avisos no planejador.', 8.5, { x: M + 4, width: CW - 4 });
      y += 6;
    }

    if (!placed.length) {
      paragraph('Não há volumes no plano.', 11, { bold: true });
    }

    /* ================================================================ steps */
    var loadedSoFar = [];
    plan.steps.forEach(function (step, k) {
      var stepNo = k + 1;
      var first = seq[step.boxes[0]];
      var last = seq[step.boxes[step.boxes.length - 1]];
      loadedSoFar = loadedSoFar.concat(step.boxes);

      var drawW = gl ? CW - 262 : CW;
      var sc = Math.min(drawW / V.l, (150 - 30) / (V.w + V.h));
      var drawH = (V.w + V.h) * sc + 30;
      var blockH = 26 + Math.max(gl ? 150 : 0, drawH) + 10 + 13 + ROW * Math.min(3, step.boxes.length);
      if (k === 0 || y + blockH > PH - FOOT - 6) newPage();
      else y += 10;

      /* header */
      doc.rect(M, y, CW, 20, { fill: [238, 241, 244] });
      doc.rect(M, y, 4, 20, { fill: AMBER });
      doc.text(M + 12, y + 14, 'Etapa ' + stepNo + ' de ' + plan.steps.length, { size: 11, bold: true, color: INK });
      doc.text(M + CW - 8, y + 14, 'volumes ' + first + (last !== first ? ' a ' + last : '') + ' · de ' + metres(step.from) +
        ' a ' + metres(step.to) + ' do fundo', { size: 8.5, color: MUTED, align: 'right' });
      y += 26;

      var top = y;
      var picH = 0;
      if (gl) {
        var marks = step.boxes.map(function (i) {
          return placed[i];
        });
        var ok = picture({
          placed: loadedSoFar.map(function (i) {
            return placed[i];
          }),
          mark: marks,
          /* closer in: the part of the cargo space loaded so far, and a little more */
          frameTo: Math.max(step.to + 1500, 3000)
        }, M, top, 252, 150);
        if (ok) picH = 150;
      }
      var dx = picH ? M + 262 : M;
      var dw = picH ? CW - 262 : CW;
      var dh = drawings(dx, top, dw, 150, loadedSoFar, step.boxes);
      y = top + Math.max(picH, dh) + 10;

      tableHead();
      step.boxes.forEach(function (i) {
        tableRow(i, stepNo);
      });
    });

    /* ======================================================= securing plan */
    var lash = data.lash;
    if (lash && placed.length) {
      var lp = lash.best.plan;
      newPage();
      doc.rect(M, y, CW, 22, { fill: [255, 244, 234] });
      doc.rect(M, y, 4, 22, { fill: [255, 109, 0] });
      doc.text(M + 12, y + 15, 'Plano de amarração', { size: 12, bold: true, color: INK });
      /* (the PDF's standard fonts have no μ) */
      doc.text(M + CW - 8, y + 15, lp.total + (lp.total === 1 ? ' cinta' : ' cintas') + ' · STF ' + fmt(lp.stf) + ' daN · atrito ' +
        fmt(lp.mu, 2), { size: 8.5, color: MUTED, align: 'right' });
      y += 30;
      paragraph(lash.recommendation, 10, { bold: true });
      y += 6;
      if (picture({ placed: placed, straps: lp.straps, frameTo: Math.max(used + 1200, 3000) }, M, y, CW, 230)) y += 240;
      /* sections */
      var LC = [
        { t: 'Seção', w: 40 }, { t: 'Do fundo', w: 82 }, { t: 'Peso', w: 62, r: true }, { t: 'Altura', w: 52, r: true },
        { t: 'Frente', w: 56 }, { t: 'Laterais', w: 56 }, { t: 'Ângulo', w: 46, r: true }, { t: 'Cintas', w: 44, r: true }, { t: 'Motivo', w: 85 }
      ];
      var WHY = { frente: 'frente', 'trás': 'trás', lados: 'lados', 'espaçamento': 'espaçamento', tombamento: 'tombamento' };
      function lashHead() {
        doc.rect(M, y, CW, 13, { fill: [238, 241, 244] });
        var cx = M;
        LC.forEach(function (c) {
          doc.text(c.r ? cx + c.w - 4 : cx + 4, y + 9, c.t, { size: 7, bold: true, color: MUTED, align: c.r ? 'right' : 'left' });
          cx += c.w;
        });
        y += 13;
      }
      room(30);
      lashHead();
      lp.sections.forEach(function (s) {
        if (room(ROW)) lashHead();
        var vals = [
          String(s.index), metres(s.from) + ' – ' + metres(s.to), fmt(s.weight) + ' kg', metres(s.top),
          s.blockedFront ? 'travada' : 'livre', s.blockedSides ? 'travada' : 'livre', s.alpha + '°', String(s.n),
          (WHY[s.why] || '') + (s.tipping.length && s.why !== 'tombamento' ? ', tomb.' : '')
        ];
        var cx = M;
        LC.forEach(function (c, i) {
          doc.text(c.r ? cx + c.w - 4 : cx + 4, y + 8.8, vals[i], { size: 7.5, bold: i === 7, color: INK, align: c.r ? 'right' : 'left' });
          cx += c.w;
        });
        doc.line(M, y + ROW, M + CW, y + ROW, { stroke: [228, 231, 234], lw: 0.4 });
        y += ROW;
      });
      y += 8;
      /* the options compared */
      room(20 + lash.options.length * 12);
      doc.text(M, y + 9, 'OPÇÕES COMPARADAS', { size: 7.5, bold: true, color: MUTED });
      y += 13;
      lash.options.forEach(function (o) {
        var mark = o === lash.best;
        doc.text(M + 4, y + 9, (mark ? '» ' : '') + o.label, { size: 8.5, bold: mark, color: INK });
        doc.text(M + 300, y + 9, o.plan.total + (o.plan.total === 1 ? ' cinta' : ' cintas'), { size: 8.5, bold: mark, color: INK, align: 'right' });
        y += 12;
      });
      y += 6;
      lp.notes.forEach(function (n) {
        paragraph('• ' + n, 8.5, { x: M + 4, width: CW - 4 });
      });
      y += 4;
      paragraph('Cálculo de amarração por atrito (por cima da carga) da EN 12195-1: 0,8 g para a frente, 0,5 g para trás e para os ' +
        'lados, fator de segurança 1,1. A parede frontal segura a carga encostada nela até 40% da carga útil (máx. 5 000 daN no baú, ' +
        'EN 12642 L); as paredes laterais, a carga que ocupa a largura toda; as portas traseiras não contam. Confira com a ' +
        'Resolução CONTRAN nº 552/2015 e com a etiqueta das cintas.', 7.5, { color: MUTED });
    }

    if (placed.length) {
      room(40);
      y += 14;
      doc.text(M, y, 'Carregamento concluído: ' + fmt(placed.length) + ' volumes, ' + fmt(t.weight) + ' kg.', { size: 10, bold: true, color: INK });
      y += 22;
      doc.line(M, y, M + 200, y, { stroke: [150, 150, 150], lw: 0.6 });
      doc.line(M + 260, y, M + 460, y, { stroke: [150, 150, 150], lw: 0.6 });
      doc.text(M, y + 11, 'Responsável pelo carregamento', { size: 7.5, color: MUTED });
      doc.text(M + 260, y + 11, 'Conferente', { size: 7.5, color: MUTED });
    }

    /* footers */
    var n = doc.pageCount();
    for (var p = 0; p < n; p++) {
      doc.goTo(p);
      doc.line(M, PH - FOOT + 8, PW - M, PH - FOOT + 8, { stroke: LINE, lw: 0.5 });
      doc.text(M, PH - FOOT + 20, 'Syncrofin 3D Planner · Ordem de carregamento · ' + vehicleName, { size: 7, color: MUTED });
      doc.text(PW - M, PH - FOOT + 20, 'Página ' + (p + 1) + ' de ' + n, { size: 7, color: MUTED, align: 'right' });
    }
    return { bytes: doc.output(), name: 'ordem-de-carregamento-' + slug(V.name) + '.pdf', pages: n, steps: plan.steps.length };
  }

  /* --------------------------------------------------------------- the button --- */
  function open() {
    var app = window.SyncrofinApp;
    if (!app || !app.docData || !Pdf || !LoadPlan) return;
    /* the tab is opened at once, inside the click, so no pop-up blocker stops it */
    var win = null;
    try {
      win = window.open('', '_blank');
      if (win && win.document) {
        win.document.title = 'Ordem de carregamento';
        win.document.body.style.font = '16px Arial, sans-serif';
        win.document.body.textContent = 'Gerando a ordem de carregamento…';
      }
    } catch (e) {
      win = null;
    }
    var btn = document.querySelector('#load-order');
    if (btn) btn.disabled = true;
    window.setTimeout(function () {
      var result = null;
      try {
        result = build(app.docData());
      } catch (e) {
        if (win) win.close();
        if (btn) btn.disabled = false;
        window.alert('Não foi possível gerar o PDF: ' + e.message);
        return;
      }
      var blob = new Blob([result.bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      if (win && !win.closed) {
        win.location.href = url;
      } else {
        var a = document.createElement('a');
        a.href = url;
        a.download = result.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      window.setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 120000);
      if (btn) btn.disabled = false;
    }, 30);
  }

  window.SyncrofinLoadDoc = { build: build, open: open };

  function wire() {
    var btn = document.querySelector('#load-order');
    if (btn) btn.addEventListener('click', open);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
