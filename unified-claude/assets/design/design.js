/* Unified (Claude): one documentation shell assembled from the parts of the
   three prototypes the user chose, set as one system.

   - The contents tree on the left (Datasheet), with find at its head
     (Coursebook) and each page's implementation status beside its name.
   - Breadcrumbs with the current page's status (Datasheet, current site).
   - Previous and next at the foot of every page, in the order of the tree
     (Coursebook), with no record of what has been read.
   - The landing page opens on the SoC drawn apart into its layers (Exploded).
   - The address space figure sits on the address map page (Datasheet).
   - The beam through the prism (current site) opens the architecture
     overview, where each ray finds its layer in the block diagram.

   Everything here is navigation, layout and illustration. Page content is the
   canonical render in #main; labels are read from the canonical data or the
   rendered page wherever they exist. */
(function () {
  'use strict';
  var K = window.PrismKit, el = K.el, svg = K.svg;
  var main = K.main;
  var tree = document.getElementById('uc-tree');
  var rail = document.getElementById('uc-rail');
  var pager = document.getElementById('uc-pager');
  var dock = document.getElementById('uc-dock');
  var menuButton = document.getElementById('menu-button');
  var sidebar = document.getElementById('sidebar');
  var trails = [document.getElementById('uc-trail'), document.getElementById('uc-trail-inline')];
  var narrow = window.matchMedia('(max-width: 959px)');

  /* ---------- Status: the canonical tags, drawn as the canonical badges ---------- */

  function statusBadge(tag, extra) {
    if (!tag) return null;
    var slug = String(tag).toLowerCase().replace(/\s+/g, '-');
    return el('span', { class: 'status-badge status-' + slug + ' uc-status' + (extra ? ' ' + extra : ''), text: tag });
  }
  // A page's own status, or the nearest status above it in the tree.
  function statusOf(now) {
    if (!now.page) return null;
    if (now.page.tag) return now.page.tag;
    for (var i = now.page.parents.length - 1; i >= 0; i--) {
      var parent = K.page(now.page.parents[i]);
      if (parent && parent.tag) return parent.tag;
    }
    return null;
  }

  /* ---------- Contents tree, which is also the reading order ---------- */

  var sequence = [];       // every page once, in the order the tree lists it
  var folds = [];
  function addStop(href, label, part, stop) {
    if (stop === false) return;
    if (sequence.some(function (s) { return s.href === href; })) return;
    sequence.push({ href: href, label: label, part: part });
  }
  function navLink(item) {
    return el('a', { href: item.href },
      el('span', { class: 'uc-label', text: item.label }), statusBadge(item.tag));
  }
  function branch(items, part, depth) {
    return el('ul', null, items.map(function (item) {
      // A page that only groups others (the datapath tab) is listed but is
      // not a stop of its own when reading in order.
      addStop(item.href, item.label, part, !(depth > 0 && item.children && item.children.length));
      return el('li', null, navLink(item), item.children ? branch(item.children, part, depth + 1) : null);
    }));
  }
  function group(id, title, body) {
    return el('section', { class: 'uc-group', 'aria-labelledby': 'uc-group-' + id },
      el('p', { class: 'uc-group-title', id: 'uc-group-' + id, text: title }), body);
  }
  function fold(title, items, part, open) {
    var node = el('details', { class: 'uc-fold', open: open },
      el('summary', null, el('span', { text: title })), branch(items, part, 0));
    folds.push(node);
    return node;
  }

  var localList = el('ul', { class: 'uc-local' });
  function buildTree() {
    var by = {};
    K.sections().forEach(function (s) { by[s.id] = s; });
    var groups = K.guideGroups();
    var first = groups[0];
    // Start: the overview and the first-steps guides.
    tree.appendChild(group('start', 'Start', branch([{ href: '#/', label: K.label('#/') }].concat(first ? first.items : []), 'Start', 0)));
    if (by.tutorials) tree.appendChild(group('tutorials', by.tutorials.title, branch(by.tutorials.items, by.tutorials.title, 0)));
    if (by.architecture) tree.appendChild(group('architecture', by.architecture.title, branch(by.architecture.items, by.architecture.title, 0)));
    if (groups.length > 1) {
      tree.appendChild(group('guides', 'Guides', el('div', null,
        branch([{ href: '#/guides', label: K.label('#/guides') }], 'Guides', 0),
        groups.slice(1).map(function (g) { return fold(g.title, g.items, 'Guides', false); }))));
    }
    ['reference', 'tools', 'project', 'more'].forEach(function (id) {
      if (!by[id]) return;
      var body = el('div', null, branch(by[id].items, by[id].title, 0));
      if (id === 'tools') body.appendChild(localList);
      tree.appendChild(group(id, by[id].title, body));
    });
  }
  // Peripheral documents generated in this session join Tools.
  K.onLocalDocuments(function (documents) {
    localList.replaceChildren();
    documents.forEach(function (d) { localList.appendChild(el('li', null, el('a', { href: d.href }, el('span', { class: 'uc-label', text: d.label }), el('span', { class: 'uc-note', text: 'this session' })))); });
    K.markCurrent(localList);
  });

  /* ---------- Find, at the head of the contents ---------- */

  var query = document.getElementById('uc-query');
  var find = document.getElementById('uc-find');
  var box = K.combobox(query, document.getElementById('uc-results'), {
    limit: 10,
    status: document.getElementById('uc-find-status'),
    render: function (result) {
      return [el('span', { class: 'uc-hit' }, el('span', { class: 'uc-hit-label', text: result.label }), el('span', { class: 'uc-kind', text: result.kind })),
        result.detail ? el('span', { class: 'uc-hit-detail', text: result.detail }) : null];
    },
    onPick: function () {
      box.clear(); find.removeAttribute('data-active');
      if (narrow.matches && sidebar.classList.contains('open')) document.getElementById('close-button').click();
    }
  });
  query.addEventListener('input', function () { find.toggleAttribute('data-active', !!query.value.trim()); });
  query.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && query.value) { event.stopPropagation(); box.clear(); find.removeAttribute('data-active'); }
  });
  // Keep Tab inside the open drawer. The canonical trap counts only links and
  // buttons; this one also counts the search field and the guide folds, and
  // skips results that take focus only through the arrow keys.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Tab' || !narrow.matches || !sidebar.classList.contains('open')) return;
    event.stopImmediatePropagation();
    var controls = Array.prototype.filter.call(sidebar.querySelectorAll('a[href], button, input, summary'), function (node) {
      return node.tabIndex >= 0 && !node.disabled && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    });
    if (!controls.length) return;
    var first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, true);

  K.hotkey(K.isSearchKey, function () {
    // The contents are a drawer on narrow screens and can be hidden on wide ones.
    if (sidebar.offsetParent === null || getComputedStyle(sidebar).visibility === 'hidden') menuButton.click();
    window.setTimeout(function () { query.focus(); query.select(); }, 60);
  });

  /* ---------- Breadcrumbs with status ---------- */

  function renderTrail(now) {
    var tag = statusOf(now);
    trails.forEach(function (list) {
      list.replaceChildren();
      now.trail.forEach(function (step, i) {
        var last = i === now.trail.length - 1;
        list.appendChild(el('li', null, step.href && !last ? el('a', { href: step.href, text: step.label })
          : el('span', { 'aria-current': last ? 'page' : null, text: step.label })));
      });
      if (tag && now.trail.length) list.appendChild(el('li', { class: 'uc-trail-status' }, statusBadge(tag)));
      list.parentNode.hidden = !now.trail.length;
    });
  }

  /* ---------- Previous and next ---------- */

  function neighbours(now) {
    var index = -1;
    sequence.forEach(function (stop, i) { if (stop.href === now.href) index = i; });
    return { previous: index > 0 ? sequence[index - 1] : null,
      next: index >= 0 && index < sequence.length - 1 ? sequence[index + 1] : null };
  }
  function pageLink(stop, way) {
    if (!stop) return el('span', { class: 'uc-pager-none' });
    return el('a', { class: 'uc-pager-' + way, href: stop.href, rel: way === 'next' ? 'next' : 'prev' },
      el('span', { class: 'uc-pager-way', text: (way === 'next' ? 'Next' : 'Previous') + ' · ' + stop.part }),
      el('span', { class: 'uc-pager-title', text: stop.label }));
  }
  function renderPager(now) {
    var near = neighbours(now);
    pager.replaceChildren(pageLink(near.previous, 'previous'), pageLink(near.next, 'next'));
    pager.hidden = !near.previous && !near.next;
    var contents = el('button', { type: 'button', class: 'uc-dock-contents', 'aria-controls': 'sidebar', text: 'Contents' });
    contents.addEventListener('click', function () { menuButton.click(); });
    function step(stop, way) {
      if (!stop) return el('span', { class: 'uc-dock-step' });
      return el('a', { class: 'uc-dock-step uc-dock-' + way, href: stop.href, rel: way === 'next' ? 'next' : 'prev' },
        el('span', { class: 'uc-dock-way', text: way === 'next' ? 'Next ›' : '‹ Previous' }),
        el('span', { class: 'uc-dock-title', text: stop.label }));
    }
    dock.replaceChildren(step(near.previous, 'previous'), contents, step(near.next, 'next'));
  }

  /* ---------- On this page ---------- */

  var stopSpy = null;
  function renderRail(now) {
    if (stopSpy) { stopSpy(); stopSpy = null; }
    rail.replaceChildren();
    var entries = now.home ? [] : K.outline('h2, h3');
    rail.hidden = entries.length < 2;
    document.documentElement.toggleAttribute('data-rail', !rail.hidden);
    if (rail.hidden) return;
    rail.appendChild(el('p', { class: 'uc-rail-title', text: 'On this page' }));
    rail.appendChild(K.outlineList(entries, { class: 'uc-outline' }));
    stopSpy = K.spy(entries, function (active) {
      entries.forEach(function (entry, i) { entry.link.toggleAttribute('data-active', i === active); });
    });
  }

  /* ---------- Landing: the SoC drawn apart into its layers ---------- */

  // Pages behind each layer of the canonical illustration, by contract colour.
  var BEHIND = {
    system: ['#/architecture', '#/tutorials/systems'],
    mmio: ['#/reference/address-map', '#/reference/peripherals'],
    bus: ['#/architecture/system-bus'],
    cache: ['#/architecture/datapath', '#/architecture/caches']
  };

  // On a phone the plates are drawn further apart, so each layer's labels
  // still sit beside its plate.
  var compactStack = window.matchMedia('(max-width: 700px)');
  function stackFigure(layers, caption) {
    var n = layers.length, W = 400, row = compactStack.matches ? 330 : 150, H = n * row + 20, cx = 168, hw = 150, hh = 70, slab = 9;
    var memory = K.memory() || {};
    var devices = (memory.regions || []).filter(function (r) { return (r.registers || []).length; }).length || 12;
    var drawing = svg('svg', { class: 'uc-stack-art', viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true', focusable: 'false' });
    function centre(i) { return 10 + row * (i + 0.5); }
    [cx - hw, cx, cx + hw].forEach(function (x) {
      drawing.appendChild(svg('line', { class: 'uc-axis', x1: x, x2: x, y1: centre(0), y2: centre(n - 1) + (x === cx ? hh : 0) }));
    });
    var plates = [];
    function points(list) { return list.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); }
    for (var i = n - 1; i >= 0; i--) {
      var cy = centre(i), layer = layers[i];
      var A = [cx - hw, cy], B = [cx, cy - hh], C = [cx + hw, cy], D = [cx, cy + hh];
      var at = (function (A, B, D) {
        // A point on the plate: u runs along its far edge, v along its near edge.
        return function (u, v) { return [A[0] + u * (B[0] - A[0]) + v * (D[0] - A[0]), A[1] + u * (B[1] - A[1]) + v * (D[1] - A[1])]; };
      })(A, B, D);
      var block = (function (at) {
        return function (u0, u1, v0, v1) { return svg('polygon', { class: 'uc-part', points: points([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]) }); };
      })(at);
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
      var plate = svg('g', { class: 'uc-plate', style: '--plate: var(--c-' + layer.color + '); --lift: ' + ((n - 1) / 2 - i) * (row - 16) + 'px' },
        svg('polygon', { class: 'uc-side', points: points([A, D, [D[0], D[1] + slab], [A[0], A[1] + slab]]) }),
        svg('polygon', { class: 'uc-side', points: points([D, C, [C[0], C[1] + slab], [D[0], D[1] + slab]]) }),
        svg('polygon', { class: 'uc-top', points: points([A, B, C, D]) }),
        parts,
        svg('line', { class: 'uc-lead', x1: C[0], y1: C[1], x2: W, y2: C[1] }));
      plates[i] = plate;
      drawing.appendChild(plate);
    }
    function activate(index) { plates.forEach(function (plate, j) { plate.toggleAttribute('data-active', j === index); }); }
    var labels = el('ol', { class: 'uc-layers' }, layers.map(function (layer, i) {
      var links = (BEHIND[layer.color] || []).map(K.page).filter(Boolean);
      var item = el('li', { style: '--plate: var(--c-' + layer.color + '); --at: ' + (centre(i) / H * 100).toFixed(2) + '%' },
        el('p', { class: 'uc-layer-title', text: layer.title }),
        el('p', { class: 'uc-layer-sub' + (layer.mono ? ' mono' : ''), text: layer.sub }),
        links.length ? el('p', { class: 'uc-layer-links' }, links.map(function (page) { return el('a', { href: page.href, text: page.label }); })) : null);
      ['mouseenter', 'focusin'].forEach(function (type) { item.addEventListener(type, function () { activate(i); }); });
      ['mouseleave', 'focusout'].forEach(function (type) { item.addEventListener(type, function () { activate(-1); }); });
      if (links.length) {
        plates[i].addEventListener('click', function () { location.hash = links[0].href; });
        plates[i].addEventListener('mouseenter', function () { activate(i); });
        plates[i].addEventListener('mouseleave', function () { activate(-1); });
        plates[i].setAttribute('data-link', '');
      }
      return item;
    }));
    return el('figure', { class: 'uc-stack' }, el('div', { class: 'uc-stack-body' }, drawing, labels),
      caption ? el('figcaption', { text: caption }) : null);
  }

  function routeList(path) {
    // The user's name for this audience.
    return el('div', { class: 'uc-route' }, el('h3', { text: path.id === 'teams' ? 'Industry partners' : path.title }), el('p', { text: path.intent }),
      el('ol', null, path.steps.map(function (step) { return el('li', null, el('a', { href: step.href, text: step.label })); })));
  }

  function composeHome() {
    var page = main.querySelector(':scope > .page');
    var hero = page && page.querySelector('.hero');
    if (!hero || page.hasAttribute('data-uc')) return;
    page.setAttribute('data-uc', 'home');
    // The layer names and the caption come from the canonical illustration.
    var art = hero.querySelector('.hero-art');
    var layers = art ? Array.prototype.map.call(art.querySelectorAll('.ray'), function (ray) {
      var sub = ray.querySelector('.ray-sub'), title = ray.querySelector('.ray-title');
      return { color: (/--c-([a-z]+)/.exec(ray.getAttribute('style') || '') || [])[1] || 'system',
        title: title ? title.textContent : '', sub: sub ? sub.textContent : '', mono: !!sub && sub.classList.contains('mono') };
    }) : [];
    if (layers.length) {
      var title = art.querySelector('title'), caption = title ? title.textContent : '';
      art.replaceWith(stackFigure(layers, caption));
      var redraw = function () {
        var figure = page.isConnected && page.querySelector('.uc-stack');
        if (figure) figure.replaceWith(stackFigure(layers, caption));
        else compactStack.removeEventListener('change', redraw);
      };
      compactStack.addEventListener('change', redraw);
    }
    hero.after(el('section', { class: 'uc-routes', 'aria-labelledby': 'uc-routes-title' },
      el('h2', { id: 'uc-routes-title', text: 'Routes by reader' }),
      el('div', { class: 'uc-routes-grid' }, K.paths().map(routeList))));
  }

  /* ---------- Architecture overview: the beam through the prism ---------- */

  // Firmware sees one microcontroller (the white beam); the prism splits it
  // into the layers an RTL engineer can change. The geometry is the current
  // site's landing illustration; each ray's labels are read from the parts
  // list on the page, and selecting one shows that part in the diagram.
  var RAYS = [
    { color: 'system', part: 'system', contract: null, exit: [285, 170], end: [410, 62] },
    { color: 'mmio', part: 'peripherals', contract: 'mmio_if', exit: [291.6, 185.6], end: [410, 142] },
    { color: 'bus', part: 'fabric', contract: 'system_bus_if', exit: [298.2, 201.2], end: [410, 222] },
    { color: 'cache', part: 'tile', contract: 'cache_fabric_if', exit: [304.8, 216.8], end: [410, 302] }
  ];
  function partName(panel, key) {
    var name = panel.querySelector('#part-' + key + ' .name');
    return name ? name.textContent.trim() : null;
  }
  function showPart(panel, key) {
    var button = panel.querySelector('#part-' + key + ' .link-button');
    if (button) button.click();
  }
  function beamFigure(panel) {
    var entry = [166, 191], top = 30, height = 305;
    function pt(p) { return p[0] + ',' + p[1]; }
    var first = RAYS[0].exit, last = RAYS[RAYS.length - 1].exit;
    var drawing = svg('svg', { class: 'hero-art uc-beam-art', viewBox: '0 ' + top + ' 470 ' + height, 'aria-hidden': 'true', focusable: 'false' },
      svg('defs', null, svg('linearGradient', { id: 'uc-beam-fan', gradientUnits: 'userSpaceOnUse', x1: 0, y1: first[1], x2: 0, y2: last[1] },
        RAYS.map(function (ray, i) { return svg('stop', { offset: i / (RAYS.length - 1), 'stop-color': 'var(--c-' + ray.color + ')' }); }))),
      svg('text', { class: 'beam-title', x: 0, y: 150, text: 'Firmware' }),
      svg('text', { class: 'ray-sub', x: 0, y: 174, text: 'one microcontroller' }),
      svg('path', { class: 'beam', pathLength: 1, d: 'M0,236 L' + (entry[0] + 40) + ',' + entry[1] }),
      svg('g', { transform: 'translate(40 0)' },
        svg('polygon', { class: 'fan', points: [pt(entry), pt(first), pt(last)].join(' '), fill: 'url(#uc-beam-fan)' }),
        svg('path', { class: 'prism', d: 'M230,40 L340,300 L120,300 Z' }),
        RAYS.map(function (ray, i) {
          return svg('g', { class: 'ray', style: '--ray: var(--c-' + ray.color + '); --i: ' + i },
            svg('path', { pathLength: 1, d: 'M' + pt(ray.exit) + ' L' + pt(ray.end) }),
            svg('circle', { cx: ray.end[0], cy: ray.end[1], r: 4.5 }));
        })));
    var labels = el('ol', { class: 'uc-rays' }, RAYS.map(function (ray, i) {
      var title = partName(panel, ray.part), contract = ray.contract && partName(panel, ray.contract);
      if (!title) return null;
      var main = el('button', { type: 'button', class: 'uc-ray-title', text: title, 'aria-describedby': 'uc-beam-hint' });
      main.addEventListener('click', function () { showPart(panel, ray.part); });
      var sub = null;
      if (contract) {
        sub = el('button', { type: 'button', class: 'uc-ray-contract', text: contract, 'aria-describedby': 'uc-beam-hint' });
        sub.addEventListener('click', function () { showPart(panel, ray.contract); });
      }
      return el('li', { style: '--ray: var(--c-' + ray.color + '); --i: ' + i + '; --at: ' + ((ray.end[1] - top) / height * 100).toFixed(2) + '%' }, main, sub);
    }));
    return el('figure', { class: 'uc-beam' },
      el('div', { class: 'uc-beam-body' }, drawing, labels),
      el('figcaption', { id: 'uc-beam-hint' }, 'Firmware sees one microcontroller. Behind it are layers you can change one at a time; each meets the next at a contract. Select a layer or a contract to show it in the diagram below.'));
  }
  function composeArchitecture(now) {
    if (now.path !== 'architecture') return;
    var panel = main.querySelector('.architecture-overview');
    if (!panel || panel.querySelector('.uc-beam')) return;
    if (!panel.querySelector('#part-system')) return;
    var lede = panel.querySelector(':scope > .lede');
    var figure = beamFigure(panel);
    // The opening paragraph and the beam share the first screen when there is room.
    var grid = el('div', { class: 'uc-arch-grid' });
    var opening = el('div', { class: 'uc-arch-intro' }, grid);
    if (lede) { lede.before(opening); grid.appendChild(lede); } else panel.prepend(opening);
    grid.appendChild(figure);
  }

  /* ---------- Address map: the address space figure ---------- */

  function addressFigure() {
    var memory = K.memory();
    if (!memory || !memory.storage) return null;
    var blocks = memory.storage.map(function (s) {
      return { name: s.name, base: s.base, last: s.last, note: K.size(s.bytes) + ' installed of ' + K.size(s.reserved_bytes) + ' reserved',
        fill: s.reserved_bytes ? s.bytes / s.reserved_bytes : 0 };
    });
    if (memory.aperture) {
      blocks.push({ name: 'Peripheral aperture', base: memory.aperture.base, last: memory.aperture.base + memory.aperture.bytes - 1,
        note: K.size(memory.aperture.bytes) + ', one reserved region per peripheral',
        regions: (memory.regions || []).slice().sort(function (a, b) { return a.base - b.base; }) });
    }
    blocks.sort(function (a, b) { return b.base - a.base; });
    var rows = [], ceiling = 0xFFFFFFFF;
    blocks.forEach(function (block) {
      if (block.last < ceiling) rows.push({ gap: true, last: ceiling, base: block.last + 1 });
      rows.push(block);
      ceiling = block.base - 1;
    });
    if (ceiling >= 0) rows.push({ gap: true, last: ceiling, base: 0 });

    function bound(value) { return el('span', { class: 'uc-map-bound', text: K.hexSpaced(value) }); }
    var list = el('ol', { class: 'uc-map-rows' }, rows.map(function (row) {
      if (row.gap) return el('li', { class: 'uc-map-gap' }, bound(row.last), el('span', { class: 'uc-map-body', text: 'Outside the address map' }));
      return el('li', { class: 'uc-map-block' + (row.regions ? ' has-regions' : '') }, bound(row.last),
        el('div', { class: 'uc-map-body' },
          el('p', { class: 'uc-map-name', text: row.name }),
          el('p', { class: 'uc-map-note', text: row.note }),
          row.fill !== undefined ? el('span', { class: 'uc-map-meter', 'aria-hidden': 'true' }, el('span', { style: 'width:' + Math.max(1.5, row.fill * 100).toFixed(2) + '%' })) : null,
          row.regions ? el('ol', { class: 'uc-map-regions', 'aria-label': 'Reserved regions, lowest address first' }, row.regions.map(function (region) {
            return el('li', null, el('a', { href: '#/reference/address-map/' + encodeURIComponent(region.id), 'data-region': region.id },
              el('span', { class: 'uc-map-id', text: region.id }), el('span', { class: 'uc-map-base', text: K.hexSpaced(region.base) })));
          })) : null));
    }));
    list.appendChild(el('li', { class: 'uc-map-floor' }, bound(0)));
    return el('figure', { class: 'uc-map', 'aria-labelledby': 'uc-map-title' },
      el('figcaption', { class: 'visually-hidden', id: 'uc-map-title', text: 'Address space, highest address first. Select a region to open it below.' }),
      list);
  }
  function markRegion() {
    var figure = main.querySelector('.uc-map');
    if (!figure) return;
    var id = (/^#\/reference\/address-map\/([^#]+)/.exec(location.hash) || [])[1];
    try { id = id ? decodeURIComponent(id) : null; } catch (error) { id = null; }
    Array.prototype.forEach.call(figure.querySelectorAll('[data-region]'), function (a) {
      if (a.getAttribute('data-region') === id) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
    });
  }
  function composeAddressMap(now) {
    if (now.href !== '#/reference/address-map') return;
    var page = main.querySelector(':scope > .page');
    if (!page) return;
    if (!page.querySelector('.uc-map')) {
      var figure = addressFigure();
      if (!figure) return;
      var anchor = page.querySelector(':scope > .page-contents') || page.querySelector(':scope > .section-intro') || page.querySelector(':scope > .lede');
      if (!anchor) return;
      // Open on the overview; folded when the address names a region, so
      // its registers come first.
      anchor.after(el('details', { class: 'uc-map-panel', open: !now.param },
        el('summary', null, el('span', { text: 'Address space overview' }), el('span', { class: 'uc-map-panel-note', text: 'RAM, ROM and every reserved region, highest address first' })),
        figure));
      page.setAttribute('data-uc', 'address-map');
    }
    markRegion();
  }
  // Selecting a region in the page replaces the address without a hashchange.
  main.addEventListener('click', function () { window.setTimeout(markRegion, 0); });

  /* ---------- Guide index ---------- */

  function composeGuideIndex(now) {
    if (now.path !== 'guides') return;
    var list = main.querySelector(':scope > .page > ul.next-list');
    if (!list) return;
    list.replaceWith(el('div', { class: 'uc-index' }, K.guideGroups().map(function (g) {
      return el('section', null, el('h2', { text: g.title }),
        el('ul', null, g.items.map(function (guide) {
          return el('li', null, el('a', { href: guide.href, text: guide.label }), el('span', { text: guide.summary }));
        })));
    })));
  }

  // Keep the current page in view in the contents, below the search field.
  function revealCurrent(now) {
    if (now.home) { sidebar.scrollTop = 0; return; }
    var active = tree.querySelector('[aria-current="page"]');
    if (!active || !active.getClientRects().length) return;
    var item = active.getBoundingClientRect(), bounds = sidebar.getBoundingClientRect();
    var top = find.getBoundingClientRect().bottom + 12;
    if (item.bottom > bounds.bottom - 24) sidebar.scrollTop += item.bottom - bounds.bottom + bounds.height / 3;
    else if (item.top < top) sidebar.scrollTop -= top - item.top + 24;
  }

  // A local peripheral document is a page of its own; give it a page title.
  function composeLocal(now) {
    if (!/^local\//.test(now.path)) return;
    var title = main.querySelector('.doc-result > h2');
    if (title && !main.querySelector('h1')) title.replaceWith(el('h1', { id: 'page-title', tabindex: '-1', text: title.textContent }));
  }

  buildTree();
  K.onRender(function (now) {
    K.markCurrent(tree);
    folds.forEach(function (node) { if (node.querySelector('[aria-current="page"], [data-within]')) node.open = true; });
    revealCurrent(now);
    composeLocal(now);
    renderTrail(now);
    if (now.home) composeHome();
    composeArchitecture(now);
    composeAddressMap(now);
    composeGuideIndex(now);
    renderPager(now);
    renderRail(now);
  });
  K.start();
})();
