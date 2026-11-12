/* Prism's guides as site pages. data/guides.js (window.PRISM_GUIDES) holds the
   pinned edition from content/guides/ as JSON blocks; this module builds each
   page with DOM APIs, so guide text is only ever set as text. The router in
   app.js owns #/guides/<key> and calls view(key). */
(function () {
  'use strict';

  function data() {
    var value = window.PRISM_GUIDES;
    return value && value.guides && value.order ? value : { order: [], guides: {} };
  }

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === undefined || value === null || value === false) return;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (value === true) el.setAttribute(key, '');
        else el.setAttribute(key, String(value));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid === undefined || kid === null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }

  /* ---------- Anchors (GitHub heading ids, as scripts/guides.py makes them) ---------- */

  function plainSource(text) {
    // Heading Markdown to its rendered text: code spans, links and emphasis.
    return String(text)
      .replace(/<a id="[^"]*"><\/a>/g, '')
      .replace(/(`+)([\s\S]*?)\1/g, function (_, ticks, code) { return code; })
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*+/g, '')
      .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, '$1');
  }
  function anchor(headingText) {
    return plainSource(headingText).trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replace(/ /g, '-');
  }

  function plain(nodes) {
    return nodes.map(function (node) {
      if (typeof node === 'string') return node;
      if (node.t === 'code') return node.v;
      return node.c ? plain(node.c) : '';
    }).join('');
  }

  function headings(guide) {
    var out = [];
    (function walk(blocks) {
      blocks.forEach(function (block) {
        if (block.t === 'heading') out.push(block);
        else if (block.t === 'list') block.items.forEach(walk);
        else if (block.t === 'quote') walk(block.c);
      });
    })(guide.blocks);
    return out;
  }

  function findHeading(key, headingText) {
    var guide = data().guides[key];
    if (!guide || typeof headingText !== 'string') return null;
    var wanted = headingText.trim();
    return headings(guide).filter(function (block) {
      return block.level > 1 && (block.source === wanted || plain(block.c) === wanted);
    })[0] || null;
  }

  function hasSection(key, headingText) {
    return Boolean(findHeading(key, headingText));
  }

  function href(key, headingText) {
    // Exact link to a guide section, or null when the guide or section is absent.
    var block = findHeading(key, headingText);
    return block ? '#/guides/' + key + '#' + block.id : null;
  }

  function reveal(id) {
    // Scroll to an anchor in the mounted guide and move focus there.
    var target = id ? document.getElementById(id) : null;
    if (!target) return false;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
    return true;
  }

  function followInPage(event) {
    // Same-guide anchors scroll without re-rendering; the URL still updates.
    var link = event.currentTarget;
    var parts = /^#\/guides\/([^#]+)#(.+)$/.exec(link.getAttribute('href') || '');
    var page = link.closest('.guide');
    if (!parts || !page || page.getAttribute('data-guide') !== parts[1] || !document.getElementById(parts[2])) return;
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    try { history.pushState(null, '', link.getAttribute('href')); } catch (error) { /* file:// may refuse */ }
    reveal(parts[2]);
  }

  /* ---------- Clipboard, matching app.js code blocks ---------- */

  function announce(message) {
    var announcer = document.getElementById('announcer');
    if (!announcer) return;
    announcer.textContent = '';
    window.setTimeout(function () { announcer.textContent = message; }, 30);
  }
  function legacyCopy(text) {
    var area = h('textarea', { readonly: true, 'aria-hidden': 'true', style: 'position:fixed;top:0;left:-9999px;opacity:0' });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }
  function copy(text, button, node) {
    var label = button.querySelector('.copy-label');
    function finish(ok) {
      window.clearTimeout(button._copyTimer);
      button.setAttribute('data-state', ok ? 'done' : 'manual');
      label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      if (ok) announce('Copied code to the clipboard');
      else {
        var range = document.createRange();
        range.selectNodeContents(node);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        announce('Copying is blocked here. The text is selected; press Control C or Command C to copy it.');
      }
      button._copyTimer = window.setTimeout(function () {
        button.removeAttribute('data-state');
        label.textContent = 'Copy';
      }, ok ? 1600 : 4000);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { finish(true); }, function () { finish(legacyCopy(text)); });
    } else {
      finish(legacyCopy(text));
    }
  }

  function codeBlock(block) {
    var code = h('code', { text: block.text });
    var button = h('button', { type: 'button', class: 'copy-button', 'aria-label': 'Copy code' },
      h('span', { class: 'copy-label', text: 'Copy' }));
    button.addEventListener('click', function () { copy(block.text, button, code); });
    return h('div', { class: 'codeblock' },
      h('div', { class: 'codeblock-head' }, h('span', { class: 'mono', text: block.lang || 'text' }), button),
      h('pre', { tabindex: '0' }, code));
  }

  /* ---------- Blocks ---------- */

  function inline(nodes) {
    return nodes.map(function (node) {
      if (typeof node === 'string') return node;
      switch (node.t) {
        case 'code': return h('code', { text: node.v });
        case 'strong': return h('strong', null, inline(node.c));
        case 'em': return h('em', null, inline(node.c));
        case 'anchor': return h('span', { class: 'guide-anchor', id: node.id });
        case 'link': {
          var external = node.href.indexOf('https://') === 0;
          if (!external && node.href.indexOf('#/') !== 0) return inline(node.c);
          var a = h('a', { href: node.href, rel: external ? 'noopener' : null }, inline(node.c));
          if (!external) a.addEventListener('click', followInPage);
          return a;
        }
        default: throw new Error('Unknown guide inline node: ' + node.t);
      }
    });
  }

  function table(block, label) {
    function cellClass(i) { return block.align[i] ? 'align-' + block.align[i] : null; }
    return h('div', { class: 'table-scroll', role: 'region', tabindex: '0', 'aria-label': label },
      h('table', null,
        h('thead', null, h('tr', null, block.head.map(function (cell, i) {
          return h('th', { scope: 'col', class: cellClass(i) }, inline(cell));
        }))),
        h('tbody', null, block.rows.map(function (row) {
          return h('tr', null, row.map(function (cell, i) { return h('td', { class: cellClass(i) }, inline(cell)); }));
        }))));
  }

  function list(block, context) {
    var tag = block.ordered ? 'ol' : 'ul';
    return h(tag, { class: block.tasks ? 'task-list' : null, start: block.ordered && block.start !== 1 ? block.start : null },
      block.items.map(function (item, i) {
        var task = block.tasks ? block.tasks[i] : null;
        var box = task === null || task === undefined ? null
          : h('input', { type: 'checkbox', disabled: true, checked: task, 'aria-label': task ? 'Done' : 'Not done' });
        var content = item.map(function (child) {
          return block.tight && child.t === 'p' ? inline(child.c) : render(child, context);
        });
        return h('li', { class: box ? 'task-item' : null }, box, content);
      }));
  }

  function render(block, context) {
    switch (block.t) {
      case 'heading': {
        context.section = plain(block.c);
        var level = Math.min(Math.max(block.level, 2), 6);
        return h('h' + level, { id: block.id }, inline(block.c));
      }
      case 'anchor': return h('span', { class: 'guide-anchor', id: block.id });
      case 'p': return h('p', null, inline(block.c));
      case 'code': return codeBlock(block);
      case 'list': return list(block, context);
      case 'table': return table(block, 'Table: ' + context.section);
      case 'quote': return h('blockquote', null, block.c.map(function (child) { return render(child, context); }));
      default: throw new Error('Unknown guide block: ' + block.t);
    }
  }

  function list_() {
    return data().order.map(function (entry) { return { key: entry.key, title: entry.title }; });
  }

  function view(key) {
    var guide = Object.prototype.hasOwnProperty.call(data().guides, key) ? data().guides[key] : null;
    if (!guide) return null;
    var blocks = guide.blocks;
    var title = blocks[0];
    var context = { section: guide.title };
    var sections = blocks.filter(function (block) { return block.t === 'heading' && block.level === 2; });
    var contents = sections.length > 1 ? h('nav', { class: 'page-contents', 'aria-label': 'On this page' },
      h('span', { class: 'page-contents-label', text: 'On this page' }),
      sections.map(function (block) {
        var a = h('a', { href: '#/guides/' + key + '#' + block.id, text: plain(block.c) });
        a.addEventListener('click', followInPage);
        return a;
      })) : null;
    return h('div', { class: 'page guide', 'data-guide': key },
      h('h1', { id: 'page-title', tabindex: '-1' }, inline(title.c)),
      contents,
      h('div', { class: 'guide-body' }, blocks.slice(1).map(function (block) { return render(block, context); })));
  }

  window.PrismGuides = { list: list_, view: view, hasSection: hasSection, anchor: anchor, href: href, reveal: reveal };
})();
