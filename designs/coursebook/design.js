/* Coursebook: Prism as a course text. The site becomes one ordered outline of
   units with a previous and next page everywhere, the pages a reader has
   opened are remembered, and a tutorial's stages can be ticked off. Page
   content is the canonical render in #main. */
(function () {
  'use strict';
  var K = window.PrismKit, el = K.el;
  var main = K.main;
  var outline = document.getElementById('cb-outline');
  var margin = document.getElementById('cb-margin');
  var pager = document.getElementById('cb-pager');
  var dock = document.getElementById('cb-dock');
  var menuButton = document.getElementById('menu-button');

  /* ---------- Saved progress (this browser only) ---------- */

  function load(key, fallback) {
    try { var value = JSON.parse(localStorage.getItem(key)); return value && typeof value === 'object' ? value : fallback; }
    catch (error) { return fallback; }
  }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* not persisted */ } }
  var visited = load('prism-coursebook-visited', {});
  var done = load('prism-coursebook-done', {});

  /* ---------- Units: the site in reading order ---------- */

  function buildUnits() {
    var by = {};
    K.sections().forEach(function (section) { by[section.id] = section; });
    var groups = K.guideGroups();
    var units = [];
    function items(id) { return by[id] ? by[id].items : []; }
    units.push({ title: 'Start here', items: [{ href: '#/', label: K.label('#/') }].concat(groups.length ? groups[0].items : []) });
    if (items('tutorials').length) units.push({ title: 'Build a system', items: items('tutorials') });
    if (items('architecture').length) units.push({ title: 'See how it works', items: items('architecture') });
    groups.slice(1).forEach(function (group) { units.push({ title: group.title, items: group.items }); });
    units.push({ title: 'Look it up', items: [{ href: '#/guides', label: K.label('#/guides') }]
      .concat(items('reference'), items('tools'), items('project'), items('more')) });
    return units;
  }

  var units = buildUnits();
  var sequence = [];   // every page once, in reading order
  var folds = [];

  function entry(item, depth, unit) {
    // A page that only groups its children (the datapath tab) is shown but
    // is not a stop of its own in the reading order.
    var stop = !(depth > 0 && item.children && item.children.length);
    if (stop && !sequence.some(function (s) { return s.href === item.href; })) sequence.push({ href: item.href, label: item.label, unit: unit });
    var link = el('a', { href: item.href, 'data-depth': depth },
      el('span', { class: 'cb-dot', 'aria-hidden': 'true' }), el('span', { class: 'cb-label', text: item.label }),
      item.tag ? el('span', { class: 'cb-tag', text: item.tag }) : null);
    return [el('li', null, link)].concat((item.children || []).map(function (child) { return entry(child, depth + 1, unit); }));
  }
  function buildOutline() {
    units.forEach(function (unit, i) {
      var count = el('span', { class: 'cb-count' });
      var fold = el('details', { class: 'cb-unit', open: i === 0 },
        el('summary', null, el('span', { class: 'cb-unit-title', text: unit.title }), count),
        el('ul', null, unit.items.map(function (item) { return entry(item, 0, unit); })));
      unit.fold = fold; unit.count = count;
      folds.push(fold);
      outline.appendChild(fold);
    });
    var reset = el('button', { type: 'button', class: 'cb-reset', text: 'Clear reading progress' });
    reset.addEventListener('click', function () {
      visited = {}; done = {};
      save('prism-coursebook-visited', visited); save('prism-coursebook-done', done);
      refreshProgress();
      Array.prototype.forEach.call(main.querySelectorAll('.cb-done input'), function (box) { box.checked = false; box.dispatchEvent(new Event('change')); });
    });
    outline.appendChild(reset);
  }

  function refreshProgress() {
    Array.prototype.forEach.call(document.querySelectorAll('.cb-outline a[href], .cb-route a[href], .cb-chapters a[href]'), function (a) {
      a.toggleAttribute('data-visited', !!visited[a.getAttribute('href')]);
    });
    units.forEach(function (unit) {
      var pages = sequence.filter(function (s) { return s.unit === unit; });
      var seen = pages.filter(function (s) { return visited[s.href]; }).length;
      unit.count.textContent = seen + ' of ' + pages.length;
      unit.count.setAttribute('aria-label', seen + ' of ' + pages.length + ' pages opened');
    });
  }

  /* ---------- Find, at the top of the outline ---------- */

  var query = document.getElementById('cb-query');
  var findRoot = query.closest('.cb-find');
  var box = K.combobox(query, document.getElementById('cb-results'), {
    limit: 10,
    status: document.getElementById('cb-find-status'),
    render: function (result) {
      return [el('span', { class: 'cb-hit', text: result.label }),
        el('span', { class: 'cb-hit-detail', text: result.kind + (result.detail ? ': ' + result.detail : '') })];
    },
    onPick: function () { box.clear(); findRoot.removeAttribute('data-active'); }
  });
  query.addEventListener('input', function () { findRoot.toggleAttribute('data-active', !!query.value.trim()); });
  query.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && query.value) { event.stopPropagation(); box.clear(); findRoot.removeAttribute('data-active'); }
  });
  K.hotkey(K.isSearchKey, function () {
    var sidebar = document.getElementById('sidebar');
    // The outline is a drawer on narrow screens and can be hidden on wide ones.
    if (sidebar.offsetParent === null || getComputedStyle(sidebar).visibility === 'hidden') menuButton.click();
    window.setTimeout(function () { query.focus(); query.select(); }, 60);
  });

  /* ---------- Per page ---------- */

  function neighbours(now) {
    var index = -1;
    sequence.forEach(function (stop, i) { if (stop.href === now.href) index = i; });
    return { index: index, previous: index > 0 ? sequence[index - 1] : null,
      next: index >= 0 && index < sequence.length - 1 ? sequence[index + 1] : null, here: index >= 0 ? sequence[index] : null };
  }

  function pageLink(stop, direction) {
    if (!stop) return el('span', { class: 'cb-pager-none' });
    return el('a', { class: 'cb-pager-' + direction, href: stop.href, rel: direction === 'next' ? 'next' : 'prev' },
      el('span', { class: 'cb-pager-way', text: direction === 'next' ? 'Next' : 'Previous' }),
      el('span', { class: 'cb-pager-title', text: stop.label }));
  }
  function renderPager(near) {
    pager.replaceChildren(pageLink(near.previous, 'previous'), pageLink(near.next, 'next'));
    pager.hidden = !near.previous && !near.next;
    var outlineButton = el('button', { type: 'button', class: 'cb-dock-outline', text: 'Outline', 'aria-controls': 'sidebar' });
    outlineButton.addEventListener('click', function () { menuButton.click(); });
    dock.replaceChildren(
      near.previous ? el('a', { class: 'cb-dock-step', href: near.previous.href, rel: 'prev', 'aria-label': 'Previous: ' + near.previous.label }, el('span', { 'aria-hidden': 'true', text: '‹' }), 'Previous') : el('span', { class: 'cb-dock-step' }),
      outlineButton,
      near.next ? el('a', { class: 'cb-dock-step', href: near.next.href, rel: 'next', 'aria-label': 'Next: ' + near.next.label }, 'Next', el('span', { 'aria-hidden': 'true', text: '›' })) : el('span', { class: 'cb-dock-step' }));
  }

  var stopSpy = null;
  function renderMargin(now, near) {
    if (stopSpy) { stopSpy(); stopSpy = null; }
    margin.replaceChildren();
    var entries = now.home ? [] : K.outline('h2');
    var place = near.here ? el('p', { class: 'cb-place' },
      'Page ' + (sequence.filter(function (s) { return s.unit === near.here.unit; }).indexOf(near.here) + 1) + ' of ' +
      sequence.filter(function (s) { return s.unit === near.here.unit; }).length + ' in ', el('strong', { text: near.here.unit.title })) : null;
    margin.hidden = !entries.length;
    document.documentElement.toggleAttribute('data-margin', !margin.hidden);
    if (!entries.length) return;
    margin.appendChild(el('p', { class: 'cb-margin-title', text: 'On this page' }));
    margin.appendChild(K.outlineList(entries, { class: 'cb-sections' }));
    if (place) margin.appendChild(place);
    stopSpy = K.spy(entries, function (active) {
      entries.forEach(function (item, i) {
        item.link.toggleAttribute('data-active', i === active);
        item.link.toggleAttribute('data-read', i < active);
      });
    });
  }

  // Tutorials: tick a stage off; the ticks stay in this browser.
  function composeTutorial(now) {
    var page = main.querySelector(':scope > .tutorial');
    if (!page || page.hasAttribute('data-cb')) return;
    page.setAttribute('data-cb', 'tutorial');
    var key = now.path;
    var stages = Array.prototype.slice.call(page.querySelectorAll('.tutorial-step'));
    if (!stages.length) return;
    var tally = el('p', { class: 'cb-tally', role: 'status' });
    function refresh() {
      var marked = done[key] || [];
      var count = stages.filter(function (stage) { return marked.indexOf(stage.id) !== -1; }).length;
      stages.forEach(function (stage) { stage.toggleAttribute('data-done', marked.indexOf(stage.id) !== -1); });
      tally.textContent = count === stages.length ? 'All ' + stages.length + ' stages done.' : count + ' of ' + stages.length + ' stages done.';
    }
    stages.forEach(function (stage, i) {
      var head = stage.querySelector('.step-head');
      if (!head || !stage.id) return;
      var input = el('input', { type: 'checkbox' });
      input.checked = (done[key] || []).indexOf(stage.id) !== -1;
      input.addEventListener('change', function () {
        var marked = (done[key] || []).filter(function (id) { return id !== stage.id; });
        if (input.checked) marked.push(stage.id);
        done[key] = marked; save('prism-coursebook-done', done); refresh();
      });
      head.appendChild(el('label', { class: 'cb-done' }, input, el('span', { text: 'Done' }), el('span', { class: 'visually-hidden', text: ': stage ' + (i + 1) })));
    });
    var steps = page.querySelector('.tutorial-steps');
    if (steps) steps.before(tally);
    refresh();
  }

  function routeList(path) {
    return el('div', { class: 'cb-route' }, el('h3', { text: path.title }), el('p', { text: path.intent }),
      el('ol', null, path.steps.map(function (step) {
        return el('li', null, el('a', { href: step.href }, el('span', { class: 'cb-dot', 'aria-hidden': 'true' }), el('span', { text: step.label })));
      })));
  }
  function composeHome() {
    var page = main.querySelector(':scope > .page');
    var hero = page && page.querySelector('.hero');
    if (!hero || page.hasAttribute('data-cb')) return;
    page.setAttribute('data-cb', 'home');
    var routes = el('section', { class: 'cb-routes', 'aria-labelledby': 'cb-routes-title' },
      el('h2', { id: 'cb-routes-title', text: 'Choose a route' }),
      el('p', { class: 'section-intro', text: 'Each route is an order to read and build in. A filled mark shows a page you have already opened in this browser.' }),
      el('div', { class: 'cb-routes-grid' }, K.paths().map(routeList)));
    hero.after(routes);
  }

  function composeGuideIndex(now) {
    if (now.path !== 'guides') return;
    var list = main.querySelector(':scope > .page > ul.next-list');
    if (!list) return;
    list.replaceWith(el('div', { class: 'cb-chapters' }, K.guideGroups().map(function (group) {
      return el('section', null, el('h2', { text: group.title }),
        el('ol', null, group.items.map(function (guide) {
          return el('li', null, el('a', { href: guide.href }, el('span', { class: 'cb-dot', 'aria-hidden': 'true' }), el('span', { text: guide.label })),
            el('p', { text: guide.summary }));
        })));
    })));
  }

  buildOutline();
  K.onRender(function (now) {
    if (now.href && !visited[now.href]) { visited[now.href] = 1; save('prism-coursebook-visited', visited); }
    var near = neighbours(now);
    K.markCurrent(outline);
    folds.forEach(function (fold) { if (fold.querySelector('[aria-current="page"]')) fold.open = true; });
    if (now.home) composeHome();
    composeGuideIndex(now);
    composeTutorial(now);
    renderPager(near);
    renderMargin(now, near);
    refreshProgress();
  });
  K.start();
})();
