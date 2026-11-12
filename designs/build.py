#!/usr/bin/env python3
"""Build the design prototypes: one canonical site, several presentation shells.

    python3 designs/build.py [--content-root DIR] [--out DIR] [design ...]

Each design in designs/<name>/ is a shell (shell.html), a stylesheet and a
script. This build stages the canonical site with the content checkout's own
scripts/build.py, then lays the design over it. The canonical pages, data and
interactive tools are never copied into a design or edited: a design replaces
index.html and adds files under assets/design/.

--content-root is a Prism-Website checkout to read content from. It defaults
to the frozen snapshot in designs/build/snapshot when one exists, otherwise to
this checkout. Nothing is ever written into the content root.
"""
import argparse
from html.parser import HTMLParser
import importlib
import json
from pathlib import Path
import re
import shutil
import sys

HERE = Path(__file__).resolve().parent
KIT = HERE / 'kit'
VOID = {'meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'wbr'}


class Tree(HTMLParser):
    """A small element tree of the canonical index.html."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = {'tag': 'root', 'attrs': {}, 'kids': []}
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = {'tag': tag, 'attrs': dict(attrs), 'kids': []}
        self.stack[-1]['kids'].append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1]['kids'].append({'tag': tag, 'attrs': dict(attrs), 'kids': []})

    def handle_endtag(self, tag):
        for depth in range(len(self.stack) - 1, 0, -1):
            if self.stack[depth]['tag'] == tag:
                del self.stack[depth:]
                return

    def handle_data(self, data):
        self.stack[-1]['kids'].append(data)


def walk(node):
    yield node
    for kid in node['kids']:
        if isinstance(kid, dict):
            yield from walk(kid)


def classes(node):
    return (node['attrs'].get('class') or '').split()


def text(node, skip=()):
    parts = []
    for kid in node['kids']:
        if isinstance(kid, str):
            parts.append(kid)
        elif not set(classes(kid)) & set(skip) and kid['tag'] != 'svg':
            parts.append(text(kid, skip))
    return ' '.join(' '.join(parts).split())


def children(node, tag):
    return [kid for kid in node['kids'] if isinstance(kid, dict) and kid['tag'] == tag]


def nav_items(listing):
    """<ul class="nav-list"> as [{href, label, tag, children}]."""
    items = []
    for li in children(listing, 'li'):
        link = next((n for n in walk(li) if n['tag'] == 'a'), None)
        if link is None:
            continue
        tag = next((text(n) for n in walk(link) if 'nav-tag' in classes(n)), None)
        item = {'href': link['attrs'].get('href', ''), 'label': text(link, skip=('nav-tag', 'visually-hidden'))}
        if tag:
            item['tag'] = tag
        nested = children(li, 'ul')
        if nested:
            item['children'] = nav_items(nested[0])
        items.append(item)
    return items


def read_index(html):
    """Stylesheets, scripts, required elements and navigation of the canonical page."""
    tree = Tree()
    tree.feed(html)
    nodes = list(walk(tree.root))
    head = next(n for n in nodes if n['tag'] == 'head')
    sidebar = next(n for n in nodes if n['attrs'].get('id') == 'sidebar')
    groups, current = [], None
    for kid in sidebar['kids']:
        if not isinstance(kid, dict):
            continue
        if 'nav-group' in classes(kid):
            current = {'title': text(kid), 'items': []}
            groups.append(current)
        elif kid['tag'] == 'ul' and 'nav-list' in classes(kid):
            if current is None:
                current = {'title': '', 'items': []}
                groups.append(current)
            current['items'].extend(nav_items(kid))
    return {
        'styles': [n['attrs']['href'] for n in walk(head)
                   if n['tag'] == 'link' and n['attrs'].get('rel') == 'stylesheet'],
        'scripts': [n['attrs']['src'] for n in nodes if n['tag'] == 'script' and n['attrs'].get('src')],
        'head_script': next((''.join(k for k in n['kids'] if isinstance(k, str))
                             for n in walk(head) if n['tag'] == 'script' and not n['attrs'].get('src')), ''),
        'ids': {n['attrs']['id'] for n in nodes if n['attrs'].get('id')},
        'classes': {name for n in nodes for name in classes(n)},
        'nav': groups,
    }


def required_hooks(app_js, canon):
    """Elements the canonical script looks up at load, which every shell must keep."""
    ids = set(re.findall(r"getElementById\('([\w-]+)'\)", app_js)) & canon['ids']
    selectors = {name[1:] for name in re.findall(r"document\.querySelector\('(\.[\w-]+)'\)", app_js)} & canon['classes']
    return sorted(ids), sorted(selectors)


def data_script(name, value):
    data = json.dumps(value, ensure_ascii=True, separators=(',', ':'))
    data = data.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    return ('window.' + name + ' = ' + data + ';\n').encode()


def combined(files, styles):
    """The canonical stylesheets, in the canonical order, as one file.

    A design's stylesheet loads after this one. A rule it writes for the same
    selector wins; anything it leaves alone keeps the canonical presentation,
    so a component the content gains later is styled in every design without
    further work. The interactive tools keep their own more specific rules.
    """
    parts = ['/* Canonical site styles, joined by designs/build.py. Do not edit. */\n']
    for href in styles:
        parts.append('\n/* ' + href + ' */\n' + files[href].decode() + '\n')
    return ''.join(parts).encode()


def compose(design, files, canon, hooks):
    shell = (design / 'shell.html').read_text()
    ids, selectors = hooks
    missing = [i for i in ids if not re.search(r'\bid="' + re.escape(i) + '"', shell)]
    missing += ['.' + s for s in selectors if not re.search(r'class="[^"]*\b' + re.escape(s) + r'\b', shell)]
    if missing:
        raise ValueError(design.name + '/shell.html lacks elements the canonical script needs: ' + ', '.join(missing))
    replacements = {
        '<!-- canon:styles -->': '<link rel="stylesheet" href="assets/canon.css">',
        '<!-- canon:head-script -->': '<script>' + canon['head_script'] + '</script>',
        '<!-- canon:scripts -->': '\n  '.join('<script src="' + src + '"></script>' for src in canon['scripts']),
    }
    for marker, value in replacements.items():
        if marker not in shell:
            raise ValueError(design.name + '/shell.html lacks the marker ' + marker)
        shell = shell.replace(marker, value)
    out = dict(files)
    out['index.html'] = shell.encode()
    out['assets/canon.css'] = combined(files, canon['styles'])
    out['data/nav.js'] = data_script('PRISM_NAV', {'groups': canon['nav']})
    for path in sorted(KIT.rglob('*')):
        if path.is_file():
            out['assets/design/' + path.relative_to(KIT).as_posix()] = path.read_bytes()
    for path in sorted(design.rglob('*')):
        if path.is_file() and path.name != 'shell.html':
            out['assets/design/' + path.relative_to(design).as_posix()] = path.read_bytes()
    return out


def write(files, destination):
    if destination.exists():
        if not (destination / '.prism-generated').is_file():
            raise ValueError('Refusing to replace ' + str(destination) + ': it was not made by this build')
        shutil.rmtree(destination)
    for name, data in files.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('designs', nargs='*', help='design names; default is every designs/<name>/shell.html')
    snapshot = HERE / 'build/snapshot'
    parser.add_argument('--content-root', type=Path, default=snapshot if snapshot.is_dir() else HERE.parent)
    parser.add_argument('--out', type=Path, default=HERE / 'dist')
    args = parser.parse_args()

    root = args.content_root.resolve()
    if not (root / 'scripts/build.py').is_file():
        sys.exit('No content to build from: pass --content-root with a Prism-Website checkout.')
    args.out = args.out.resolve()
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(root / 'scripts'))
    canonical = importlib.import_module('build')
    private = importlib.import_module('guides').mentions_private_records
    files, _ = canonical.stage_files()
    canon = read_index(files['index.html'].decode())
    hooks = required_hooks(files['assets/app.js'].decode(), canon)

    names = args.designs or sorted(p.parent.name for p in HERE.glob('*/shell.html'))
    write(files, args.out / 'current')
    for name in names:
        out = compose(HERE / name, files, canon, hooks)
        added = {k: v for k, v in out.items() if k not in files or files[k] != v}
        leaks = sorted(k for k, v in added.items() if private(k) or private(v.decode('utf-8', errors='replace')))
        if leaks:
            raise ValueError('Refusing to build private-document references in: ' + ', '.join(leaks))
        write(out, args.out / name)
        print('Built', args.out / name / 'index.html', 'from', root)
    # The side-by-side comparison page; its screenshots are made by tools/shot.cjs.
    compare = HERE / 'compare/index.html'
    if compare.is_file():
        (args.out / 'index.html').write_bytes(compare.read_bytes())


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, StopIteration) as error:
        sys.exit(str(error))
