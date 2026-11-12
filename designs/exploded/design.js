/* Exploded view: Prism as a platform site. Sections sit in a top bar and open
   as panels, pages take the full width with a slim strip that stays in view,
   and the landing page opens on the SoC taken apart into its layers. Page
   content is the canonical render in #main. */
(function () {
  'use strict';
  var K = window.PrismKit, el = K.el, svg = K.svg;
  var main = K.main;
  var bar = document.querySelector('.ex-bar');
  var navList = document.getElementById('ex-nav');
  var sheet = document.getElementById('ex-sheet');
  var foot = document.getElementById('ex-foot');
  var local = document.getElementById('ex-local');
  var trail = document.getElementById('ex-trail');
  var onPage = document.getElementById('ex-onpage');
  var onPageList = document.getElementById('ex-onpage-list');

  /* ---------- Menus: the site's sections ---------- */

  function detail(item, depth) {
    var page = K.page(item.href) || {};
    return { href: item.href, label: item.label || page.label, tag: item.tag || page.tag || null, summary: page.summary || item.summary || '', depth: depth || 0 };
  }
  function flatten(items, depth) {
    var out = [];
    (items || []).forEach(function (item) {
      out.push(detail(item, depth || 0));
      out = out.concat(flatten(item.children, (depth || 0) + 1));
    });
    return out;
  }
  function buildMenus() {
    var by = {};
    K.sections().forEach(function (section) { by[section.id] = section; });
    var groups = K.guideGroups();
    var menus = [];
    var learn = { id: 'learn', title: 'Learn', sections: ['tutorials'], columns: [] };
    if (by.tutorials) learn.columns.push({ title: 'Tutorials', items: flatten(by.tutorials.items) });
    if (groups.length) learn.columns.push({ title: groups[0].title, items: groups[0].items.map(function (g) { return detail(g); }) });
    if (learn.columns.length) menus.push(learn);
    if (by.architecture) menus.push({ id: 'architecture', title: 'Architecture', sections: ['architecture'], columns: [{ title: 'From one core to a whole SoC', items: flatten(by.architecture.items) }] });
    if (groups.length) menus.push({ id: 'guides', title: 'Guides', sections: ['guides'], all: { href: '#/guides', label: K.label('#/guides') }, plain: true,
      columns: groups.map(function (group) { return { title: group.title, items: group.items.map(function (g) { return detail(g); }) }; }) });
    var lookup = [];
    if (by.reference) lookup.push({ title: 'Reference', items: flatten(by.reference.items) });
    if (by.tools) lookup.push({ title: 'Tools', items: flatten(by.tools.items) });
    if (lookup.length) menus.push({ id: 'reference', title: 'Reference', sections: ['reference', 'tools'], columns: lookup });
    ['project', 'more'].forEach(function (id) {
      if (!by[id]) return;
      var items = flatten(by[id].items);
      if (items.length === 1) menus.push({ id: id, title: items[0].label, sections: [id], href: items[0].href, columns: [{ title: by[id].title, items: items }] });
      else menus.push({ id: id, title: by[id].title, sections: [id], columns: [{ title: by[id].title, items: items }] });
    });
    return menus;
  }
  var menus = buildMenus();

  function itemLink(item, plain) {
    return el('a', { href: item.href, 'data-depth': item.depth || null },
      el('span', { class: 'ex-item-title' }, item.label, item.tag ? el('span', { class: 'ex-tag', text: item.tag }) : null),
      !plain && item.summary ? el('span', { class: 'ex-item-note', text: item.summary }) : null);
  }
  function columnList(column, plain) {
    return el('div', { class: 'ex-col' }, el('p', { class: 'ex-col-title', text: column.title }),
      el('ul', null, column.items.map(function (item) { return el('li', null, itemLink(item, plain)); })));
  }

  var panels = el('div', { class: 'ex-panels' });
  var openId = null;
  function setOpen(id, focusButton) {
    openId = id;
    menus.forEach(function (menu) {
      if (!menu.button) return;
      var open = menu.id === id;
      menu.button.setAttribute('aria-expanded', String(open));
      menu.panel.hidden = !open;
      if (!open && focusButton === menu.id) menu.button.focus();
    });
    document.documentElement.toggleAttribute('data-menu', !!id);
  }
  function buildBar() {
    menus.forEach(function (menu) {
      if (menu.href) { navList.appendChild(el('li', null, el('a', { href: menu.href, 'data-menu': menu.id, text: menu.title }))); return; }
      var panelId = 'ex-panel-' + menu.id;
      menu.button = el('button', { type: 'button', 'aria-expanded': 'false', 'aria-controls': panelId, 'data-menu': menu.id },
        el('span', { text: menu.title }),
        svg('svg', { viewBox: '0 0 12 12', width: 10, height: 10, 'aria-hidden': 'true' }, svg('path', { d: 'M2 4l4 4 4-4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 })));
      menu.button.addEventListener('click', function () { setOpen(openId === menu.id ? null : menu.id); });
      menu.panel = el('div', { class: 'ex-panel' + (menu.plain ? ' ex-panel-plain' : ''), id: panelId, hidden: true },
        el('div', { class: 'ex-panel-inner' },
          menu.columns.map(function (column) { return columnList(column, menu.plain); }),
          menu.all ? el('p', { class: 'ex-panel-all' }, el('a', { href: menu.all.href, text: menu.all.label })) : null));
      navList.appendChild(el('li', null, menu.button));
      panels.appendChild(menu.panel);
    });
    bar.after(panels);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && openId) { var was = openId; setOpen(null, was); }
    });
    document.addEventListener('click', function (event) {
      if (openId && !bar.contains(event.target) && !panels.contains(event.target)) setOpen(null);
    });
    panels.addEventListener('click', function (event) { if (event.target.closest('a')) setOpen(null); });
    // Leaving the bar and its panel by keyboard closes the panel.
    [bar, panels].forEach(function (region) {
      region.addEventListener('focusout', function (event) {
        var next = event.relatedTarget;
        if (openId && next && !bar.contains(next) && !panels.contains(next)) setOpen(null);
      });
    });
  }

  function buildSheet() {
    sheet.appendChild(el('ul', { class: 'ex-sheet-top' }, el('li', null, el('a', { href: '#/', text: K.label('#/') }))));
    menus.forEach(function (menu) {
      sheet.appendChild(el('details', { class: 'ex-fold' }, el('summary', { text: menu.title }),
        menu.columns.map(function (column) {
          return [menu.columns.length > 1 ? el('p', { class: 'ex-col-title', text: column.title }) : null,
            el('ul', null, column.items.map(function (item) { return el('li', null, itemLink(item, true)); }))];
        }),
        menu.all ? el('ul', null, el('li', null, el('a', { href: menu.all.href, text: menu.all.label }))) : null));
    });
  }
  function buildFoot() {
    menus.forEach(function (menu) {
      foot.appendChild(el('section', { class: menu.columns.length > 2 ? 'ex-foot-wide' : null }, el('h2', { text: menu.title }),
        el('div', { class: 'ex-foot-cols' }, menu.columns.map(function (column) {
          return el('div', null, menu.columns.length > 1 ? el('p', { class: 'ex-col-title', text: column.title }) : null,
            el('ul', null, column.items.map(function (item) { return el('li', null, el('a', { href: item.href, 'data-depth': item.depth || null, text: item.label })); })));
        }))));
    });
  }

  /* ---------- Search ---------- */

  var dialog = document.getElementById('ex-search');
  var query = document.getElementById('ex-query');
  var box = K.combobox(query, document.getElementById('ex-results'), {
    limit: 12,
    status: document.getElementById('ex-search-status'),
    hint: 'Try a guide, a register such as uart.status, or an address such as 0x40020008.',
    render: function (result) {
      return [el('span', { class: 'ex-hit' }, el('span', { class: 'ex-hit-title', text: result.label }), el('span', { class: 'ex-hit-note', text: result.detail })),
        el('span', { class: 'ex-kind', text: result.kind })];
    },
    onPick: function () { dialog.close(); }
  });
  function openSearch() {
    if (dialog.open) return;
    setOpen(null);
    box.clear();
    dialog.showModal();
    query.focus();
  }
  document.getElementById('ex-find').addEventListener('click', openSearch);
  document.getElementById('ex-search-close').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close(); });
  K.hotkey(K.isSearchKey, openSearch);

  /* ---------- The strip that stays: where you are, and this page's sections ---------- */

  function renderLocal(now) {
    local.hidden = now.home;
    trail.replaceChildren();
    now.trail.forEach(function (step, i) {
      var last = i === now.trail.length - 1;
      trail.appendChild(el('li', null, step.href && !last ? el('a', { href: step.href, text: step.label })
        : el('span', { 'aria-current': last ? 'page' : null, text: step.label })));
    });
    onPage.open = false;
    var entries = now.home ? [] : K.outline('h2');
    onPage.hidden = entries.length < 2;
    onPageList.replaceChildren(entries.length < 2 ? '' : K.outlineList(entries, { class: 'ex-outline', onPick: function () { onPage.open = false; } }));
  }
  document.addEventListener('click', function (event) { if (onPage.open && !onPage.contains(event.target)) onPage.open = false; });
  onPage.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && onPage.open) { onPage.open = false; onPage.querySelector('summary').focus(); }
  });

  /* ---------- Landing: the SoC taken apart ---------- */

  // Pages behind each layer of the canonical illustration, by its contract colour.
  var BEHIND = {
    system: ['#/architecture', '#/tutorials/systems'],
    mmio: ['#/reference/address-map', '#/reference/peripherals'],
    bus: ['#/architecture/system-bus'],
    cache: ['#/architecture/datapath', '#/architecture/caches']
  };

  function stackFigure(layers, caption) {
    var n = layers.length, W = 400, row = 112, H = n * row + 20, cx = 168, hw = 150, hh = 70, slab = 9;
    var memory = K.memory() || {};
    var devices = (memory.regions || []).filter(function (r) { return (r.registers || []).length; }).length || 12;
    var drawing = svg('svg', { class: 'ex-stack-art', viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true', focusable: 'false' });
    function centre(i) { return 10 + row * (i + 0.5); }
    [cx - hw, cx, cx + hw].forEach(function (x) {
      drawing.appendChild(svg('line', { class: 'ex-axis', x1: x, x2: x, y1: centre(0), y2: centre(n - 1) + (x === cx ? hh : 0) }));
    });
    var plates = [];
    for (var i = n - 1; i >= 0; i--) {
      var cy = centre(i), layer = layers[i];
      var A = [cx - hw, cy], B = [cx, cy - hh], C = [cx + hw, cy], D = [cx, cy + hh];
      var at = (function (A, B, D) {
        // A point on the plate: u runs along its far edge, v along its near edge.
        return function (u, v) { return [A[0] + u * (B[0] - A[0]) + v * (D[0] - A[0]), A[1] + u * (B[1] - A[1]) + v * (D[1] - A[1])]; };
      })(A, B, D);
      var points = function (list) { return list.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); };
      var block = function (u0, u1, v0, v1) { return svg('polygon', { class: 'ex-part', points: points([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]) }); };
      var parts = [];
      if (layer.color === 'system') parts = [block(0.1, 0.56, 0.14, 0.86), block(0.64, 0.9, 0.14, 0.86)];
      else if (layer.color === 'mmio') {
        var cols = 4, rows = Math.ceil(devices / cols), k = 0;
        for (var r = 0; r < rows; r++) for (var c = 0; c < cols && k < devices; c++, k++) {
          parts.push(block(0.1 + c * 0.205, 0.1 + c * 0.205 + 0.165, 0.12 + r * (0.76 / rows), 0.12 + r * (0.76 / rows) + 0.6 / rows));
        }
      }
      else if (layer.color === 'bus') parts = [block(0.1, 0.9, 0.42, 0.58), block(0.16, 0.3, 0.16, 0.42), block(0.43, 0.57, 0.16, 0.42), block(0.7, 0.84, 0.58, 0.84)];
      else if (layer.color === 'cache') parts = [block(0.12, 0.6, 0.18, 0.82), block(0.68, 0.88, 0.18, 0.46), block(0.68, 0.88, 0.54, 0.82)];
      var plate = svg('g', { class: 'ex-plate', 'data-layer': i, style: '--plate: var(--c-' + layer.color + '); --i: ' + i + '; --lift: ' + ((n - 1) / 2 - i) * (row - 16) + 'px' },
        svg('polygon', { class: 'ex-side', points: points([A, D, [D[0], D[1] + slab], [A[0], A[1] + slab]]) }),
        svg('polygon', { class: 'ex-side', points: points([D, C, [C[0], C[1] + slab], [D[0], D[1] + slab]]) }),
        svg('polygon', { class: 'ex-top', points: points([A, B, C, D]) }),
        parts,
        svg('line', { class: 'ex-lead', x1: C[0], y1: C[1], x2: W, y2: C[1] }));
      plates[i] = plate;
      drawing.appendChild(plate);
    }
    function activate(index) { plates.forEach(function (plate, j) { plate.toggleAttribute('data-active', j === index); }); }
    var labels = el('ol', { class: 'ex-layers' }, layers.map(function (layer, i) {
      var links = (BEHIND[layer.color] || []).map(K.page).filter(Boolean);
      var item = el('li', { style: '--plate: var(--c-' + layer.color + '); --at: ' + (centre(i) / H * 100).toFixed(2) + '%' },
        el('p', { class: 'ex-layer-title', text: layer.title }),
        el('p', { class: 'ex-layer-sub' + (layer.mono ? ' mono' : ''), text: layer.sub }),
        links.length ? el('p', { class: 'ex-layer-links' }, links.map(function (page) { return el('a', { href: page.href, text: page.label }); })) : null);
      item.addEventListener('mouseenter', function () { activate(i); });
      item.addEventListener('focusin', function () { activate(i); });
      item.addEventListener('mouseleave', function () { activate(-1); });
      item.addEventListener('focusout', function () { activate(-1); });
      if (links.length) {
        plates[i].addEventListener('click', function () { location.hash = links[0].href; });
        plates[i].addEventListener('mouseenter', function () { activate(i); });
        plates[i].addEventListener('mouseleave', function () { activate(-1); });
        plates[i].setAttribute('data-link', '');
      }
      return item;
    }));
    return el('figure', { class: 'ex-stack' }, el('div', { class: 'ex-stack-body' }, drawing, labels),
      caption ? el('figcaption', { text: caption }) : null);
  }

  function composeHome() {
    var page = main.querySelector(':scope > .page');
    var hero = page && page.querySelector('.hero');
    if (!hero || page.hasAttribute('data-ex')) return;
    page.setAttribute('data-ex', 'home');
    // The layer names and the caption come from the canonical illustration.
    var art = hero.querySelector('.hero-art');
    var layers = art ? Array.prototype.map.call(art.querySelectorAll('.ray'), function (ray) {
      var sub = ray.querySelector('.ray-sub'), title = ray.querySelector('.ray-title');
      return { color: (/--c-([a-z]+)/.exec(ray.getAttribute('style') || '') || [])[1] || 'system',
        title: title ? title.textContent : '', sub: sub ? sub.textContent : '', mono: !!sub && sub.classList.contains('mono') };
    }) : [];
    if (layers.length) {
      var caption = art.querySelector('title');
      art.replaceWith(stackFigure(layers, caption ? caption.textContent : ''));
    }
    var routes = el('section', { class: 'ex-routes', 'aria-labelledby': 'ex-routes-title' },
      el('h2', { id: 'ex-routes-title', text: 'Routes by reader' }),
      el('div', { class: 'ex-routes-grid' }, K.paths().map(function (path) {
        return el('div', { class: 'ex-route' }, el('h3', { text: path.title }), el('p', { text: path.intent }),
          el('ol', null, path.steps.map(function (step) { return el('li', null, el('a', { href: step.href, text: step.label })); })));
      })));
    hero.after(routes);
  }

  function composeGuideIndex(now) {
    if (now.path !== 'guides') return;
    var list = main.querySelector(':scope > .page > ul.next-list');
    if (!list) return;
    list.replaceWith(el('div', { class: 'ex-index' }, K.guideGroups().map(function (group) {
      return el('section', null, el('h2', { text: group.title }),
        el('ul', null, group.items.map(function (guide) {
          return el('li', null, el('a', { href: guide.href }, el('span', { class: 'ex-item-title', text: guide.label }), el('span', { class: 'ex-item-note', text: guide.summary })));
        })));
    })));
  }

  buildBar();
  buildSheet();
  buildFoot();
  // Peripheral documents generated in this session join the Reference panel.
  K.onLocalDocuments(function (documents) {
    var menu = menus.filter(function (m) { return m.id === 'reference'; })[0];
    var inner = menu && menu.panel && menu.panel.querySelector('.ex-panel-inner');
    if (!inner) return;
    var old = inner.querySelector('.ex-col-local');
    if (old) old.remove();
    if (!documents.length) return;
    var column = columnList({ title: 'Local documents, this session', items: documents.map(function (d) { return { href: d.href, label: d.label }; }) }, true);
    column.classList.add('ex-col-local');
    inner.appendChild(column);
  });
  K.onRender(function (now) {
    setOpen(null);
    if (dialog.open) dialog.close();
    var current = menus.filter(function (menu) { return menu.sections.indexOf(now.section) !== -1; })[0];
    Array.prototype.forEach.call(navList.querySelectorAll('[data-menu]'), function (control) {
      control.toggleAttribute('data-current', !!current && control.getAttribute('data-menu') === current.id);
    });
    [panels, sheet, foot].forEach(K.markCurrent);
    Array.prototype.forEach.call(sheet.querySelectorAll('details'), function (fold) { fold.open = !!fold.querySelector('[aria-current="page"]'); });
    if (now.home) composeHome();
    composeGuideIndex(now);
    renderLocal(now);
  });
  K.start();
})();
