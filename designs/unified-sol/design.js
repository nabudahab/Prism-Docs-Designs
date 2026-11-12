/* Unified Sol: one documentation shell over the canonical renderer.
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
  function branch(items) {
    return el('ul', null, items.map(function (item) {
      return el('li', null, navLink(item), item.children ? branch(item.children) : null);
    }));
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
    [cx - hw, cx, cx + hw].forEach(function (x) {
      drawing.appendChild(svg('line', { class: 'un-axis', x1: x, x2: x, y1: centre(0), y2: centre(n - 1) + (x === cx ? hh : 0) }));
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
  /* Canonical beam geometry, independent of the home view and router.
     Every layer/contract label comes from this page's own parts list. */
  function architectureBeam() {
    var layers = [
      { color: 'system', part: 'system', exit: [285, 170], end: [410, 62] },
      { color: 'mmio', part: 'peripherals', contract: 'mmio_if', exit: [291.6, 185.6], end: [410, 142] },
      { color: 'bus', part: 'fabric', contract: 'system_bus_if', exit: [298.2, 201.2], end: [410, 222] },
      { color: 'cache', part: 'tile', contract: 'cache_fabric_if', exit: [304.8, 216.8], end: [410, 302] }
    ];
    function pt(point) { return point.join(','); }
    var drawing = svg('svg', { class: 'hero-art', viewBox: '0 30 464 305', 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'none' },
      svg('defs', null, svg('linearGradient', { id: 'un-beam-fan', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 170, x2: 0, y2: 216.8 },
        layers.map(function (layer, i) { return svg('stop', { offset: i / 3, 'stop-color': 'var(--c-' + layer.color + ')' }); }))),
      svg('path', { class: 'beam', pathLength: 1, d: 'M0,236 L206,191' }),
      svg('g', { transform: 'translate(40 0)' },
        svg('polygon', { class: 'fan', points: '166,191 285,170 304.8,216.8', fill: 'url(#un-beam-fan)' }),
        svg('path', { class: 'prism', d: 'M230,40 L340,300 L120,300 Z' })),
      layers.map(function (layer, i) {
        return svg('g', { class: 'ray', style: '--ray: var(--c-' + layer.color + '); --i: ' + i },
          svg('path', { pathLength: 1, d: 'M' + pt([layer.exit[0] + 40, layer.exit[1]]) + ' L' + pt([layer.end[0] + 40, layer.end[1]]) }),
          svg('circle', { cx: layer.end[0] + 40, cy: layer.end[1], r: 4.5 }));
      }));
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
    var labels = el('ol', { class: 'un-beam-labels' }, layers.map(function (layer) {
      return el('li', { style: '--ray: var(--c-' + layer.color + ')' }, partButton(layer.part), layer.contract ? partButton(layer.contract, true) : null);
    }));
    // Reflect selection made either here or in the canonical diagram.
    function syncSelection() {
      controls.forEach(function (button) {
        var target = main.querySelector('.arch-part[data-part="' + button.dataset.part + '"], .arch-seam[data-part="' + button.dataset.part + '"]');
        button.setAttribute('aria-pressed', target ? target.getAttribute('aria-pressed') : 'false');
      });
    }
    syncSelection();
    var observer = new MutationObserver(syncSelection);
    observer.observe(main.querySelector('.arch'), { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
    stopBeam = function () { observer.disconnect(); };
    return el('div', { class: 'un-beam-body' }, drawing, labels);
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
    revealCurrent(now);
    renderPager(now);
    renderRail(now);
    if (now.fragment && now.section === 'guides' && window.PrismGuides) window.PrismGuides.reveal(now.fragment);
  });
  K.start();
})();
