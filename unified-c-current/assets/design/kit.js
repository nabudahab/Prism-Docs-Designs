/* Shared runtime for the Prism design prototypes (designs/README.md).

   The canonical site (site/assets/app.js and its data files) renders every
   page into #main exactly as it does on the current site. This kit runs after
   it and gives a design shell what it needs to present that content its own
   way: a model of the site's pages, the current route, an outline of the
   rendered page, a search index over the generated data and a hook that fires
   after each canonical render.

   Nothing here holds documentation. Page lists come from the canonical
   navigation (data/nav.js, parsed from site/index.html at build time), guide
   titles and summaries from PRISM_GUIDES, tutorials from PRISM_TUTORIALS and
   the address map from PRISM_REFERENCE. Text is only ever inserted as text. */
(function () {
  'use strict';

  var NAV = (window.PRISM_NAV && window.PRISM_NAV.groups) || [];
  var main = document.getElementById('main');

  /* ---------- DOM helpers ---------- */

  function fill(node, kids) {
    kids.forEach(function (kid) {
      if (kid === undefined || kid === null || kid === false) return;
      if (Array.isArray(kid)) fill(node, kid);
      else node.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
    });
    return node;
  }
  function setProps(node, props, svgNode) {
    Object.keys(props || {}).forEach(function (key) {
      var value = props[key];
      if (value === undefined || value === null || value === false) return;
      if (key === 'text') node.textContent = value;
      else if (key === 'class' && !svgNode) node.className = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    });
    return node;
  }
  function el(tag, props) {
    return fill(setProps(document.createElement(tag), props), Array.prototype.slice.call(arguments, 2));
  }
  function svg(tag, props) {
    return fill(setProps(document.createElementNS('http://www.w3.org/2000/svg', tag), props, true), Array.prototype.slice.call(arguments, 2));
  }

  function hex(n, digits) {
    var s = (n >>> 0).toString(16).toUpperCase();
    while (s.length < (digits || 8)) s = '0' + s;
    return '0x' + s;
  }
  function hexSpaced(n) { var s = hex(n); return s.slice(0, 6) + ' ' + s.slice(6); }
  function size(bytes) {
    var units = ['bytes', 'KiB', 'MiB', 'GiB'], value = bytes, unit = 0;
    while (value >= 1024 && value % 1024 === 0 && unit < units.length - 1) { value /= 1024; unit++; }
    return unit === 0 ? bytes + (bytes === 1 ? ' byte' : ' bytes') : value + ' ' + units[unit];
  }

  /* ---------- Site model ---------- */

  // Navigation grouping for the generated guides. A guide Prism adds later
  // that is not listed here appears under the last group, so nothing is lost.
  var GUIDE_GROUPS = [
    ['First steps', ['getting-started', 'nexys_video_quickstart']],
    ['Configure and build', ['configuration', 'build-system', 'manifests']],
    ['Hardware', ['architecture', 'cores', 'hazard3', 'adding-a-core', 'interfaces', 'memory']],
    ['Peripherals', ['peripherals', 'integration', 'i2c', 'qspi', 'watchdog', 'adc', 'can', 'dma']],
    ['Board and firmware', ['fpga', 'firmware', 'uart_upload']],
    ['Verify and measure', ['verification', 'test-catalog', 'experiments', 'development']]
  ];
  var OTHER_GUIDES = 'More guides';

  // One-line menu descriptions for the hand-written pages, phrased from the
  // canonical page ledes and tab captions. Guides and tutorials supply their own.
  var NOTES = {
    '#/': 'What Prism is and where to start',
    '#/guides': 'Every guide, from first steps to verification',
    '#/architecture': 'A SoC’s parts and the interfaces between them',
    '#/architecture/datapath': 'Each core cycle by cycle, with your own program',
    '#/architecture/caches': 'Hits, misses, refills and write-backs',
    '#/architecture/coherent-bus': 'Shared coherent memory for several tiles',
    '#/architecture/system-bus': 'RAM, ROM, peripherals and interrupts',
    '#/architecture/accelerators': 'MMIO commands and coherent data',
    '#/reference/address-map': 'Storage, reserved regions, registers and interrupts',
    '#/reference/peripherals': 'Protocol and integration background',
    '#/reference/platformio': 'Project options, packages and toolchain',
    '#/tools/peripheral-docs': 'A register reference from your own TOML',
    '#/tools/peripheral-docs-contract': 'What the generator reads and writes',
    '#/roadmap': 'Implemented, in development and planned'
  };

  var SECTION_TITLES = { start: 'Start', tutorials: 'Tutorials', architecture: 'Architecture', guides: 'Guides',
    reference: 'Reference', tools: 'Tools', project: 'Project', more: 'More' };
  var SECTION_ORDER = ['start', 'tutorials', 'architecture', 'guides', 'reference', 'tools', 'project', 'more'];

  function pathOf(href) { return String(href || '').replace(/^#\/?/, '').split('#')[0].replace(/\/+$/, ''); }
  function sectionOf(path) {
    if (path === '') return 'start';
    var head = path.split('/')[0];
    return { guides: 'guides', tutorials: 'tutorials', architecture: 'architecture', reference: 'reference',
      tools: 'tools', local: 'tools', roadmap: 'project' }[head] || 'more';
  }

  function plainText(nodes) {
    return (nodes || []).map(function (node) {
      if (typeof node === 'string') return node;
      if (node.t === 'code') return node.v;
      return node.c ? plainText(node.c) : '';
    }).join('');
  }
  function firstSentence(text) {
    var clean = String(text || '').replace(/\s+/g, ' ').trim();
    var stop = clean.search(/[.!?](\s|$)/);
    return stop > 20 ? clean.slice(0, stop + 1) : clean;
  }

  var guideCache = null;
  function guides() {
    if (guideCache) return guideCache;
    var data = window.PRISM_GUIDES || { order: [], guides: {} };
    var groupOf = {};
    GUIDE_GROUPS.forEach(function (group) { group[1].forEach(function (key) { groupOf[key] = group[0]; }); });
    guideCache = (data.order || []).map(function (entry) {
      var guide = data.guides[entry.key] || { blocks: [] };
      var lead = guide.blocks.filter(function (block, i) { return i > 0 && block.t === 'p'; })[0];
      return { key: entry.key, href: '#/guides/' + entry.key, label: entry.title, kind: 'guide',
        group: groupOf[entry.key] || OTHER_GUIDES, summary: lead ? firstSentence(plainText(lead.c)) : '' };
    });
    return guideCache;
  }
  function guideGroups() {
    var names = GUIDE_GROUPS.map(function (group) { return group[0]; }).concat(OTHER_GUIDES);
    return names.map(function (name) {
      // Keep the listed order inside a group; unlisted guides keep Prism's order.
      var listed = (GUIDE_GROUPS.filter(function (group) { return group[0] === name; })[0] || [null, []])[1];
      var items = guides().filter(function (guide) { return guide.group === name; });
      items.sort(function (a, b) {
        var ia = listed.indexOf(a.key), ib = listed.indexOf(b.key);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      });
      return { title: name, items: items };
    }).filter(function (group) { return group.items.length; });
  }

  function tutorials() {
    var data = window.PRISM_TUTORIALS || {};
    return Object.keys(data).map(function (key) {
      var t = data[key];
      return { key: key, href: '#/tutorials/' + key, label: t.nav_title || t.title, title: t.title, kind: 'tutorial',
        summary: t.lede, audience: t.audience, outcome: t.outcome, stages: t.stages || [] };
    });
  }

  // The canonical navigation as a tree of { href, label, tag, children }.
  function navItems() {
    var out = [];
    NAV.forEach(function (group) { (group.items || []).forEach(function (item) { out.push(item); }); });
    return out;
  }
  function walk(items, visit, parents) {
    (items || []).forEach(function (item) {
      visit(item, parents || []);
      walk(item.children, visit, (parents || []).concat(item));
    });
  }

  var pageCache = null;
  function pages() {
    if (pageCache) return pageCache;
    var byHref = {}, list = [];
    function add(page) {
      if (byHref[page.href]) { Object.keys(page).forEach(function (k) { if (page[k] && !byHref[page.href][k]) byHref[page.href][k] = page[k]; }); return; }
      byHref[page.href] = page; list.push(page);
    }
    var lessons = {};
    tutorials().forEach(function (t) { lessons[t.href] = t; });
    walk(navItems(), function (item, parents) {
      var lesson = lessons[item.href];
      add({ href: item.href, label: item.label, tag: item.tag || null, kind: lesson ? 'tutorial' : 'page',
        section: sectionOf(pathOf(item.href)), parents: parents.map(function (p) { return p.href; }),
        summary: lesson ? lesson.summary : NOTES[item.href] || '' });
    });
    tutorials().forEach(function (t) { add({ href: t.href, label: t.label, kind: 'tutorial', section: 'tutorials', parents: [], summary: t.summary }); });
    guides().forEach(function (g) {
      // A guide keeps its own title; a shorter label the canonical navigation
      // gives it stays searchable as an alias.
      var listed = byHref[g.href];
      if (listed) { listed.alias = listed.label; listed.label = g.label; listed.kind = 'guide'; listed.parents = ['#/guides']; listed.summary = g.summary; listed.group = g.group; }
      else add({ href: g.href, label: g.label, kind: 'guide', section: 'guides', parents: ['#/guides'], summary: g.summary, group: g.group });
    });
    pageCache = { list: list, byHref: byHref };
    return pageCache;
  }
  function page(href) { return pages().byHref[href] || null; }
  function label(href) { var p = page(href); return p ? p.label : pathOf(href); }

  // The site as sections, grouped by route namespace so that a page the
  // canonical navigation gains later lands in the right section by itself.
  function sections() {
    var buckets = {};
    SECTION_ORDER.forEach(function (id) { buckets[id] = { id: id, title: SECTION_TITLES[id], items: [] }; });
    navItems().forEach(function (item) {
      var id = sectionOf(pathOf(item.href));
      if (id === 'guides') return; // listed from the generated guides instead
      buckets[id].items.push(item);
    });
    buckets.guides.href = '#/guides';
    buckets.guides.groups = guideGroups();
    buckets.guides.items = guides();
    return SECTION_ORDER.map(function (id) { return buckets[id]; }).filter(function (s) { return s.items.length; });
  }
  function section(id) { return sections().filter(function (s) { return s.id === id; })[0] || null; }

  /* ---------- Current route ---------- */

  function route() {
    var hash = location.hash || '#/';
    if (hash.indexOf('#/') !== 0) hash = '#/';
    var rest = hash.slice(2), fragment = null;
    if (rest.indexOf('#') !== -1) { fragment = rest.slice(rest.indexOf('#') + 1); rest = rest.slice(0, rest.indexOf('#')); }
    var path = rest.replace(/\/+$/, '');
    // Longest known page that is this path or a prefix of it.
    var known = pages().byHref, parts = path.split('/'), href = null, param = null;
    for (var n = parts.length; n >= 0 && href === null; n--) {
      var candidate = '#/' + parts.slice(0, n).join('/');
      if (known[candidate]) { href = candidate; param = parts.slice(n).join('/') || null; }
    }
    // The datapath tab shows one of the core pages; the address map and the
    // bus page take a region name. Decode it for display.
    try { if (param) param = decodeURIComponent(param); } catch (error) { /* keep the raw text */ }
    var current = href ? known[href] : null;
    var trail = [];
    if (current) {
      var id = current.section;
      if (id !== 'start') trail.push({ label: SECTION_TITLES[id], href: (section(id) || {}).href || (id === 'architecture' ? '#/architecture' : null) });
      current.parents.forEach(function (parent) { if (known[parent] && parent !== '#/guides' && parent !== '#/architecture') trail.push({ label: known[parent].label, href: parent }); });
      if (!(id === 'architecture' && href === '#/architecture')) trail.push({ label: current.label, href: href });
      if (param && id !== 'guides') trail.push({ label: param, href: null });
    }
    return { hash: hash, path: path, fragment: fragment, href: href, param: param, page: current,
      section: current ? current.section : sectionOf(path), home: path === '', trail: trail };
  }

  // Mark links for the current page inside a design's own navigation.
  function markCurrent(root) {
    var now = route();
    var ancestors = now.page ? now.page.parents : [];
    Array.prototype.forEach.call(root.querySelectorAll('a[href^="#/"]'), function (a) {
      var href = a.getAttribute('href');
      if (href === now.href) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      a.toggleAttribute('data-within', ancestors.indexOf(href) !== -1);
    });
  }

  var renderHooks = [];
  function runHooks() {
    var now = route(), root = document.documentElement;
    root.setAttribute('data-section', now.section);
    root.setAttribute('data-route', now.path || 'home');
    root.toggleAttribute('data-wide', !!main.querySelector(':scope > .page-wide, :scope > .layer-page'));
    renderHooks.forEach(function (fn) {
      try { fn(now); } catch (error) { if (window.console) console.error('Design hook failed', error); }
    });
  }
  function onRender(fn) { renderHooks.push(fn); }

  /* ---------- Outline of the rendered page ---------- */

  var WIDGETS = '.cd, .cx, .coh, .sb, .core-editor-slot, .doc-preview, .notice, .arch-wrap, .peripheral-sequence, [hidden]';
  function outline(levels) {
    var guide = main.querySelector('.guide');
    var key = guide ? guide.getAttribute('data-guide') : null;
    return Array.prototype.filter.call(main.querySelectorAll(levels || 'h2, h3'), function (heading) {
      return !heading.closest(WIDGETS) && !heading.classList.contains('visually-hidden') && heading.offsetParent !== null;
    }).map(function (heading) {
      return { node: heading, level: Number(heading.tagName.slice(1)), text: heading.textContent.trim(),
        href: key && heading.id ? '#/guides/' + key + '#' + heading.id : null };
    });
  }
  function reveal(entry) {
    // Guide sections keep their shareable address; other headings just scroll.
    if (entry.href && window.PrismGuides) {
      try { history.pushState(null, '', entry.href); } catch (error) { /* file:// may refuse */ }
      window.PrismGuides.reveal(entry.node.id);
      return;
    }
    entry.node.setAttribute('tabindex', '-1');
    entry.node.scrollIntoView({ block: 'start' });
    entry.node.focus({ preventScroll: true });
  }
  function outlineList(entries, options) {
    options = options || {};
    var list = el('ol', { class: options.class || 'kit-outline' }, entries.map(function (entry) {
      var link = el('a', { href: entry.href || location.hash || '#/', 'data-level': entry.level, text: entry.text });
      link.addEventListener('click', function (event) {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); reveal(entry);
        if (options.onPick) options.onPick(entry);
      });
      entry.link = link;
      return el('li', { 'data-level': entry.level }, link);
    }));
    return list;
  }
  // Follow the reading position: calls back with the index of the last
  // heading above the top third of the window. Returns a stop function.
  function spy(entries, callback) {
    if (!entries.length) return function () {};
    var frame = 0;
    function measure() {
      frame = 0;
      var line = window.innerHeight * 0.3, active = -1;
      entries.forEach(function (entry, i) { if (entry.node.getBoundingClientRect().top <= line) active = i; });
      var doc = document.documentElement;
      var progress = Math.min(1, Math.max(0, window.scrollY / Math.max(1, doc.scrollHeight - window.innerHeight)));
      callback(active, progress);
    }
    function schedule() { if (!frame) frame = window.requestAnimationFrame(measure); }
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    measure();
    return function () {
      window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }

  /* ---------- Search over the generated data ---------- */

  var indexCache = null;
  function buildIndex() {
    var out = [];
    function add(kind, labelText, detail, href, weight) {
      out.push({ kind: kind, label: labelText, detail: detail || '', href: href, weight: weight || 0,
        hay: (labelText + ' ' + (detail || '')).toLowerCase(), key: labelText.toLowerCase() });
    }
    pages().list.forEach(function (p) {
      add(p.kind === 'guide' ? 'Guide' : p.kind === 'tutorial' ? 'Tutorial' : 'Page', p.label, [p.alias, p.summary].filter(Boolean).join('. '), p.href, 30);
    });
    var data = window.PRISM_GUIDES || { guides: {} };
    guides().forEach(function (g) {
      (function visit(blocks) {
        blocks.forEach(function (block) {
          if (block.t === 'heading' && block.level > 1 && block.id) add('Section', plainText(block.c), g.label, g.href + '#' + block.id, 12);
          else if (block.t === 'list') block.items.forEach(visit);
          else if (block.t === 'quote') visit(block.c);
        });
      })((data.guides[g.key] || { blocks: [] }).blocks);
    });
    tutorials().forEach(function (t) {
      t.stages.forEach(function (stage) { add('Step', stage.title.replace(/`/g, ''), t.label, t.href, 8); });
    });
    var memory = (window.PRISM_REFERENCE || {}).memory || {};
    (memory.regions || []).forEach(function (region) {
      var target = '#/reference/address-map/' + encodeURIComponent(region.id);
      add('Region', region.id, hex(region.base) + ', ' + size(region.bytes) + ' reserved', target, 20);
      (region.registers || []).forEach(function (reg) {
        add('Register', region.id + '.' + reg.name, hex(reg.address) + ' ' + reg.access, target, 10);
        (reg.fields || []).forEach(function (field) {
          add('Field', region.id + '.' + reg.name + '.' + field.name,
            'bit' + (field.width > 1 ? 's ' + (field.lsb + field.width - 1) + ':' + field.lsb : ' ' + field.lsb), target, 2);
        });
      });
    });
    (memory.interrupts || []).forEach(function (irq) {
      add('Interrupt', irq.name, 'source bit ' + irq.bit + ', claim ID ' + (irq.bit + 1), '#/reference/address-map', 6);
    });
    return out;
  }

  // What an address maps to, from the same generated memory map the address
  // map page reads.
  function resolveAddress(address) {
    var memory = (window.PRISM_REFERENCE || {}).memory || {};
    var region = (memory.regions || []).filter(function (r) { return address >= r.base && address <= r.last; })[0];
    if (region) {
      var word = address - (address % 4);
      var reg = (region.registers || []).filter(function (g) { return g.address === word; })[0];
      return { kind: 'Address', label: hex(address), href: '#/reference/address-map/' + encodeURIComponent(region.id),
        detail: 'Reserved region ' + region.id + ', offset 0x' + (address - region.base).toString(16).toUpperCase() + (reg ? ', register ' + reg.name : '') };
    }
    var store = (memory.storage || []).filter(function (s) { return address >= s.base && address <= s.last; })[0];
    if (store) {
      return { kind: 'Address', label: hex(address), href: '#/reference/address-map',
        detail: address < store.base + store.bytes ? 'Installed ' + store.name + ', offset 0x' + (address - store.base).toString(16).toUpperCase()
          : store.name + ' reservation, beyond the ' + size(store.bytes) + ' installed' };
    }
    var aperture = memory.aperture;
    var inside = aperture && address >= aperture.base && address < aperture.base + aperture.bytes;
    return { kind: 'Address', label: hex(address), href: '#/reference/address-map',
      detail: inside ? 'Peripheral aperture, outside every reserved region' : 'Outside the address map' };
  }

  function search(query, limit) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    if (!indexCache) indexCache = buildIndex();
    var results = [];
    var address = /^0x([0-9a-f_]{1,9})$/.exec(q);
    if (address) {
      var value = parseInt(address[1].replace(/_/g, ''), 16);
      if (value >= 0 && value <= 0xFFFFFFFF) results.push(resolveAddress(value));
    }
    var terms = q.split(/\s+/);
    var scored = [];
    indexCache.forEach(function (entry) {
      var score = entry.weight;
      for (var i = 0; i < terms.length; i++) {
        var term = terms[i], at = entry.hay.indexOf(term);
        if (at === -1) return;
        var inLabel = entry.key.indexOf(term);
        if (entry.key === q) score += 200;
        else if (inLabel === 0) score += 60;
        else if (inLabel > 0 && /[\s._\-/]/.test(entry.key.charAt(inLabel - 1))) score += 40;
        else if (inLabel > 0) score += 20;
        else score += 5;
      }
      scored.push({ entry: entry, score: score - entry.key.length * 0.05 });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    scored.slice(0, limit || 12).forEach(function (hit) { results.push(hit.entry); });
    return results;
  }

  // Wire an input and a list into an accessible combobox. `render(result)`
  // returns the content of one option; choosing an option follows its link.
  function combobox(input, list, options) {
    options = options || {};
    var active = -1, results = [];
    var status = options.status || null;
    if (!list.id) list.id = 'kit-results-' + Math.random().toString(36).slice(2, 8);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-expanded', 'false');
    list.setAttribute('role', 'listbox');
    function setActive(index) {
      active = index;
      Array.prototype.forEach.call(list.children, function (item, i) {
        item.setAttribute('aria-selected', String(i === active));
        if (i === active) { input.setAttribute('aria-activedescendant', item.id); item.scrollIntoView({ block: 'nearest' }); }
      });
      if (active < 0) input.removeAttribute('aria-activedescendant');
    }
    function update() {
      results = search(input.value, options.limit || 12);
      list.replaceChildren();
      results.forEach(function (result, i) {
        var link = el('a', { href: result.href, tabindex: '-1' }, options.render ? options.render(result) : result.label);
        link.addEventListener('click', function () { if (options.onPick) options.onPick(result); });
        list.appendChild(el('li', { role: 'option', id: list.id + '-' + i, 'aria-selected': 'false' }, link));
      });
      input.setAttribute('aria-expanded', String(results.length > 0));
      list.hidden = !results.length;
      setActive(results.length ? 0 : -1);
      if (status) status.textContent = !input.value.trim() ? (options.hint || '') : results.length ? results.length + (results.length === 1 ? ' result' : ' results') : 'No page, section or register matches “' + input.value.trim() + '”.';
    }
    input.addEventListener('input', update);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); setActive((active + 1) % results.length); }
      else if (event.key === 'ArrowUp' && results.length) { event.preventDefault(); setActive((active + results.length - 1) % results.length); }
      else if (event.key === 'Enter' && active >= 0) {
        event.preventDefault();
        var picked = results[active];
        location.hash = picked.href;
        if (options.onPick) options.onPick(picked);
      }
    });
    update();
    return { update: update, clear: function () { input.value = ''; update(); } };
  }

  /* ---------- Small shell behaviours ---------- */

  // Local peripheral documents: the canonical app lists them in #sidebar for
  // the session. Report them so a design can show them in its own navigation.
  function onLocalDocuments(callback) {
    var sidebar = document.getElementById('sidebar');
    if (!sidebar || !window.MutationObserver) return;
    function report() {
      callback(Array.prototype.map.call(sidebar.querySelectorAll('#local-document-links a'), function (a) {
        return { href: a.getAttribute('href'), label: a.textContent };
      }));
    }
    new MutationObserver(report).observe(sidebar, { childList: true, subtree: true });
    report();
  }

  function hotkey(test, action) {
    document.addEventListener('keydown', function (event) {
      var target = event.target;
      var typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (test(event, typing)) { event.preventDefault(); action(event); }
    });
  }
  function isSearchKey(event, typing) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') return true;
    return event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey;
  }

  // Routes by reader, as page addresses only; labels and summaries come from
  // the pages themselves. A step whose page is gone is skipped.
  var PATHS = [
    { id: 'students', title: 'Students', intent: 'Learn computer architecture, digital design and firmware on a working SoC.',
      steps: ['#/guides/getting-started', '#/tutorials/instantiate-core', '#/architecture/datapath/singlecycle', '#/architecture/caches', '#/architecture/system-bus', '#/guides/firmware', '#/tutorials/custom-tile'] },
    { id: 'researchers', title: 'Researchers', intent: 'Change one part, run controlled experiments and check the result.',
      steps: ['#/guides/configuration', '#/guides/experiments', '#/guides/adding-a-core', '#/guides/interfaces', '#/guides/verification', '#/roadmap'] },
    { id: 'teams', title: 'Engineering teams', intent: 'Explore the design space, validate a configuration and run firmware on an FPGA.',
      steps: ['#/guides/configuration', '#/guides/fpga', '#/tutorials/systems', '#/reference/address-map', '#/reference/platformio', '#/guides/integration', '#/tools/peripheral-docs'] }
  ];
  function paths() {
    return PATHS.map(function (path) {
      return { id: path.id, title: path.title, intent: path.intent,
        steps: path.steps.map(page).filter(Boolean) };
    });
  }

  function start() {
    // After the canonical router: it rendered synchronously at load and
    // registered its hashchange listener before this one.
    window.addEventListener('hashchange', runHooks);
    runHooks();
  }

  window.PrismKit = {
    el: el, svg: svg, hex: hex, hexSpaced: hexSpaced, size: size, main: main,
    nav: NAV, sections: sections, section: section, guides: guides, guideGroups: guideGroups, tutorials: tutorials,
    pages: function () { return pages().list; }, page: page, label: label, paths: paths,
    route: route, markCurrent: markCurrent, onRender: onRender, start: start,
    outline: outline, outlineList: outlineList, reveal: reveal, spy: spy,
    search: search, combobox: combobox, resolveAddress: resolveAddress,
    onLocalDocuments: onLocalDocuments, hotkey: hotkey, isSearchKey: isSearchKey,
    memory: function () { return (window.PRISM_REFERENCE || {}).memory || null; },
    roadmap: function () { return window.PRISM_ROADMAP || null; }
  };
})();
