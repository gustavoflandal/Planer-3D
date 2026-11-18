/* Syncrofin 3D Planner — cargo-space screens.

   - the card over the 3D view: the chosen space, its capacity and the load
   - the side list to pick a space (and a tractor for a semitrailer), with a
     type filter, favourites and "show more"
   - the "Espaços de carga" tab: a table of every space with a filter per
     column, sorting and pages, and the form to create or edit a space, with
     a side-view diagram that follows the numbers as they are typed

   Data and arithmetic come from spaces.js (window.SyncrofinSpaces); the
   planner itself is reached through window.SyncrofinApp. */

(function () {
  'use strict';

  var S = window.SyncrofinSpaces;
  var app = null;
  var el = {};

  var PAGE_SIZE = 15;
  var LIST_LIMIT = 8;

  var ui = {
    tab: 'plan',
    drawerOpen: false,
    filterOpen: false,
    groups: [],
    favOnly: false,
    showAll: false,
    table: { sort: 'name', dir: 1, page: 1 },
    form: null, /* { space, editing } while the form is open */
    notice: ''
  };

  /* --------------------------------------------------------------- helpers --- */
  function $(sel) {
    return document.querySelector(sel);
  }

  function fmt(n, digits) {
    var d = digits || 0;
    if (!isFinite(n)) return '—';
    return Number(n).toLocaleString('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fold(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  }

  function h(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else if (k === 'data') {
          Object.keys(v).forEach(function (d) {
            n.dataset[d] = v[d];
          });
        } else n.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function clear(node) {
    if (node) node.innerHTML = '';
  }

  function dateText(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }

  /* ----------------------------------------------------------------- icons --- */
  /* Small side views, drawn in currentColor, 64 × 28. */
  var ICON_SHAPES = {
    container:
      '<rect x="3" y="5" width="58" height="18" rx="1"/>' +
      '<path d="M10 7v14M17 7v14M24 7v14M31 7v14M38 7v14M45 7v14M52 7v14" stroke="#fff" stroke-opacity=".35" stroke-width="1.4"/>',
    semi:
      '<rect x="2" y="3" width="60" height="15" rx="1"/><rect x="9" y="18" width="2" height="5"/>' +
      '<circle cx="42" cy="23" r="3.6"/><circle cx="50" cy="23" r="3.6"/><circle cx="58" cy="23" r="3.6"/>',
    flatbed:
      '<rect x="2" y="15" width="60" height="3.5"/><rect x="9" y="18" width="2" height="5"/>' +
      '<circle cx="42" cy="23" r="3.6"/><circle cx="50" cy="23" r="3.6"/><circle cx="58" cy="23" r="3.6"/>',
    lorry:
      '<path d="M2 20V10l4-5h9v15z"/><rect x="17" y="2" width="45" height="18" rx="1"/>' +
      '<circle cx="9" cy="23" r="3.6"/><circle cx="46" cy="23" r="3.6"/><circle cx="54" cy="23" r="3.6"/>',
    trailer:
      '<rect x="8" y="3" width="54" height="16" rx="1"/><rect x="1" y="17" width="8" height="1.6"/>' +
      '<circle cx="16" cy="23" r="3.6"/><circle cx="52" cy="23" r="3.6"/>',
    tractor:
      '<path d="M8 20V8l5-5h13v17z"/><rect x="8" y="17.5" width="48" height="3"/><rect x="38" y="15" width="12" height="2.5"/>' +
      '<circle cx="17" cy="23" r="3.6"/><circle cx="44" cy="23" r="3.6"/><circle cx="52" cy="23" r="3.6"/>',
    notractor:
      '<path d="M8 20V8l5-5h13v17z" opacity=".35"/><rect x="8" y="17.5" width="48" height="3" opacity=".35"/>' +
      '<circle cx="17" cy="23" r="3.6" opacity=".35"/><circle cx="48" cy="23" r="3.6" opacity=".35"/>' +
      '<circle cx="54" cy="8" r="6" fill="none" stroke="#d64545" stroke-width="2"/><path d="M50 4l8 8" stroke="#d64545" stroke-width="2"/>'
  };

  /* The icon of a type shows its own wheels: as many as it has axles, the
     front group (one axle, or a bitruck's / 8×4's / 4-axle trailer's two) and
     the rear group where they sit on the vehicle. */
  var WHEEL_GAP = 7.8;

  function wheelRow(n, centre) {
    var out = '';
    for (var i = 0; i < n; i++) {
      var x = centre - ((n - 1) * WHEEL_GAP) / 2 + i * WHEEL_GAP;
      out += '<circle cx="' + x.toFixed(1) + '" cy="23" r="3.6"/>';
    }
    return out;
  }

  function vehicleShape(t) {
    var front = t.front;
    var rear = t.supports - front;
    if (t.kind === 'semi') {
      /* the kingpin is support A: every other support is a wheel at the rear */
      var body = /^flatbed/.test(t.id)
        ? '<rect x="2" y="15" width="60" height="3.5"/>'
        : '<rect x="2" y="3" width="60" height="15" rx="1"/>';
      return body + '<rect x="9" y="18" width="2" height="5"/>' + wheelRow(rear, 58 - ((rear - 1) * WHEEL_GAP) / 2);
    }
    if (t.van) {
      /* one-piece body: short bonnet, raked windscreen, roof to the rear doors */
      return '<path d="M2 20.5v-7l3-1.5 7-6.5h47.5a2.5 2.5 0 0 1 2.5 2.5v12.5z"/>' +
        '<path d="M9.5 11.5l4.5-4.5h5v4.5z" fill="#fff" fill-opacity=".45"/>' +
        wheelRow(front, 12) + wheelRow(rear, 50);
    }
    if (t.kind === 'lorry') {
      return '<path d="M2 20V10l4-5h9v15z"/><rect x="17" y="2" width="45" height="18" rx="1"/>' +
        wheelRow(front, front > 1 ? 11 : 9) + wheelRow(rear, 54 - ((rear - 1) * WHEEL_GAP) / 2);
    }
    if (t.kind === 'trailer') {
      return '<rect x="8" y="3" width="54" height="16" rx="1"/><rect x="1" y="17" width="8" height="1.6"/>' +
        wheelRow(front, front > 1 ? 19 : 16) + wheelRow(rear, 54 - ((rear - 1) * WHEEL_GAP) / 2);
    }
    if (t.kind === 'tractor') {
      return '<path d="M8 20V8l5-5h13v17z"/><rect x="8" y="17.5" width="50" height="3"/><rect x="38" y="15" width="12" height="2.5"/>' +
        wheelRow(front, 17) + wheelRow(rear, 46);
    }
    return ICON_SHAPES.container;
  }

  /* A type id gives that type's own icon; the plain shape names above are the
     generic ones the type filter uses. */
  function shapeFor(typeId) {
    var t = S.typeOf(typeId);
    if (!t || t.kind === 'box') return 'container';
    return t.id;
  }

  function iconSvg(shape) {
    var body = ICON_SHAPES[shape];
    if (!body) {
      var t = S.typeOf(shape);
      body = t ? vehicleShape(t) : ICON_SHAPES.container;
    }
    return '<svg viewBox="0 0 64 28" width="64" height="28" fill="currentColor" aria-hidden="true" focusable="false">' +
      body + '</svg>';
  }

  var FUNNEL = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M3 4h18l-7 8.5V19l-4 2v-8.5z" fill="currentColor"/></svg>';
  var STAR = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z" fill="currentColor"/></svg>';
  var STAR_LINE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  function dimsText(s) {
    if (S.isTractor(s)) return 'Prato: ' + fmt(s.payload) + ' kg';
    return fmt(s.l) + ' × ' + fmt(s.w) + ' × ' + fmt(s.h) + ' mm · ' + fmt(s.payload) + ' kg';
  }

  /* ------------------------------------------------------------ space card --- */
  function renderCard(sum) {
    if (!el.cardTitle || !sum) return;
    var s = sum.space;
    var cm = function (mm) {
      return fmt(mm / 10, mm % 10 ? 1 : 0);
    };
    el.cardTitle.textContent = s.name + ' (' + cm(s.l) + ' × ' + cm(s.w) + ' × ' + cm(s.h) + ' cm)';
    if (el.cardSub) {
      var sub = '';
      if (S.takesTractor(s)) sub = sum.tractor ? 'com ' + sum.tractor.name : 'sem cavalo mecânico';
      el.cardSub.textContent = sub;
      el.cardSub.hidden = !sub;
    }

    var capacity = (s.l * s.w * s.h) / 1e9;
    var free = Math.max(0, s.l - sum.usedLength) / 1000;
    var overW = sum.listWeight > s.payload + 0.5;
    var overV = sum.listVolume > capacity + 1e-6;
    clear(el.cardStats);
    el.cardStats.appendChild(
      h('thead', null, [
        h('tr', null, [
          h('td'),
          h('th', { scope: 'col', text: 'Peso' }),
          h('th', { scope: 'col', text: 'Volume' }),
          h('th', { scope: 'col', text: 'Metros livres' })
        ])
      ])
    );
    el.cardStats.appendChild(
      h('tbody', null, [
        h('tr', null, [
          h('th', { scope: 'row', title: 'Capacidade do espaço de carga', html: iconSvg(shapeFor(s.type)) }),
          h('td', { text: fmt(s.payload) + ' kg' }),
          h('td', { text: fmt(capacity, 2) + ' m³' }),
          h('td', { text: fmt(free, 2) + ' m' })
        ]),
        h('tr', null, [
          h('th', { scope: 'row', title: 'Toda a carga da lista', class: 'cargo-icon', html: iconSvg('container') }),
          h('td', { class: overW ? 'over' : null, text: fmt(sum.listWeight) + ' kg' }),
          h('td', { class: overV ? 'over' : null, text: fmt(sum.listVolume, 2) + ' m³' }),
          h('td')
        ])
      ])
    );
    if (ui.drawerOpen) renderDrawer(sum);
  }

  /* ---------------------------------------------------------------- drawer --- */
  function setDrawer(open) {
    ui.drawerOpen = open;
    if (!el.drawer) return;
    el.drawer.hidden = !open;
    el.cardOpen.setAttribute('aria-expanded', open ? 'true' : 'false');
    /* the card steps aside so the list does not cover it */
    if (el.card && el.card.parentNode && el.card.parentNode.classList) {
      el.card.parentNode.classList[open ? 'add' : 'remove']('drawer-open');
    }
    if (open) {
      renderDrawer();
      /* bring the chosen space into view: it may be far down the list */
      var chosen = el.list.querySelector && el.list.querySelector('.space-row.selected');
      if (chosen && typeof chosen.offsetTop === 'number') {
        el.list.scrollTop = Math.max(0, chosen.offsetTop - el.list.offsetTop - 8);
      }
    } else {
      setFilterPopup(false);
    }
  }

  function setFilterPopup(open) {
    ui.filterOpen = open;
    if (!el.filter) return;
    el.filter.hidden = !open;
    el.filterBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderFilterPopup();
  }

  function filtersActive() {
    return ui.groups.length > 0 || ui.favOnly;
  }

  function renderFilterPopup() {
    clear(el.filter);
    S.GROUPS.forEach(function (g) {
      var on = ui.groups.indexOf(g.id) >= 0;
      var shape = g.id === 'container' ? 'container' : g.id === 'van' ? 'van2' : g.id === 'lorry' ? 'lorry' : 'semi';
      el.filter.appendChild(
        h('button', {
          type: 'button',
          class: 'filter-opt' + (on ? ' on' : ''),
          'aria-pressed': on ? 'true' : 'false',
          data: { group: g.id }
        }, [
          h('span', { class: 'filter-icon', html: iconSvg(shape) }),
          h('span', { class: 'filter-label', text: g.label }),
          h('span', { class: 'filter-check', 'aria-hidden': 'true', text: on ? '✓' : '' })
        ])
      );
    });
  }

  /* Favourites first, then the user's own spaces (newest first), then the
     rest by name: a space just created is near the top, not behind "show more". */
  function sortForList(list) {
    var order = {};
    S.all().forEach(function (s, i) {
      order[s.id] = i;
    });
    return list.slice().sort(function (a, b) {
      var fa = S.isFavorite(a.id) ? 0 : 1;
      var fb = S.isFavorite(b.id) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      var ca = a.origin === 'custom' ? 0 : 1;
      var cb = b.origin === 'custom' ? 0 : 1;
      if (ca !== cb) return ca - cb;
      if (!ca) return order[b.id] - order[a.id];
      return a.name.localeCompare(b.name, 'pt');
    });
  }

  function cardRow(s, opts) {
    var fav = S.isFavorite(s.id);
    var pick = h('button', {
      type: 'button',
      class: 'space-pick',
      'aria-pressed': opts.selected ? 'true' : 'false',
      data: opts.tractor ? { tractor: s.id } : { pick: s.id }
    }, [
      h('span', { class: 'space-icon', html: iconSvg(shapeFor(s.type)) }),
      h('span', { class: 'space-text' }, [
        h('span', { class: 'space-name', text: s.name }),
        h('span', { class: 'space-dims', text: dimsText(s) })
      ])
    ]);
    var star = h('button', {
      type: 'button',
      class: 'star' + (fav ? ' on' : ''),
      'aria-pressed': fav ? 'true' : 'false',
      'aria-label': (fav ? 'Tirar ' : 'Marcar ') + s.name + (fav ? ' dos favoritos' : ' como favorito'),
      title: fav ? 'Tirar dos favoritos' : 'Marcar como favorito',
      data: { star: s.id },
      html: fav ? STAR : STAR_LINE
    });
    return h('li', { class: 'space-row' + (opts.selected ? ' selected' : '') + (opts.tractor ? ' tractor-row' : '') }, [pick, star]);
  }

  function renderDrawer(sum) {
    if (!el.list) return;
    sum = sum || (app && app.summary());
    if (!sum) return;
    var current = sum.space;

    el.favBtn.setAttribute('aria-pressed', ui.favOnly ? 'true' : 'false');
    el.favBtn.classList[ui.favOnly ? 'add' : 'remove']('on');
    el.favBtn.innerHTML = ui.favOnly ? STAR : STAR_LINE;
    el.filterBtn.classList[ui.groups.length ? 'add' : 'remove']('on');

    var list = sortForList(S.filter(S.cargoSpaces(), { groups: ui.groups, favoritesOnly: ui.favOnly }));
    var selectedAt = -1;
    list.forEach(function (s, i) {
      if (s.id === current.id) selectedAt = i;
    });
    var limit = ui.showAll || selectedAt >= LIST_LIMIT ? list.length : Math.min(LIST_LIMIT, list.length);

    clear(el.list);
    if (!list.length) {
      el.list.appendChild(h('li', { class: 'space-empty', text: 'Nenhum espaço de carga com estes filtros.' }));
    }
    list.slice(0, limit).forEach(function (s) {
      var selected = s.id === current.id;
      el.list.appendChild(cardRow(s, { selected: selected }));
      if (selected && S.takesTractor(s)) {
        /* A semitrailer gets the tractors that can pull it. */
        var block = h('li', { class: 'tractor-block' }, [
          h('p', { class: 'tractor-head', text: 'Cavalo mecânico' })
        ]);
        var tl = h('ul', { class: 'tractor-list' });
        var none = !sum.tractor;
        tl.appendChild(
          h('li', { class: 'space-row tractor-row' + (none ? ' selected' : '') }, [
            h('button', {
              type: 'button',
              class: 'space-pick',
              'aria-pressed': none ? 'true' : 'false',
              data: { tractor: '' }
            }, [
              h('span', { class: 'space-icon', html: iconSvg('notractor') }),
              h('span', { class: 'space-text' }, [
                h('span', { class: 'space-name', text: 'Sem cavalo' }),
                h('span', { class: 'space-dims', text: 'só a carga no pino-rei' })
              ])
            ])
          ])
        );
        sortForList(S.filter(S.tractors(), { favoritesOnly: ui.favOnly })).forEach(function (t) {
          tl.appendChild(cardRow(t, { tractor: true, selected: sum.tractor && sum.tractor.id === t.id }));
        });
        block.appendChild(tl);
        el.list.appendChild(block);
      }
    });
    if (limit < list.length) {
      el.list.appendChild(
        h('li', { class: 'space-more' }, [
          h('button', { type: 'button', class: 'link-btn', data: { more: '1' }, text: 'Mostrar mais (' + (list.length - limit) + ')' })
        ])
      );
    }
    if (filtersActive()) {
      el.list.appendChild(
        h('li', { class: 'space-more' }, [
          h('button', { type: 'button', class: 'link-btn', data: { clearfilters: '1' }, text: '× Limpar todos os filtros' })
        ])
      );
    }
  }

  function onDrawerClick(e) {
    var t = e.target;
    var btn = t && t.closest ? t.closest('button') : null;
    if (!btn) return;
    var d = btn.dataset || {};
    if (d.star !== undefined) {
      S.toggleFavorite(d.star);
      renderDrawer();
      if (ui.tab === 'spaces') renderTable();
      return;
    }
    if (d.pick !== undefined) {
      app.select(d.pick);
      return;
    }
    if (d.tractor !== undefined) {
      var sum = app.summary();
      app.select(sum.space.id, d.tractor);
      return;
    }
    if (d.more) {
      ui.showAll = true;
      renderDrawer();
      return;
    }
    if (d.clearfilters) {
      ui.groups = [];
      ui.favOnly = false;
      ui.showAll = false;
      if (ui.filterOpen) renderFilterPopup();
      renderDrawer();
    }
  }

  function onFilterClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-group]') : null;
    if (!btn) return;
    var g = btn.dataset.group;
    var at = ui.groups.indexOf(g);
    if (at >= 0) ui.groups.splice(at, 1);
    else ui.groups.push(g);
    ui.showAll = false;
    renderFilterPopup();
    renderDrawer();
  }

  /* ------------------------------------------------------------------ tabs --- */
  function showTab(tab) {
    ui.tab = tab;
    Array.prototype.forEach.call(el.tabs, function (b) {
      var on = b.dataset.tab === tab;
      b.classList[on ? 'add' : 'remove']('on');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (el.workspace) el.workspace.hidden = tab !== 'plan';
    if (el.view) el.view.hidden = tab !== 'spaces';
    if (app) app.closeMenu();
    if (tab === 'spaces') {
      setDrawer(false);
      renderTable();
    } else if (app) {
      /* the canvas had no size while hidden */
      app.refresh();
    }
  }

  /* ----------------------------------------------------------------- table --- */
  function tableFilters() {
    return {
      fav: el.fFav ? el.fFav.value : '',
      name: el.fName ? fold(el.fName.value.trim()) : '',
      type: el.fType ? el.fType.value : '',
      origin: el.fOrigin ? el.fOrigin.value : '',
      created: el.fCreated ? el.fCreated.value : ''
    };
  }

  var SORTERS = {
    name: function (s) { return fold(s.name); },
    type: function (s) { return fold((S.typeOf(s.type) || {}).label); },
    l: function (s) { return s.l; },
    w: function (s) { return s.w; },
    h: function (s) { return s.h; },
    payload: function (s) { return s.payload; },
    origin: function (s) { return s.origin; },
    created: function (s) { return s.created; }
  };

  function tableRows() {
    var f = tableFilters();
    var rows = S.all().filter(function (s) {
      if (f.fav === 'yes' && !S.isFavorite(s.id)) return false;
      if (f.fav === 'no' && S.isFavorite(s.id)) return false;
      if (f.name && fold(s.name).indexOf(f.name) < 0) return false;
      if (f.type && s.type !== f.type) return false;
      if (f.origin && s.origin !== f.origin) return false;
      if (f.created && s.created !== f.created) return false;
      return true;
    });
    var key = SORTERS[ui.table.sort] || SORTERS.name;
    var dir = ui.table.dir;
    rows.sort(function (a, b) {
      var ka = key(a);
      var kb = key(b);
      if (ka < kb) return -dir;
      if (ka > kb) return dir;
      return fold(a.name) < fold(b.name) ? -1 : 1;
    });
    return rows;
  }

  function renderTable() {
    if (!el.tbody) return;
    var rows = tableRows();
    var pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    ui.table.page = Math.min(Math.max(1, ui.table.page), pages);
    var start = (ui.table.page - 1) * PAGE_SIZE;
    var slice = rows.slice(start, start + PAGE_SIZE);
    var current = app ? app.summary() : null;

    clear(el.tbody);
    if (!slice.length) {
      el.tbody.appendChild(h('tr', null, [h('td', { colspan: '10', class: 'table-empty', text: 'Nenhum espaço de carga com estes filtros.' })]));
    }
    slice.forEach(function (s) {
      var t = S.typeOf(s.type);
      var fav = S.isFavorite(s.id);
      var tractor = S.isTractor(s);
      var inUse = current && (current.space.id === s.id || (current.tractor && current.tractor.id === s.id));
      var mm = function (v) {
        return tractor ? '—' : fmt(v);
      };
      el.tbody.appendChild(
        h('tr', { class: inUse ? 'in-use' : null }, [
          h('td', { class: 'c-fav' }, [
            h('button', {
              type: 'button',
              class: 'star' + (fav ? ' on' : ''),
              'aria-pressed': fav ? 'true' : 'false',
              'aria-label': (fav ? 'Tirar ' : 'Marcar ') + s.name + (fav ? ' dos favoritos' : ' como favorito'),
              data: { star: s.id },
              html: fav ? STAR : STAR_LINE
            })
          ]),
          h('td', { class: 'c-name' }, [
            h('span', { text: s.name }),
            inUse ? h('span', { class: 'tag', text: 'em uso' }) : null
          ]),
          h('td', { class: 'c-type', title: t ? t.label : '' }, [
            h('span', { class: 'type-icon', html: iconSvg(shapeFor(s.type)) }),
            h('span', { class: 'sr-only', text: t ? t.label : '' })
          ]),
          h('td', { class: 'num', text: mm(s.l) }),
          h('td', { class: 'num', text: mm(s.w) }),
          h('td', { class: 'num', text: mm(s.h) }),
          h('td', { class: 'num', text: fmt(s.payload) + ' kg' }),
          h('td', { class: 'c-origin', text: s.origin === 'system' ? (s.edited ? 'Padrão (editado)' : 'Padrão') : 'Personalizado' }),
          h('td', { class: 'c-date', text: dateText(s.created) }),
          h('td', { class: 'c-actions' }, [
            h('button', {
              type: 'button',
              class: 'icon-btn small',
              'aria-label': 'Editar ' + s.name,
              title: 'Editar',
              data: { edit: s.id },
              text: '✎'
            }),
            s.origin === 'custom'
              ? h('button', {
                type: 'button',
                class: 'icon-btn small danger',
                'aria-label': 'Excluir ' + s.name,
                title: 'Excluir',
                data: { del: s.id },
                text: '✕'
              })
              : null
          ])
        ])
      );
    });

    /* pages: "Página 1 de 3 (43 no total)  ‹ 1 2 3 ›" */
    clear(el.pager);
    el.pager.appendChild(h('span', { class: 'pager-text', text: 'Página ' + ui.table.page + ' de ' + pages + ' (' + rows.length + ' no total)' }));
    el.pager.appendChild(h('button', { type: 'button', class: 'page-btn', 'aria-label': 'Página anterior', disabled: ui.table.page <= 1, data: { page: String(ui.table.page - 1) }, text: '‹' }));
    for (var p = 1; p <= pages; p++) {
      el.pager.appendChild(h('button', {
        type: 'button',
        class: 'page-btn' + (p === ui.table.page ? ' on' : ''),
        'aria-current': p === ui.table.page ? 'page' : null,
        data: { page: String(p) },
        text: String(p)
      }));
    }
    el.pager.appendChild(h('button', { type: 'button', class: 'page-btn', 'aria-label': 'Página seguinte', disabled: ui.table.page >= pages, data: { page: String(ui.table.page + 1) }, text: '›' }));

    Array.prototype.forEach.call(el.sortBtns, function (b) {
      var on = b.dataset.sort === ui.table.sort;
      var th = b.parentNode;
      if (th && th.setAttribute) th.setAttribute('aria-sort', on ? (ui.table.dir > 0 ? 'ascending' : 'descending') : 'none');
      b.dataset.dir = on ? (ui.table.dir > 0 ? 'asc' : 'desc') : '';
    });

    el.notice.textContent = ui.notice;
    el.notice.hidden = !ui.notice;
  }

  function onTableClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn) return;
    var d = btn.dataset || {};
    if (d.star !== undefined) {
      S.toggleFavorite(d.star);
      renderTable();
      if (ui.drawerOpen) renderDrawer();
    } else if (d.edit !== undefined) {
      var s = S.get(d.edit);
      if (s) openForm(s);
    } else if (d.del !== undefined) {
      var target = S.get(d.del);
      if (!target) return;
      var ok = typeof window.confirm === 'function' ? window.confirm('Excluir o espaço de carga "' + target.name + '"?') : true;
      if (!ok) return;
      S.remove(target.id);
      if (ui.form && ui.form.editing === target.id) closeForm();
      ui.notice = '"' + target.name + '" foi apagado.';
      app.refresh();
      renderTable();
    }
  }

  function onPagerClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-page]') : null;
    if (!btn || btn.disabled) return;
    ui.table.page = parseInt(btn.dataset.page, 10) || 1;
    renderTable();
  }

  function onSortClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-sort]') : null;
    if (!btn) return;
    var key = btn.dataset.sort;
    if (ui.table.sort === key) ui.table.dir = -ui.table.dir;
    else {
      ui.table.sort = key;
      ui.table.dir = 1;
    }
    renderTable();
  }

  function onFilterInput() {
    ui.table.page = 1;
    ui.notice = '';
    renderTable();
  }

  /* ------------------------------------------------------------------ form --- */
  /* Example values for the placeholders: a built-in space of the same type,
     or of the same kind. */
  function sampleFor(typeId) {
    var t = S.typeOf(typeId);
    var list = S.all().filter(function (s) {
      return s.origin === 'system';
    });
    var same = list.filter(function (s) {
      return s.type === typeId;
    })[0];
    if (same) return same;
    var kin = list.filter(function (s) {
      var k = S.typeOf(s.type);
      return k && t && k.kind === t.kind;
    })[0];
    return kin || null;
  }

  function openForm(space) {
    ui.notice = '';
    ui.form = {
      space: space ? JSON.parse(JSON.stringify(space)) : S.blank('semi3'),
      editing: space ? space.id : '',
      edited: !!(space && space.edited),
      errors: []
    };
    if (ui.tab !== 'spaces') showTab('spaces');
    renderForm();
    el.formWrap.hidden = false;
    /* the form sits at the top of the tab: scroll that pane only (scrollIntoView
       would also scroll the page under the fixed layout) */
    if (el.view) el.view.scrollTop = 0;
    var first = el.formWrap.querySelector('[name="name"]');
    if (first && first.focus) first.focus();
  }

  function closeForm() {
    ui.form = null;
    if (el.formWrap) {
      el.formWrap.hidden = true;
      clear(el.formWrap);
    }
  }

  function numberField(name, label, unit, value, opts) {
    opts = opts || {};
    var id = 'sf-' + name.replace('.', '-');
    var input = h('input', {
      id: id,
      name: name,
      type: 'number',
      inputmode: 'numeric',
      placeholder: (typeof opts.placeholder === 'number' && isFinite(opts.placeholder)) ||
        (typeof opts.placeholder === 'string' && opts.placeholder)
        ? String(opts.placeholder)
        : null,
      step: opts.step || '1',
      'aria-describedby': opts.help ? id + '-help' : null
    });
    input.value = typeof value === 'number' && isFinite(value) ? String(value) : '';
    return h('div', { class: 'sf-field' + (opts.wide ? ' wide' : '') }, [
      h('label', { for: id, text: label }),
      h('span', { class: 'sf-input' }, [input, h('span', { class: 'unit', text: unit })]),
      opts.help ? h('span', { class: 'sf-help', id: id + '-help', text: opts.help }) : null
    ]);
  }

  function renderForm() {
    var f = ui.form;
    if (!f || !el.formWrap) return;
    var s = f.space;
    var t = S.typeOf(s.type);
    var tractor = t.kind === 'tractor';
    var sample = sampleFor(s.type) || {};
    var sampleAxles = sample.axles || [];

    clear(el.formWrap);

    var typeSelect = h('select', { id: 'sf-type', name: 'type' });
    S.GROUPS.concat([{ id: 'tractor', label: 'Cavalos mecânicos' }]).forEach(function (g) {
      var og = h('optgroup', { label: g.label });
      S.TYPES.forEach(function (tp) {
        if (tp.group === g.id) og.appendChild(h('option', { value: tp.id, text: tp.label }));
      });
      typeSelect.appendChild(og);
    });
    typeSelect.value = s.type;

    var nameInput = h('input', { id: 'sf-name', name: 'name', type: 'text', maxlength: '40', autocomplete: 'off', placeholder: sample.name || '' });
    nameInput.value = s.name || '';

    var dims = tractor
      ? null
      : h('div', { class: 'sf-row' }, [
        numberField('l', 'Comprimento (L)', 'mm', s.l, { placeholder: sample.l }),
        numberField('w', 'Largura', 'mm', s.w, { placeholder: sample.w }),
        numberField('h', 'Altura (H)', 'mm', s.h, { placeholder: sample.h })
      ]);

    var loadRow = h('div', { class: 'sf-row' }, [
      numberField('payload', tractor ? 'Carga máx. no prato' : 'Carga máx. do espaço', 'kg', s.payload, { placeholder: sample.payload }),
      t.supports ? numberField('track', 'Bitola', 'mm', s.track, { placeholder: sample.track, help: 'Distância entre os centros das rodas de um eixo.' }) : null
    ]);

    /* optional limits: the axle groups (when a group has more than one axle)
       and the gross weight of the vehicle or combination */
    var groups = S.groupsOf(s.type);
    var opt = function (v) {
      return typeof v === 'number' && isFinite(v) ? v : 'opcional';
    };
    var limitFields = [];
    if (groups.front.length > 1) {
      limitFields.push(numberField('frontMax', 'Carga máx. do conjunto dianteiro', 'kg', s.frontMax, { placeholder: opt(sample.frontMax) }));
    }
    if (groups.rear.length > 1) {
      limitFields.push(numberField('rearMax', 'Carga máx. do conjunto traseiro', 'kg', s.rearMax, { placeholder: opt(sample.rearMax) }));
    }
    if (t.kind !== 'box') {
      limitFields.push(numberField('gross',
        tractor ? 'CMT / PBTC máx.' : t.kind === 'semi' ? 'PBTC máx. (com o cavalo)' : 'Peso bruto máx. (PBT)', 'kg', s.gross,
        { placeholder: opt(sample.gross), help: 'Carga + taras de todos os eixos na estrada. Vazio = sem limite.' }));
    }
    var limitsRow = limitFields.length ? h('div', { class: 'sf-row' }, limitFields) : null;

    var rs = S.roles(s.type);
    var axleSets = rs.map(function (r, i) {
      var a = s.axles[i] || {};
      var sa = sampleAxles[i] || {};
      var inGroup = (i < t.front ? groups.front : groups.rear).length > 1;
      return h('fieldset', { class: 'sf-axle' }, [
        h('legend', { text: 'Eixo ' + r.letter + ' — ' + r.label }),
        numberField('axle' + i + '.dist', 'Distância', 'mm', a.dist, { placeholder: sa.dist }),
        numberField('axle' + i + '.tare', 'Tara', 'kg', a.tare, { placeholder: sa.tare }),
        numberField('axle' + i + '.max', 'Carga máx.', 'kg', a.max, { placeholder: sa.max }),
        /* kᵢ: how the group's load splits among its axles; blank = equal */
        inGroup ? numberField('axle' + i + '.share', 'Repartição no conjunto', '%', a.share, { placeholder: 'igual', step: '0.1' }) : null
      ]);
    });

    /* How to measure the axle distances: the reference (0), the sign, and an
       example, shown just above the axle fields. */
    var reference = tractor
      ? ['Medir a partir do prato (pino-rei), que é o 0.',
        'À frente do prato a distância é negativa, atrás é positiva. Exemplo: eixo dianteiro 3 600 mm à frente do prato → -3600; eixo motriz 550 mm atrás → 550.']
      : t.kind === 'box'
        ? ['Um contêiner não tem eixos próprios: as cargas por eixo são calculadas em um caminhão ou semirreboque.']
        : t.kind === 'semi'
          ? ['Medir a partir da parede da frente do espaço de carga, que é o 0. Todas as distâncias são positivas.',
            'Exemplo: pino-rei 1 675 mm atrás da parede da frente → 1675; primeiro eixo a 7 985 mm → 7985.']
          : t.kind === 'trailer'
            ? ['Medir a partir da parede da frente do espaço de carga, que é o 0. Todas as distâncias são positivas.',
              'Exemplo: eixo dianteiro (no giro) 1 300 mm atrás da parede da frente → 1300; eixo traseiro a 6 200 mm → 6200.']
            : ['Medir a partir da parede da frente do espaço de carga (o baú), que é o 0.',
              'O eixo dianteiro, sob a cabine, fica à frente do baú: distância negativa. Os traseiros ficam sob o baú: positiva. Exemplo: eixo dianteiro 1 300 mm à frente do baú → -1300; eixo traseiro a 5 000 mm → 5000.'];

    var form = h('form', { class: 'space-form', novalidate: true, 'aria-labelledby': 'sf-title' }, [
      h('div', { class: 'sf-head' }, [
        h('h2', { id: 'sf-title', text: f.editing ? 'Editar espaço de carga' : 'Novo espaço de carga personalizado' })
      ]),
      h('div', { class: 'sf-body' }, [
        h('div', { class: 'sf-diagram', id: 'sf-diagram' }),
        h('div', { class: 'sf-fields' }, [
          h('div', { class: 'sf-row' }, [
            h('div', { class: 'sf-field wide' }, [h('label', { for: 'sf-name', text: 'Nome' }), nameInput]),
            h('div', { class: 'sf-field wide' }, [h('label', { for: 'sf-type', text: 'Tipo' }), typeSelect])
          ]),
          dims,
          loadRow,
          limitsRow,
          tractor ? null : h('p', { class: 'sf-note', text: 'Use as dimensões internas do espaço de carga, não as externas: um erro nas medidas muda todo o cálculo.' }),
          h('div', { class: 'sf-ref' }, reference.map(function (line, i) {
            return h('p', { class: i ? '' : 'sf-ref-head', text: line });
          })),
          axleSets.length ? h('div', { class: 'sf-axles' }, axleSets) : null
        ])
      ]),
      h('ul', { class: 'sf-errors', id: 'sf-errors', role: 'alert' }),
      h('div', { class: 'sf-actions' }, [
        h('button', { type: 'submit', class: 'btn primary', text: 'Salvar' }),
        h('button', { type: 'button', class: 'btn line', data: { cancel: '1' }, text: 'Cancelar' }),
        f.editing && f.edited ? h('button', { type: 'button', class: 'btn line', data: { reset: '1' }, text: 'Restaurar valores padrão' }) : null
      ])
    ]);

    form.addEventListener('input', onFormInput);
    form.addEventListener('change', onFormChange);
    form.addEventListener('submit', onFormSubmit);
    form.addEventListener('click', onFormClick);
    el.formWrap.appendChild(form);
    renderErrors();
    drawDiagram();
  }

  function readNumber(form, name) {
    var input = form.querySelector('[name="' + name + '"]');
    if (!input) return NaN;
    var v = String(input.value).trim();
    return v === '' ? NaN : Number(v);
  }

  function readForm(form) {
    var s = ui.form.space;
    var nameInput = form.querySelector('[name="name"]');
    s.name = nameInput ? nameInput.value : s.name;
    ['l', 'w', 'h', 'payload', 'track', 'frontMax', 'rearMax', 'gross'].forEach(function (k) {
      if (form.querySelector('[name="' + k + '"]')) s[k] = readNumber(form, k);
    });
    s.axles.forEach(function (a, i) {
      a.dist = readNumber(form, 'axle' + i + '.dist');
      a.tare = readNumber(form, 'axle' + i + '.tare');
      a.max = readNumber(form, 'axle' + i + '.max');
      a.share = readNumber(form, 'axle' + i + '.share');
    });
  }

  function onFormInput(e) {
    var form = e.currentTarget;
    if (e.target && e.target.name === 'type') return;
    readForm(form);
    drawDiagram();
  }

  function onFormChange(e) {
    if (!e.target || e.target.name !== 'type') return;
    readForm(e.currentTarget);
    ui.form.space = S.retype(ui.form.space, e.target.value);
    ui.form.errors = [];
    renderForm();
    var sel = el.formWrap.querySelector('[name="type"]');
    if (sel && sel.focus) sel.focus();
  }

  function onFormClick(e) {
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn) return;
    if (btn.dataset.cancel) {
      closeForm();
    } else if (btn.dataset.reset) {
      var id = ui.form.editing;
      S.reset(id);
      ui.notice = 'Os valores padrão de "' + (S.get(id) || {}).name + '" foram restaurados.';
      closeForm();
      app.refresh();
      renderTable();
    }
  }

  function onFormSubmit(e) {
    e.preventDefault();
    var form = e.currentTarget;
    readForm(form);
    var s = ui.form.space;
    s.id = ui.form.editing;
    var result = S.save(s);
    if (!result.ok) {
      ui.form.errors = result.errors;
      renderErrors();
      var bad = result.errors[0] && form.querySelector('[name="' + result.errors[0].field + '"]');
      if (bad && bad.focus) bad.focus();
      return;
    }
    ui.notice = (ui.form.editing ? 'Alterações salvas em "' : 'Espaço de carga criado: "') + result.space.name +
      '". Selecione-o na lista de espaços do plano de carga.';
    closeForm();
    app.refresh();
    renderTable();
  }

  function renderErrors() {
    var list = el.formWrap && el.formWrap.querySelector('#sf-errors');
    if (!list) return;
    clear(list);
    var errs = ui.form ? ui.form.errors : [];
    var bad = {};
    errs.forEach(function (er) {
      bad[er.field] = true;
      list.appendChild(h('li', { text: er.message }));
    });
    list.hidden = !errs.length;
    Array.prototype.forEach.call(el.formWrap.querySelectorAll('input, select'), function (inp) {
      if (bad[inp.name]) inp.setAttribute('aria-invalid', 'true');
      else inp.removeAttribute('aria-invalid');
    });
  }

  /* --------------------------------------------------------------- diagram --- */
  /* The form shows the space being made as the plan shows it: the same 3D
     vehicle, seen from the side to scale (SyncrofinScene.side), with the
     dimension lines of the form over it. Without WebGL it falls back to a
     flat sketch with the same lines. Redrawn as the user types, a moment
     after the last key so typing stays quick. */
  var diagramTimer = null;

  function drawDiagram() {
    var box = el.formWrap && el.formWrap.querySelector('#sf-diagram');
    if (!box || !ui.form) return;
    var scene = window.SyncrofinScene;
    if (!scene || !scene.active || !scene.side) {
      drawSketch();
      return;
    }
    if (diagramTimer) clearTimeout(diagramTimer);
    if (!box.firstChild) {
      drawModel();
      return;
    }
    diagramTimer = setTimeout(function () {
      diagramTimer = null;
      drawModel();
    }, 90);
  }

  /* The space as typed so far, with the gaps filled from the example space
     (or from plain defaults) so there is always a vehicle to draw. */
  function previewSpace() {
    var s = ui.form.space;
    var t = S.typeOf(s.type);
    var sample = sampleFor(s.type) || {};
    var tractor = t.kind === 'tractor';
    var pick = function (v, fallback) {
      return isFinite(v) && v > 0 ? v : fallback;
    };
    var L = tractor ? 0 : pick(s.l, sample.l || 13600);
    var front = t.front;
    var rear = t.supports - front;
    var axles = (s.axles || []).map(function (a, i) {
      var d = isFinite(a.dist) ? a.dist : sample.axles && sample.axles[i] && isFinite(sample.axles[i].dist) ? sample.axles[i].dist : NaN;
      if (isFinite(d)) return { dist: d, tare: 0, max: 1 };
      /* nothing typed and no example: an ordinary position for this support */
      var j = i - front; /* place inside the rear group */
      if (t.kind === 'semi') d = i === 0 ? 1700 : L - 1500 - (rear - 1 - j) * 1310;
      else if (t.kind === 'tractor') d = i < front ? -3600 + i * 1400 : 300 + j * 1350;
      else if (t.kind === 'trailer') d = i < front ? 1200 + i * 1350 : L - 1000 - (rear - 1 - j) * 1350;
      else d = i < front ? -1400 - (front - 1 - i) * 1350 : L - 1500 - (rear - 1 - j) * 1350;
      return { dist: d, tare: 0, max: 1 };
    });
    return {
      type: s.type,
      l: L,
      w: tractor ? 0 : pick(s.w, sample.w || 2480),
      h: tractor ? 0 : pick(s.h, sample.h || 2700),
      payload: 1,
      track: t.supports ? pick(s.track, sample.track || 2050) : 0,
      axles: axles
    };
  }

  function drawModel() {
    var box = el.formWrap && el.formWrap.querySelector('#sf-diagram');
    if (!box || !ui.form) return;
    var sp = previewSpace();
    var t = S.typeOf(sp.type);
    var tractor = t.kind === 'tractor';
    var VW = 640;
    var pad = 34;
    var room = 30; /* for the H line on the right */
    var view = null;
    try {
      view = window.SyncrofinScene.side(sp, VW - 2 * pad - room, 210);
    } catch (e) {
      view = null;
    }
    if (!view) {
      drawSketch();
      return;
    }
    /* Problems with the measurements so far (an axle where it cannot be, a
       size out of range), checked as the user types rather than on saving:
       the axle turns red in the drawing and the reason shows under it. */
    var probe = S.clean({ type: sp.type, name: '-', l: sp.l, w: sp.w, h: sp.h, payload: 1, track: sp.track, axles: sp.axles });
    var problems = probe ? S.validate(probe).filter(function (er) {
      return /^(l|w|h|track|axle\d+\.dist)$/.test(er.field);
    }) : [];
    var badAxle = {};
    problems.forEach(function (er) {
      var m = /^axle(\d+)\.dist$/.exec(er.field);
      if (m) badAxle[m[1]] = true;
    });
    var red = '#c0362c';

    var sc = view.pxPerMm;
    var offX = pad + Math.max(0, (VW - 2 * pad - room - view.width) / 2);
    var X = function (mm) {
      return offX + (mm - view.minX) * sc;
    };
    var imgTop = 38;
    var ground = imgTop + view.heightPx;
    var floor = ground - view.deck * sc;
    var cargoTop = floor - sp.h * sc;
    var wheelY = ground - 500 * sc;
    var rows = sp.axles.length;
    var base = ground + 18;
    var legendY = base + rows * 22 + 8;
    var VH = Math.round(legendY + 14);
    var ink = '#2f3337';
    var out = [];

    out.push('<svg viewBox="0 0 ' + VW + ' ' + VH + '" role="img" aria-label="Vista lateral do veículo com as medidas do espaço de carga" xmlns="http://www.w3.org/2000/svg">');
    out.push('<defs><marker id="sf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0 0L10 5L0 10z" fill="' + ink + '"/></marker></defs>');
    out.push('<line x1="' + pad + '" y1="' + ground.toFixed(1) + '" x2="' + (VW - pad) + '" y2="' + ground.toFixed(1) + '" stroke="#c3c8ce" stroke-width="1.5"/>');
    out.push('<image href="' + view.url + '" x="' + offX.toFixed(1) + '" y="' + imgTop + '" width="' + view.width + '" height="' + view.heightPx + '"/>');

    out.push('<defs><marker id="sf-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0 0L10 5L0 10z" fill="' + red + '"/></marker></defs>');

    function text(x, y, label, anchor, colour) {
      out.push('<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="' + (anchor || 'middle') + '" font-size="15" font-weight="700" fill="' + (colour || ink) +
        '" stroke="#fff" stroke-width="4" stroke-linejoin="round" paint-order="stroke">' + label + '</text>');
    }
    function arrowLine(x1, y1, x2, y2, colour) {
      out.push('<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + (colour || ink) +
        '" stroke-width="1.2" marker-start="url(#' + (colour ? 'sf-arrow-bad' : 'sf-arrow') + ')" marker-end="url(#' + (colour ? 'sf-arrow-bad' : 'sf-arrow') + ')"/>');
    }
    function tick(x, y1, y2, colour) {
      out.push('<line x1="' + x.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + (colour || ink) + '" stroke-width="1" stroke-dasharray="3 2"/>');
    }

    if (!tractor) {
      var ly = Math.max(16, cargoTop - 12);
      tick(X(0), ly - 6, floor);
      tick(X(sp.l), ly - 6, floor);
      arrowLine(X(0), ly, X(sp.l), ly);
      text((X(0) + X(sp.l)) / 2, ly - 5, 'L');
      var hx = X(sp.l) + 14;
      arrowLine(hx, cargoTop, hx, floor);
      text(hx + 6, (cargoTop + floor) / 2 + 5, 'H', 'start');
    } else {
      text(X(0), floor - 10, 'prato');
    }

    var rs = S.roles(sp.type);
    sp.axles.forEach(function (a, i) {
      var y = base + i * 22;
      var x = X(a.dist);
      var colour = badAxle[i] ? red : null;
      var kingpin = rs[i].role === 'kingpin';
      tick(X(0), floor, y + 4);
      tick(x, kingpin ? floor : wheelY, y + 4, colour);
      if (Math.abs(x - X(0)) >= 2) arrowLine(X(0), y, x, y, colour);
      /* the label sits over its line, or beside it when the line is too short */
      var label = S.LETTERS[i] + ' = ' + signed(a.dist);
      var labelW = label.length * 8.6;
      var lo = Math.min(x, X(0));
      var hi = Math.max(x, X(0));
      if (hi - lo >= labelW + 10) text((lo + hi) / 2, y - 4, label, null, colour);
      else if (lo - labelW - 8 >= 4) text(lo - 6, y + 5, label, 'end', colour);
      else text(hi + 6, y + 5, label, 'start', colour);
      if (colour) {
        /* ring the wheel (or the kingpin) that is out of place */
        out.push('<circle cx="' + x.toFixed(1) + '" cy="' + (kingpin ? floor : wheelY).toFixed(1) + '" r="' + (kingpin ? 8 : 500 * sc + 5).toFixed(1) +
          '" fill="none" stroke="' + red + '" stroke-width="2" stroke-dasharray="4 3"/>');
      }
    });

    /* where 0 is, and which side of it is negative */
    var zeroLabel = tractor ? '0 = prato' : '0 = parede da frente';
    var x0 = X(0);
    tick(x0, floor, legendY - 4);
    out.push('<circle cx="' + x0.toFixed(1) + '" cy="' + (legendY - 4) + '" r="3" fill="' + ink + '"/>');
    var small = function (x, label, anchor) {
      out.push('<text x="' + x.toFixed(1) + '" y="' + legendY + '" text-anchor="' + anchor + '" font-size="12.5" fill="' + ink + '">' + label + '</text>');
    };
    if (t.kind === 'lorry' || tractor) {
      small(x0 - 8, '← negativo', 'end');
      small(x0 + 8, zeroLabel + ' · positivo →', 'start');
    } else {
      small(x0 + 8, zeroLabel + ' · tudo positivo →', 'start');
    }

    out.push('</svg>');
    var warn = problems.length
      ? '<ul class="sf-diagram-warn" role="status">' + problems.map(function (er) {
        return '<li>' + escapeHtml(er.message) + '</li>';
      }).join('') + '</ul>'
      : '<ul class="sf-diagram-warn" role="status" hidden></ul>';
    box.innerHTML = out.join('') + warn;
  }

  /* A distance with its sign, as typed: −3 600, 1 675. */
  function signed(n) {
    if (!isFinite(n)) return '?';
    return (n < 0 ? '−' : '') + fmt(Math.abs(Math.round(n)));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* The flat sketch, for a browser without WebGL. */
  function drawSketch() {
    var box = el.formWrap && el.formWrap.querySelector('#sf-diagram');
    if (!box || !ui.form) return;
    var s = ui.form.space;
    var t = S.typeOf(s.type);
    var tractor = t.kind === 'tractor';
    var sample = sampleFor(s.type) || {};
    var L = s.l > 0 ? s.l : sample.l || 13600;
    var H = s.h > 0 ? s.h : sample.h || 2700;
    var axles = (s.axles || []).map(function (a, i) {
      var d = isFinite(a.dist) ? a.dist : sample.axles && sample.axles[i] ? sample.axles[i].dist : NaN;
      return d;
    });
    if (tractor) {
      L = 0;
      H = 0;
    }

    var wheelR = 480;
    var cab = t.kind === 'lorry' || tractor;
    var minX = 0;
    var maxX = L;
    axles.forEach(function (d) {
      if (isFinite(d)) {
        minX = Math.min(minX, d - wheelR);
        maxX = Math.max(maxX, d + wheelR);
      }
    });
    var cabFront = 0;
    if (cab) {
      var front = isFinite(axles[0]) ? axles[0] : -1400;
      cabFront = Math.min(front - 1300, tractor ? front - 1300 : -2200);
      minX = Math.min(minX, cabFront);
      if (tractor) maxX = Math.max(maxX, (isFinite(axles[axles.length - 1]) ? axles[axles.length - 1] : 600) + 900);
    }
    if (t.kind === 'trailer') minX = Math.min(minX, (isFinite(axles[0]) ? axles[0] : 1300) - 2400);
    if (tractor) H = 3000; /* cab height, for the drawing only */

    var VW = 640;
    var pad = 34;
    var sc = (VW - 2 * pad) / Math.max(1, maxX - minX);
    var bodyH = Math.min(H * sc, 150);
    var rows = axles.length;
    var top = 34;
    var floor = top + bodyH;
    var VH = Math.round(floor + wheelR * 2 * sc + 18 + rows * 22 + 16);
    var X = function (mm) {
      return pad + (mm - minX) * sc;
    };
    var r = Math.max(6, wheelR * sc);
    var out = [];
    var ink = '#2f3337';
    var line = '#5c5b5b';

    out.push('<svg viewBox="0 0 ' + VW + ' ' + VH + '" role="img" aria-label="Esquema lateral com as medidas do espaço de carga" xmlns="http://www.w3.org/2000/svg">');
    out.push('<defs><marker id="sf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0 0L10 5L0 10z" fill="' + ink + '"/></marker></defs>');

    function dimLine(x1, x2, y, label) {
      if (!isFinite(x1) || !isFinite(x2) || Math.abs(x2 - x1) < 2) return;
      out.push('<line x1="' + x1.toFixed(1) + '" y1="' + y + '" x2="' + x2.toFixed(1) + '" y2="' + y + '" stroke="' + ink +
        '" stroke-width="1.2" marker-start="url(#sf-arrow)" marker-end="url(#sf-arrow)"/>');
      out.push('<text x="' + ((x1 + x2) / 2).toFixed(1) + '" y="' + (y - 5) + '" text-anchor="middle" font-size="15" font-weight="700" fill="' + ink + '">' + label + '</text>');
    }
    function tick(x, y1, y2) {
      out.push('<line x1="' + x.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + ink + '" stroke-width="1"/>');
    }

    /* body */
    if (!tractor) {
      if (/^flatbed/.test(t.id)) {
        out.push('<rect x="' + X(0) + '" y="' + (floor - 10) + '" width="' + (L * sc) + '" height="10" fill="#cfd4d9" stroke="' + line + '"/>');
        out.push('<rect x="' + X(0) + '" y="' + top + '" width="' + (L * sc) + '" height="' + (bodyH - 10) +
          '" fill="none" stroke="' + line + '" stroke-dasharray="5 4"/>');
      } else {
        out.push('<rect x="' + X(0) + '" y="' + top + '" width="' + (L * sc) + '" height="' + bodyH + '" fill="#e9edf1" stroke="' + line + '" stroke-width="1.5"/>');
        if (t.kind === 'box' || t.kind === 'semi' || t.kind === 'trailer') {
          for (var gx = 600; gx < L; gx += 600) {
            out.push('<line x1="' + X(gx) + '" y1="' + (top + 3) + '" x2="' + X(gx) + '" y2="' + (floor - 3) + '" stroke="#cfd4d9"/>');
          }
        }
      }
    }

    /* cab and chassis */
    if (cab) {
      var cabRear = tractor ? (isFinite(axles[0]) ? axles[0] : -3600) + 1500 : -200;
      var cabTop = floor - Math.min(bodyH, 2900 * sc);
      out.push('<path d="M' + X(cabFront) + ' ' + floor + 'V' + (cabTop + 14) + 'L' + (X(cabFront) + 14) + ' ' + cabTop + 'H' + X(cabRear) + 'V' + floor +
        'Z" fill="#d5dbe0" stroke="' + line + '" stroke-width="1.5"/>');
      out.push('<rect x="' + (X(cabFront) + 6) + '" y="' + (cabTop + 12) + '" width="' + Math.max(8, (cabRear - cabFront) * sc * 0.45) + '" height="' +
        Math.max(8, (floor - cabTop) * 0.3) + '" fill="#fff" stroke="' + line + '"/>');
      var chassisEnd = tractor ? maxX - 300 : L;
      out.push('<rect x="' + X(cabFront) + '" y="' + floor + '" width="' + (X(chassisEnd) - X(cabFront)) + '" height="6" fill="' + line + '"/>');
      if (tractor) {
        out.push('<rect x="' + (X(0) - 22) + '" y="' + (floor - 7) + '" width="44" height="7" fill="' + line + '"/>');
        out.push('<text x="' + X(0) + '" y="' + (floor - 12) + '" text-anchor="middle" font-size="13" fill="' + ink + '">prato</text>');
      }
    }
    if (t.kind === 'trailer') {
      var f0 = isFinite(axles[0]) ? axles[0] : 1300;
      out.push('<line x1="' + X(f0 - 2300) + '" y1="' + (floor + 10) + '" x2="' + X(f0) + '" y2="' + (floor + 4) + '" stroke="' + line + '" stroke-width="4"/>');
    }

    /* supports */
    var wheelY = floor + r + 4;
    var rs = S.roles(s.type);
    axles.forEach(function (d, i) {
      if (!isFinite(d)) return;
      if (rs[i].role === 'kingpin') {
        out.push('<rect x="' + (X(d) - 3) + '" y="' + floor + '" width="6" height="' + Math.max(10, r) + '" fill="' + line + '"/>');
        out.push('<rect x="' + (X(d) + 40) + '" y="' + floor + '" width="5" height="' + (r * 1.8) + '" fill="#8b9096"/>');
      } else {
        out.push('<circle cx="' + X(d) + '" cy="' + wheelY + '" r="' + r + '" fill="#2f3337"/>');
        out.push('<circle cx="' + X(d) + '" cy="' + wheelY + '" r="' + (r * 0.45) + '" fill="#bfc1c5"/>');
      }
    });

    /* dimension lines */
    if (!tractor) {
      dimLine(X(0), X(L), top - 12, 'L');
      tick(X(0), top - 18, top);
      tick(X(L), top - 18, top);
      var hx = X(L) + 14;
      out.push('<line x1="' + hx + '" y1="' + top + '" x2="' + hx + '" y2="' + floor + '" stroke="' + ink + '" stroke-width="1.2" marker-start="url(#sf-arrow)" marker-end="url(#sf-arrow)"/>');
      out.push('<text x="' + (hx + 8) + '" y="' + ((top + floor) / 2 + 5) + '" font-size="15" font-weight="700" fill="' + ink + '">H</text>');
    }
    var base = wheelY + r + 16;
    axles.forEach(function (d, i) {
      if (!isFinite(d)) return;
      var y = base + i * 22;
      tick(X(0), floor, y + 4);
      tick(X(d), rs[i].role === 'kingpin' ? floor : wheelY, y + 4);
      dimLine(X(0), X(d), y, S.LETTERS[i]);
    });

    out.push('</svg>');
    box.innerHTML = out.join('');
  }

  /* ----------------------------------------------------------------- mount --- */
  function cache() {
    el.card = $('#space-card');
    el.cardOpen = $('#space-open');
    el.cardTitle = $('#space-title');
    el.cardSub = $('#space-sub');
    el.cardStats = $('#space-stats');
    el.drawer = $('#space-drawer');
    el.list = $('#space-list');
    el.filter = $('#space-filter');
    el.filterBtn = $('#space-filter-btn');
    el.favBtn = $('#space-fav-btn');
    el.closeBtn = $('#space-close');
    el.addBtn = $('#space-add');
    el.tabs = document.querySelectorAll('[data-tab]');
    el.workspace = $('#workspace');
    el.view = $('#spaces-view');
    el.tbody = $('#spaces-tbody');
    el.pager = $('#spaces-pager');
    el.notice = $('#spaces-notice');
    el.formWrap = $('#space-form-wrap');
    el.createBtn = $('#space-create');
    el.sortBtns = document.querySelectorAll('[data-sort]');
    el.fFav = $('#flt-fav');
    el.fName = $('#flt-name');
    el.fType = $('#flt-type');
    el.fOrigin = $('#flt-origin');
    el.fCreated = $('#flt-created');
  }

  function fillTypeFilter() {
    if (!el.fType) return;
    S.TYPES.forEach(function (t) {
      el.fType.appendChild(h('option', { value: t.id, text: t.label }));
    });
  }

  function wire() {
    el.cardOpen.addEventListener('click', function () {
      setDrawer(!ui.drawerOpen);
    });
    el.closeBtn.addEventListener('click', function () {
      setDrawer(false);
      el.cardOpen.focus();
    });
    el.filterBtn.addEventListener('click', function () {
      setFilterPopup(!ui.filterOpen);
    });
    el.favBtn.addEventListener('click', function () {
      ui.favOnly = !ui.favOnly;
      ui.showAll = false;
      renderDrawer();
    });
    el.filter.addEventListener('click', onFilterClick);
    el.list.addEventListener('click', onDrawerClick);
    el.addBtn.addEventListener('click', function () {
      openForm(null);
    });

    Array.prototype.forEach.call(el.tabs, function (b) {
      b.addEventListener('click', function () {
        showTab(b.dataset.tab);
      });
    });

    if (el.view) {
      el.tbody.addEventListener('click', onTableClick);
      el.pager.addEventListener('click', onPagerClick);
      Array.prototype.forEach.call(el.sortBtns, function (b) {
        b.addEventListener('click', onSortClick);
      });
      [el.fFav, el.fType, el.fOrigin, el.fCreated].forEach(function (f) {
        if (f) f.addEventListener('change', onFilterInput);
      });
      if (el.fName) el.fName.addEventListener('input', onFilterInput);
      if (el.fCreated) el.fCreated.addEventListener('input', onFilterInput);
      el.createBtn.addEventListener('click', function () {
        openForm(null);
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (ui.filterOpen) setFilterPopup(false);
      else if (ui.drawerOpen) setDrawer(false);
    });
  }

  function mount() {
    app = window.SyncrofinApp;
    if (!S || !app) return;
    cache();
    if (!el.card || !el.list || !el.cardOpen) return;
    fillTypeFilter();
    wire();
    app.onPlan(renderCard);
    renderCard(app.summary());
  }

  window.SyncrofinSpacesUI = {
    mount: mount,
    showTab: function (t) {
      showTab(t);
    },
    openForm: function (s) {
      openForm(s || null);
    },
    setDrawer: function (open) {
      setDrawer(!!open);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
