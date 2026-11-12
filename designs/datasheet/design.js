/* Datasheet: the reference-manual shell. A full contents tree on the left, the
   page in the middle and, on reading pages, an outline with the address space
   on the right. Everything here is navigation and layout; page content is the
   canonical render in #main. */
(function () {
  'use strict';
  var K = window.PrismKit, el = K.el;
  var main = K.main;
  var tree = document.getElementById('ds-tree');
  var trail = document.getElementById('ds-trail');
  var inspector = document.getElementById('ds-inspector');

  /* ---------- Contents tree ---------- */

  var ORDER = ['start', 'reference', 'architecture', 'tutorials', 'guides', 'tools', 'project', 'more'];

  function navLink(item) {
    return el('a', { href: item.href }, el('span', { text: item.label }), item.tag ? el('span', { class: 'ds-tag', text: item.tag }) : null);
  }
  function branch(items) {
    return el('ul', null, items.map(function (item) {
      return el('li', null, navLink(item), item.children ? branch(item.children) : null);
    }));
  }
  function buildTree() {
    var sections = K.sections();
    ORDER.forEach(function (id) {
      var section = sections.filter(function (s) { return s.id === id; })[0];
      if (!section) return;
      var titleId = 'ds-group-' + id;
      var body;
      if (id === 'guides') {
        body = el('div', { class: 'ds-folds' },
          el('ul', null, el('li', null, navLink({ href: '#/guides', label: 'All guides' }))),
          section.groups.map(function (group, i) {
            return el('details', { class: 'ds-fold', open: i === 0 },
              el('summary', null, el('span', { text: group.title }), el('span', { class: 'ds-count', text: String(group.items.length) })),
              branch(group.items));
          }));
      } else body = branch(section.items);
      tree.appendChild(el('section', { class: 'ds-group', 'aria-labelledby': titleId },
        el('p', { class: 'ds-group-title', id: titleId, text: section.title }), body));
    });
  }

  /* ---------- Find: pages, sections, registers and addresses ---------- */

  var palette = document.getElementById('ds-palette');
  var query = document.getElementById('ds-query');
  var box = K.combobox(query, document.getElementById('ds-results'), {
    limit: 14,
    status: document.getElementById('ds-palette-status'),
    hint: 'Type a page, guide section, register or field name, or an address such as 0x40020008.',
    render: function (result) {
      return [el('span', { class: 'ds-kind', text: result.kind }), el('span', { class: 'ds-hit', text: result.label }),
        el('span', { class: 'ds-detail', text: result.detail })];
    },
    onPick: function () { palette.close(); }
  });
  function openPalette() {
    if (palette.open) return;
    box.clear();
    palette.showModal();
    query.focus();
  }
  document.getElementById('ds-find').addEventListener('click', openPalette);
  document.getElementById('ds-palette-close').addEventListener('click', function () { palette.close(); });
  palette.addEventListener('click', function (event) { if (event.target === palette) palette.close(); });
  K.hotkey(K.isSearchKey, openPalette);

  /* ---------- Address space figure, from the generated memory map ---------- */

  function addressFigure(variant) {
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

    function bound(value) { return el('span', { class: 'ds-map-bound', text: K.hexSpaced(value) }); }
    var list = el('ol', { class: 'ds-map-rows' }, rows.map(function (row) {
      if (row.gap) return el('li', { class: 'ds-map-gap' }, bound(row.last), el('span', { class: 'ds-map-body', text: 'Outside the address map' }));
      return el('li', { class: 'ds-map-block' + (row.regions ? ' has-regions' : '') }, bound(row.last),
        el('div', { class: 'ds-map-body' },
          el('a', { class: 'ds-map-name', href: row.href, text: row.name }),
          el('span', { class: 'ds-map-note', text: row.note }),
          row.fill !== undefined ? el('span', { class: 'ds-map-meter', 'aria-hidden': 'true' }, el('span', { style: 'width:' + Math.max(1.5, row.fill * 100).toFixed(2) + '%' })) : null,
          row.regions ? el('ol', { class: 'ds-map-regions' }, row.regions.map(function (region) {
            return el('li', null, el('a', { href: '#/reference/address-map/' + encodeURIComponent(region.id) },
              el('span', { class: 'ds-map-id', text: region.id }), el('span', { class: 'ds-map-base', text: K.hexSpaced(region.base) })));
          })) : null));
    }));
    list.appendChild(el('li', { class: 'ds-map-floor' }, bound(0)));
    return el('figure', { class: 'ds-map' + (variant ? ' ds-map-' + variant : '') },
      el('figcaption', null, el('span', { class: 'ds-map-title', text: 'Address space' }), el('span', { class: 'ds-map-sub', text: 'Highest address first' })),
      list);
  }

  /* ---------- Per page: breadcrumb, outline, landing ---------- */

  var stopSpy = null;
  function renderInspector(now) {
    if (stopSpy) { stopSpy(); stopSpy = null; }
    inspector.replaceChildren();
    var entries = now.home ? [] : K.outline('h2, h3');
    var figure = now.section === 'reference' && !now.home ? addressFigure('rail') : null;
    inspector.hidden = !entries.length && !figure;
    document.documentElement.toggleAttribute('data-inspector', !inspector.hidden);
    if (entries.length) {
      inspector.appendChild(el('p', { class: 'ds-rail-title', text: 'On this page' }));
      inspector.appendChild(K.outlineList(entries, { class: 'ds-outline' }));
      stopSpy = K.spy(entries, function (active) {
        entries.forEach(function (entry, i) { entry.link.toggleAttribute('data-active', i === active); });
      });
    }
    if (figure) inspector.appendChild(figure);
  }

  function renderTrail(now) {
    trail.replaceChildren();
    now.trail.forEach(function (step, i) {
      var last = i === now.trail.length - 1;
      trail.appendChild(el('li', null, step.href && !last ? el('a', { href: step.href, text: step.label })
        : el('span', { 'aria-current': last ? 'page' : null, text: step.label })));
    });
  }

  function composeHome() {
    var page = main.querySelector(':scope > .page');
    var hero = page && page.querySelector('.hero');
    if (!hero || page.hasAttribute('data-ds')) return;
    page.setAttribute('data-ds', 'home');
    var figure = addressFigure('home');
    var art = hero.querySelector('.hero-art');
    if (figure && art) art.replaceWith(figure);
    var routes = el('section', { class: 'ds-routes', 'aria-labelledby': 'ds-routes-title' },
      el('h2', { id: 'ds-routes-title', text: 'Routes by reader' }),
      el('div', { class: 'ds-routes-grid' }, K.paths().map(function (path) {
        return el('div', { class: 'ds-route' }, el('h3', { text: path.title }), el('p', { text: path.intent }),
          el('ol', null, path.steps.map(function (step) { return el('li', null, el('a', { href: step.href, text: step.label })); })));
      })));
    var tasks = page.querySelector('.home-tasks');
    if (tasks) tasks.after(routes); else page.appendChild(routes);
  }

  // The guide index as a grouped lookup table with each guide's stated goal.
  function composeGuideIndex(now) {
    if (now.path !== 'guides') return;
    var list = main.querySelector(':scope > .page > ul.next-list');
    if (!list) return;
    list.replaceWith(el('div', { class: 'ds-index' }, K.guideGroups().map(function (group) {
      return el('section', null, el('h2', { text: group.title }),
        el('ul', null, group.items.map(function (guide) {
          return el('li', null, el('a', { href: guide.href, text: guide.label }), el('span', { text: guide.summary }));
        })));
    })));
  }

  buildTree();
  K.onRender(function (now) {
    renderTrail(now);
    K.markCurrent(tree);
    Array.prototype.forEach.call(tree.querySelectorAll('details'), function (fold) {
      if (fold.querySelector('[aria-current="page"]')) fold.open = true;
    });
    if (now.home) composeHome();
    composeGuideIndex(now);
    renderInspector(now);
    if (palette.open) palette.close();
  });
  K.start();
})();
