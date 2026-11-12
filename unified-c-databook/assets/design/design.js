/* Unified C: Unified B (GPT-6.1 Sol) with one type system and folding contents.
   Navigation, diagrams and framing only. Guides and references stay canonical. */
(function () {
  'use strict';
  var K = window.PrismKit, el = K.el, svg = K.svg, main = K.main;
  var tree = document.getElementById('un-tree');
  var trail = document.getElementById('un-trail');
  var rail = document.getElementById('un-rail');
  var pager = document.getElementById('un-pager');
  var query = document.getElementById('un-query');
  var sidebar = document.getElementById('sidebar');
  var menu = document.getElementById('menu-button');
  var close = document.getElementById('close-button');
  var narrow = window.matchMedia('(max-width: 959px)');

  var sequence = [], stopBeam = null;
  var trailNav = trail.parentElement;
  function placeTrail() {
    if (narrow.matches) document.querySelector('.un-document').prepend(trailNav);
    else document.getElementById('theme-button').before(trailNav);
  }
  placeTrail();
  narrow.addEventListener('change', placeTrail);

  /* Datasheet's complete tree, including nested architecture and guide groups. */
  function navLink(item) {
    // The pager records the exact depth-first order used to draw this tree.
    if (!sequence.some(function (stop) { return stop.href === item.href; })) {
      sequence.push({ href: item.href, label: item.label });
    }
    return el('a', { href: item.href }, el('span', { text: item.label }),
      item.tag ? el('span', { class: 'un-tag', text: item.tag }) : null);
  }
  // The first two levels stay open. A page below them that has pages of its
  // own (Core datapath and its cores) folds, and opens when the reader is on
  // it or inside it.
  var branches = [];
  function branch(items, depth) {
    depth = depth || 0;
    return el('ul', null, items.map(function (item) {
      if (!item.children) return el('li', null, navLink(item));
      var link = navLink(item);
      var list = branch(item.children, depth + 1);
      if (depth < 1) return el('li', null, link, list);
      var id = 'un-branch-' + branches.length;
      list.id = id;
      var toggle = el('button', { type: 'button', class: 'un-toggle', 'aria-controls': id });
      var record = { href: item.href, label: item.label, link: link, toggle: toggle, list: list };
      toggle.addEventListener('click', function () { setBranch(record, toggle.getAttribute('aria-expanded') !== 'true'); });
      setBranch(record, false);
      branches.push(record);
      return el('li', { class: 'un-branch' }, el('div', { class: 'un-row' }, toggle, link), list);
    }));
  }
  function setBranch(record, open) {
    record.toggle.setAttribute('aria-expanded', String(open));
    record.toggle.setAttribute('aria-label', (open ? 'Hide' : 'Show') + ' the pages under ' + record.label);
    record.list.hidden = !open;
  }
  function openCurrentBranches() {
    branches.forEach(function (record) {
      if (record.list.querySelector('[aria-current="page"]') || record.link.getAttribute('aria-current') === 'page') setBranch(record, true);
    });
  }
  ['start', 'reference', 'architecture', 'tutorials', 'guides', 'tools', 'project', 'more'].forEach(function (id) {
    var section = K.section(id);
    if (!section) return;
    var titleId = 'un-group-' + id;
    var body = id === 'guides' ? el('div', null,
      branch([{ href: '#/guides', label: 'All guides' }]),
      section.groups.map(function (group, i) {
        return el('details', { class: 'un-fold', open: i === 0 },
          el('summary', { text: group.title }), branch(group.items));
      })) : branch(section.items);
    tree.appendChild(el('section', { class: 'un-group', 'aria-labelledby': titleId },
      el('p', { class: 'un-group-title', id: titleId, text: section.title }), body));
  });

  /* Search lives in the sidebar. No visit history or reading state is stored. */
  var find = query.closest('.un-find');
  var box = K.combobox(query, document.getElementById('un-results'), {
    limit: 10, status: document.getElementById('un-find-status'),
    render: function (hit) {
      return [el('span', { class: 'un-hit', text: hit.label }),
        el('span', { class: 'un-hit-detail', text: hit.kind + (hit.detail ? ' · ' + hit.detail : '') })];
    },
    onPick: function () {
      box.clear(); find.removeAttribute('data-active');
      if (narrow.matches && sidebar.classList.contains('open')) close.click();
    }
  });
  query.addEventListener('input', function () { find.toggleAttribute('data-active', !!query.value.trim()); });
  query.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && query.value) {
      event.stopPropagation(); box.clear(); find.removeAttribute('data-active');
    }
  });
  K.hotkey(K.isSearchKey, function () {
    if (getComputedStyle(sidebar).visibility === 'hidden' || sidebar.offsetParent === null) menu.click();
    window.setTimeout(function () { query.focus(); query.select(); }, 20);
  });
  // The canonical drawer trap predates the search input and details elements.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Tab' || !narrow.matches || !sidebar.classList.contains('open')) return;
    event.stopImmediatePropagation();
    var controls = Array.prototype.filter.call(sidebar.querySelectorAll('a[href], button, input, summary'), function (node) {
      return node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden' && node.tabIndex >= 0;
    });
    var first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, true);

  function addressFigure(variant, currentRegion) {
    var memory = K.memory();
    if (!memory || !memory.storage) return null;
    var blocks = memory.storage.map(function (s) {
      return { name: s.name, base: s.base, last: s.last, note: K.size(s.bytes) + ' installed of ' + K.size(s.reserved_bytes) + ' reserved',
        fill: s.reserved_bytes ? s.bytes / s.reserved_bytes : 0, href: '#/reference/address-map' };
    });
    if (memory.aperture) {
      blocks.push({ name: 'Peripheral aperture', base: memory.aperture.base, last: memory.aperture.base + memory.aperture.bytes - 1,
        note: K.size(memory.aperture.bytes) + ', one reserved region per peripheral', href: '#/reference/address-map',
        regions: (memory.regions || []).slice().sort(function (a, b) { return b.base - a.base; }) });
    }
    blocks.sort(function (a, b) { return b.base - a.base; });
    var rows = [], ceiling = 0xFFFFFFFF;
    blocks.forEach(function (block) {
      if (block.last < ceiling) rows.push({ gap: true, last: ceiling, base: block.last + 1 });
      rows.push(block);
      ceiling = block.base - 1;
    });
    if (ceiling >= 0) rows.push({ gap: true, last: ceiling, base: 0 });

    function bound(value) { return el('span', { class: 'un-map-bound', text: K.hexSpaced(value) }); }
    var list = el('ol', { class: 'un-map-rows' }, rows.map(function (row) {
      if (row.gap) return el('li', { class: 'un-map-gap' }, bound(row.last), el('span', { class: 'un-map-body', text: 'Outside the address map' }));
      return el('li', { class: 'un-map-block' + (row.regions ? ' has-regions' : '') }, bound(row.last),
        el('div', { class: 'un-map-body' },
          el('a', { class: 'un-map-name', href: row.href, text: row.name }),
          el('span', { class: 'un-map-note', text: row.note }),
          row.fill !== undefined ? el('span', { class: 'un-map-meter', 'aria-hidden': 'true' }, el('span', { style: 'width:' + Math.max(1.5, row.fill * 100).toFixed(2) + '%' })) : null,
          row.regions ? el('ol', { class: 'un-map-regions' }, row.regions.map(function (region) {
            return el('li', null, el('a', { href: '#/reference/address-map/' + encodeURIComponent(region.id), 'aria-current': region.id === currentRegion ? 'page' : null },
              el('span', { class: 'un-map-id', text: region.id }), el('span', { class: 'un-map-base', text: K.hexSpaced(region.base) })));
          })) : null));
    }));
    list.appendChild(el('li', { class: 'un-map-floor' }, bound(0)));
    return el('figure', { class: 'un-map' + (variant ? ' un-map-' + variant : '') },
      el('figcaption', null, el('span', { class: 'un-map-title', text: 'Address space' }), el('span', { class: 'un-map-sub', text: 'Highest address first' })),
      list);
  }

  var BEHIND = {
    system: ['#/architecture', '#/tutorials/systems'],
    mmio: ['#/reference/address-map', '#/reference/peripherals'],
    bus: ['#/architecture/system-bus'],
    cache: ['#/architecture/datapath', '#/architecture/caches']
  };

  function stackFigure(layers, caption) {
    var n = layers.length, W = 400, row = window.matchMedia('(max-width: 540px)').matches ? 192 : 112, H = n * row + 20, cx = 168, hw = 150, hh = 70, slab = 9;
    var memory = K.memory() || {};
    var devices = (memory.regions || []).filter(function (r) { return (r.registers || []).length; }).length || 12;
    var drawing = svg('svg', { class: 'un-stack-art', viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true', focusable: 'false' });
    function centre(i) { return 10 + row * (i + 0.5); }
    var plates = [];
    for (var i = n - 1; i >= 0; i--) {
      var cy = centre(i), layer = layers[i];
      var A = [cx - hw, cy], B = [cx, cy - hh], C = [cx + hw, cy], D = [cx, cy + hh];
      var at = (function (A, B, D) {
        // A point on the plate: u runs along its far edge, v along its near edge.
        return function (u, v) { return [A[0] + u * (B[0] - A[0]) + v * (D[0] - A[0]), A[1] + u * (B[1] - A[1]) + v * (D[1] - A[1])]; };
      })(A, B, D);
      var points = function (list) { return list.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); };
      var block = function (u0, u1, v0, v1) { return svg('polygon', { class: 'un-part', points: points([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)]) }); };
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
      var plate = svg('g', { class: 'un-plate', 'data-layer': i, style: '--plate: var(--c-' + layer.color + '); --i: ' + i + '; --lift: ' + ((n - 1) / 2 - i) * (row - 16) + 'px' },
        svg('polygon', { class: 'un-side', points: points([A, D, [D[0], D[1] + slab], [A[0], A[1] + slab]]) }),
        svg('polygon', { class: 'un-side', points: points([D, C, [C[0], C[1] + slab], [D[0], D[1] + slab]]) }),
        svg('polygon', { class: 'un-top', points: points([A, B, C, D]) }),
        parts,
        svg('line', { class: 'un-lead', x1: C[0], y1: C[1], x2: W, y2: C[1] }));
      plates[i] = plate;
      drawing.appendChild(plate);
    }
    function activate(index) { plates.forEach(function (plate, j) { plate.toggleAttribute('data-active', j === index); }); }
    var labels = el('ol', { class: 'un-layers' }, layers.map(function (layer, i) {
      var links = (BEHIND[layer.color] || []).map(K.page).filter(Boolean);
      var item = el('li', { style: '--plate: var(--c-' + layer.color + '); --at: ' + (centre(i) / H * 100).toFixed(2) + '%' },
        el('p', { class: 'un-layer-title' }, links.length ? el('a', { href: links[0].href, text: layer.title }) : layer.title),
        el('p', { class: 'un-layer-sub' + (layer.mono ? ' mono' : ''), text: layer.sub }));
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
    return el('figure', { class: 'un-stack', 'aria-labelledby': 'un-stack-caption' }, el('div', { class: 'un-stack-body' }, drawing, labels),
      caption ? el('figcaption', { id: 'un-stack-caption', text: caption }) : null);
  }

  function composeHome() {
    var art = main.querySelector('.hero-art'), page = main.querySelector(':scope > .page');
    if (!art || !page || page.hasAttribute('data-un')) return;
    var caption = art.querySelector('title').textContent;
    var layers = Array.prototype.map.call(art.querySelectorAll('.ray'), function (ray) {
      var title = ray.querySelector('.ray-title'), sub = ray.querySelector('.ray-sub');
      return { color: (/--c-([a-z]+)/.exec(ray.getAttribute('style') || '') || [])[1] || 'system',
        title: title ? title.textContent : '', sub: sub ? sub.textContent : '', mono: !!sub && sub.classList.contains('mono') };
    });
    page.setAttribute('data-un', 'home');
    var hero = page.querySelector('.hero');
    var description = el('div', { class: 'un-home-description' });
    Array.prototype.slice.call(hero.querySelectorAll('.hero-text > .lede')).forEach(function (paragraph) { description.appendChild(paragraph); });
    hero.querySelector('.hero-text').after(description);
    art.replaceWith(stackFigure(layers, caption));
    var figureBreakpoint = window.matchMedia('(max-width: 540px)');
    function resizeFigure() {
      if (page.isConnected) page.querySelector('.un-stack').replaceWith(stackFigure(layers, caption));
      else figureBreakpoint.removeEventListener('change', resizeFigure);
    }
    figureBreakpoint.addEventListener('change', resizeFigure);
    hero.after(el('section', { class: 'un-routes', 'aria-labelledby': 'un-routes-title' },
      el('h2', { id: 'un-routes-title', text: 'Find your starting point' }),
      el('div', { class: 'un-routes-grid' }, K.paths().map(function (path) {
        return el('section', { class: 'un-route' },
          el('h3', { text: path.id === 'teams' ? 'Industry partners' : path.title }),
          el('p', { text: path.intent }),
          el('ol', null, path.steps.map(function (step) {
            return el('li', null, el('a', { href: step.href, text: step.label }));
          })));
      }))));
  }
  /* The white beam through the prism, on the Architecture overview. The
     figure is drawn in the panel's own pixels: the prism is equilateral at
     any panel shape, and each ray ends level with its layer's label. Every
     layer/contract label comes from this page's own parts list. */
  function architectureBeam() {
    var layers = [
      { color: 'system', part: 'system' },
      { color: 'mmio', part: 'peripherals', contract: 'mmio_if' },
      { color: 'bus', part: 'fabric', contract: 'system_bus_if' },
      { color: 'cache', part: 'tile', contract: 'cache_fabric_if' }
    ];
    function stop(offset, style) { return svg('stop', { offset: offset, style: style }); }
    function line(cls) { return svg('path', { class: cls, pathLength: 1 }); }
    var incoming = svg('g', { class: 'un-beam-in' }, line('halo'), line('core'));
    var prism = svg('polygon', { class: 'un-prism' }), flash = svg('polygon', { class: 'un-prism-flash' }), sheen = line('un-prism-sheen');
    // The dispersed light inside the glass: thin wedges fanning out from the entry
    // point, each the colour of the rays either side of it, so the colours run
    // along the light paths and blend across them.
    var SLICES = 36, fanSlices = [];
    for (var k = 0; k < SLICES; k++) {
      var u = (k + 0.5) / SLICES * (layers.length - 1), a = Math.min(Math.floor(u), layers.length - 2), f = u - a;
      var colour = 'color-mix(in oklab, var(--c-' + layers[a].color + ') ' + ((1 - f) * 100).toFixed(1) + '%, var(--c-' + layers[a + 1].color + '))';
      fanSlices.push(svg('polygon', { style: 'fill: ' + colour + '; stroke: ' + colour }));
    }
    var fan = svg('g', { class: 'un-fan' }, fanSlices);
    var rays = layers.map(function (layer, i) {
      var g = svg('g', { class: 'un-ray', style: '--ray: var(--c-' + layer.color + '); --i: ' + i },
        line('halo'), line('core'), line('flow'), svg('circle', { r: 4.5 }));
      g.addEventListener('click', function () { select(layer.part); });
      return { layer: layer, g: g, inner: svg('path', { class: 'un-inner', pathLength: 1, style: '--ray: var(--c-' + layer.color + '); --i: ' + i }) };
    });
    var drawing = svg('svg', { class: 'un-beam-svg', 'aria-hidden': 'true', focusable: 'false' },
      svg('defs', null,
        svg('linearGradient', { id: 'un-beam-glass', x1: 0, y1: 0, x2: 1, y2: 1 },
          stop(0, 'stop-color: var(--ink); stop-opacity: 0.16'), stop(1, 'stop-color: var(--ink); stop-opacity: 0.03'))),
      incoming, prism, fan, rays.map(function (r) { return r.inner; }), sheen, flash, rays.map(function (r) { return r.g; }));
    var art = el('div', { class: 'un-beam-art' }, drawing);

    function at(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
    function pts(list) { return list.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); }
    function d(a, b) { return 'M' + pts([a]) + ' L' + pts([b]); }
    function draw() {
      var box = art.getBoundingClientRect(), W = box.width, H = box.height;
      if (!W || !H) return;
      drawing.setAttribute('viewBox', '0 0 ' + W.toFixed(1) + ' ' + H.toFixed(1));
      var ys = Array.prototype.map.call(labels.children, function (li) { var r = (li.querySelector('button') || li).getBoundingClientRect(); return r.top + r.height / 2 - box.top; });
      var mid = (ys[0] + ys[ys.length - 1]) / 2;
      var side = Math.min(W * (W < 300 ? 0.68 : 0.56), H * 0.82 / (Math.sqrt(3) / 2)), h = side * Math.sqrt(3) / 2;
      var cx = W * (W < 300 ? 0.4 : 0.38), apex = [cx, mid - h / 2], left = [cx - side / 2, mid + h / 2], right = [cx + side / 2, mid + h / 2];
      // White light enters the left face rising slightly, and leaves the right face
      // dispersed: the least-bent colour (system) highest, the most-bent lowest.
      var entry = at(apex, left, 0.56), exits = rays.map(function (r, i) { return at(apex, right, 0.4 + i * 0.075); });
      var start = [0, Math.min(H - 6, entry[1] + entry[0] * 0.24)];
      incoming.querySelectorAll('path').forEach(function (path) { path.setAttribute('d', d(start, entry)); });
      prism.setAttribute('points', pts([apex, right, left]));
      flash.setAttribute('points', pts([apex, right, left]));
      sheen.setAttribute('d', d(at(apex, left, 0.12), at(apex, left, 0.4)));
      sheen.setAttribute('transform', 'translate(' + (side * 0.035).toFixed(1) + ' 0)');
      var first = exits[0], last = exits[exits.length - 1];
      fanSlices.forEach(function (slice, k) {
        slice.setAttribute('points', pts([entry, at(first, last, k / SLICES), at(first, last, (k + 1) / SLICES)]));
      });
      rays.forEach(function (r, i) {
        var end = [W - 5, ys[i]];
        r.inner.setAttribute('d', d(entry, exits[i]));
        r.g.querySelectorAll('path').forEach(function (path) { path.setAttribute('d', d(exits[i], end)); });
        var dot = r.g.querySelector('circle'); dot.setAttribute('cx', end[0]); dot.setAttribute('cy', end[1]);
      });
    }
    // Pointing at a layer, here or in its label, lights its ray; a selected layer stays lit.
    var pointed = null;
    function emphasise() {
      var selected = null;
      controls.some(function (button) { if (button.getAttribute('aria-pressed') === 'true') { selected = button.dataset.part; return true; } });
      function owns(r, key) { return !!key && (r.layer.part === key || r.layer.contract === key); }
      rays.forEach(function (r) {
        r.g.toggleAttribute('data-active', owns(r, pointed));
        r.g.toggleAttribute('data-selected', owns(r, selected));
      });
      body.toggleAttribute('data-focus', !!pointed);
    }
    rays.forEach(function (r) {
      r.g.addEventListener('mouseenter', function () { pointed = r.layer.part; emphasise(); });
      r.g.addEventListener('mouseleave', function () { pointed = null; emphasise(); });
    });
    var controls = [];
    function select(key) {
      var target = main.querySelector('.arch-part[data-part="' + key + '"], .arch-seam[data-part="' + key + '"]');
      if (target) {
        target.click();
        var detail = main.querySelector('#arch-detail');
        detail.setAttribute('tabindex', '-1');
        detail.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        detail.focus({ preventScroll: true });
      }
    }
    function partButton(key, contract) {
      var name = main.querySelector('#part-' + key + ' .name');
      if (!name) return null;
      var button = el('button', { type: 'button', class: 'un-beam-label' + (contract ? ' mono' : ''),
        'data-part': key, 'aria-controls': 'arch-detail', 'aria-pressed': 'false', text: name.textContent,
        onclick: function () { select(key); } });
      controls.push(button);
      return button;
    }
    var labels = el('ol', { class: 'un-beam-labels' }, layers.map(function (layer, i) {
      var item = el('li', { style: '--ray: var(--c-' + layer.color + '); --i: ' + i }, partButton(layer.part), layer.contract ? partButton(layer.contract, true) : null);
      item.addEventListener('mouseenter', function () { pointed = layer.part; emphasise(); });
      item.addEventListener('focusin', function () { pointed = layer.part; emphasise(); });
      item.addEventListener('mouseleave', function () { pointed = null; emphasise(); });
      item.addEventListener('focusout', function () { pointed = null; emphasise(); });
      return item;
    }));
    var body = el('div', { class: 'un-beam-body' }, art, labels);
    // Reflect selection made either here or in the canonical diagram.
    function syncSelection() {
      controls.forEach(function (button) {
        var target = main.querySelector('.arch-part[data-part="' + button.dataset.part + '"], .arch-seam[data-part="' + button.dataset.part + '"]');
        button.setAttribute('aria-pressed', target ? target.getAttribute('aria-pressed') : 'false');
      });
      emphasise();
    }
    syncSelection();
    var observer = new MutationObserver(syncSelection);
    observer.observe(main.querySelector('.arch'), { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
    var sizes = new ResizeObserver(draw);
    sizes.observe(art); sizes.observe(labels);
    stopBeam = function () { observer.disconnect(); sizes.disconnect(); };
    return body;
  }
  function composeArchitecture(now) {
    if (now.path !== 'architecture' || main.querySelector('.un-beam')) return;
    var overview = main.querySelector('.architecture-overview');
    if (!overview) return;
    var intro = overview.querySelector(':scope > .lede');
    var figure = el('figure', { class: 'un-beam' }, architectureBeam(),
      el('figcaption', { text: 'One firmware address space, configurable hardware layers.' }));
    var opening = el('div', { class: 'un-architecture-intro' }, intro, figure);
    overview.prepend(opening);
    // The sequence plays once the figure is laid out, so it starts from the drawn geometry.
    requestAnimationFrame(function () { figure.setAttribute('data-play', ''); });
  }
  function composeAddress(now) {
    if (now.href !== '#/reference/address-map' || main.querySelector('.un-map-panel')) return;
    var page = main.querySelector(':scope > .page'), figure = addressFigure('page', now.param);
    if (!page || !figure) return;
    // The page's canonical introduction explains reservation vs installation.
    // Region deep links open at their registers, with this overview folded.
    var panel = el('details', { class: 'un-map-panel', open: !now.param },
      el('summary', { text: 'Address space overview' }), figure);
    var intro = page.querySelector(':scope > .section-intro');
    if (intro) intro.after(panel); else page.appendChild(panel);
  }
  function composeGuideIndex(now) {
    if (now.path !== 'guides') return;
    var list = main.querySelector(':scope > .page > ul.next-list');
    if (!list) return;
    list.replaceWith(el('div', { class: 'un-index' }, K.guideGroups().map(function (group) {
      return el('section', null, el('h2', { text: group.title }), el('ul', null, group.items.map(function (guide) {
        return el('li', null, el('a', { href: guide.href, text: guide.label }), el('span', { text: guide.summary }));
      })));
    })));
  }

  /* Previous/next follows the complete contents tree above. */
  function pagerLink(stop, direction) {
    return stop ? el('a', { href: stop.href, rel: direction === 'Next' ? 'next' : 'prev' },
      el('span', { class: 'un-pager-way', text: direction === 'Next' ? 'Next →' : '← Previous' }),
      el('span', { class: 'un-pager-title', text: stop.label })) : el('span');
  }
  function renderPager(now) {
    var index = -1;
    sequence.forEach(function (stop, i) { if (stop.href === now.href) index = i; });
    pager.hidden = index < 0;
    pager.replaceChildren(pagerLink(index > 0 ? sequence[index - 1] : null, 'Previous'),
      pagerLink(index >= 0 ? sequence[index + 1] : null, 'Next'));
  }
  function renderTrail(now) {
    var steps = [{ href: '#/', label: 'Home' }].concat(now.trail);
    if (now.home) steps = [{ label: 'Overview' }];
    if (!now.page && !now.home) steps.push({ label: (main.querySelector('h1') || {}).textContent || 'Page' });
    trail.replaceChildren();
    steps.forEach(function (step, i) {
      var last = i === steps.length - 1;
      trail.appendChild(el('li', null, step.href && !last ? el('a', { href: step.href, text: step.label })
        : el('span', { 'aria-current': last ? 'page' : null, text: step.label })));
    });
    var ancestry = now.page ? [now.page.href].concat(now.page.parents.slice().reverse()) : [];
    var status = ancestry.map(K.page).filter(function (page) { return page && page.tag; })[0];
    if (status) trail.lastElementChild.appendChild(el('span', { class: 'un-tag un-trail-status', text: status.tag }));
  }
  function composeContents() {
    Array.prototype.forEach.call(main.querySelectorAll('.page-contents'), function (contents) {
      if (contents.closest('.un-inline-contents')) return;
      var fold = el('details', { class: 'un-inline-contents' }, el('summary', { text: 'On this page' }));
      contents.before(fold);
      fold.appendChild(contents);
      contents.addEventListener('click', function (event) {
        if (event.target.closest('a')) fold.open = false;
      }, true);
    });
  }
  function revealCurrent(now) {
    if (now.home) { sidebar.scrollTop = 0; return; }
    var active = tree.querySelector('[aria-current="page"]');
    if (!active) return;
    var item = active.getBoundingClientRect(), bounds = sidebar.getBoundingClientRect();
    var top = find.getBoundingClientRect().bottom + 24;
    if (item.bottom > bounds.bottom - 24) sidebar.scrollTop += item.bottom - bounds.bottom + 40;
    else if (item.top < top) sidebar.scrollTop += item.top - top;
  }
  var stopSpy = null;
  function renderRail(now) {
    if (stopSpy) stopSpy();
    rail.replaceChildren();
    var entries = now.home ? [] : K.outline('h2, h3');
    rail.hidden = entries.length < 2;
    document.documentElement.toggleAttribute('data-rail', !rail.hidden);
    if (rail.hidden) return;
    rail.appendChild(el('p', { class: 'un-rail-title', text: 'On this page' }));
    rail.appendChild(K.outlineList(entries, { class: 'un-outline' }));
    stopSpy = K.spy(entries, function (active) {
      entries.forEach(function (entry, i) { entry.link.toggleAttribute('data-active', i === active); });
    });
  }
  K.onRender(function (now) {
    if (stopBeam) { stopBeam(); stopBeam = null; }
    if (now.home) composeHome();
    composeArchitecture(now);
    composeAddress(now);
    composeGuideIndex(now);
    composeContents();
    if (/^local\//.test(now.path)) {
      var localTitle = main.querySelector('.doc-result > h2');
      if (localTitle) localTitle.replaceWith(el('h1', { id: 'page-title', tabindex: '-1', text: localTitle.textContent }));
    }
    renderTrail(now);
    K.markCurrent(tree);
    Array.prototype.forEach.call(tree.querySelectorAll('details'), function (fold) {
      if (fold.querySelector('[aria-current="page"]')) fold.open = true;
    });
    openCurrentBranches();
    revealCurrent(now);
    renderPager(now);
    renderRail(now);
    if (now.fragment && now.section === 'guides' && window.PrismGuides) window.PrismGuides.reveal(now.fragment);
  });
  K.start();
})();
