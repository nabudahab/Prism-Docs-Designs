# Screenshots for the comparison page (designs/dist/compare/). Run from the folder that
# contains designs/, after python3 designs/build.py.
#   python3 designs/tools/gallery.py [design ...]            the full set per design
#   python3 designs/tools/gallery.py --palettes [design ...]  light and dark pairs per palette
import json, subprocess, sys
args = sys.argv[1:]
palette_mode = '--palettes' in args
args = [a for a in args if a != '--palettes']
designs = args or ['unified-c', 'unified-claude', 'unified-sol', 'datasheet', 'coursebook', 'exploded', 'current']
desktop = [('home', '#/'), ('guide', '#/guides/configuration'), ('address-map', '#/reference/address-map/uart'),
           ('datapath', '#/architecture/datapath/base'), ('tutorial', '#/tutorials/instantiate-core'),
           ('guides', '#/guides'), ('roadmap', '#/roadmap'), ('architecture', '#/architecture'),
           ('caches', '#/architecture/caches'), ('bus', '#/architecture/system-bus'), ('concepts', '#/reference/peripherals/i2c'),
           ('generator', '#/tools/peripheral-docs'), ('address-space', '#/reference/address-map'), ('coherent', '#/architecture/coherent-bus')]
# Each palette is shown on the same four pages, in both themes.
palette_pages = [('home', '#/', 1700), ('architecture', '#/architecture', 1700),
                 ('address-map', '#/reference/address-map/uart', 250), ('datapath', '#/architecture/datapath/base', 700)]
for d in designs:
    if palette_mode:
        shots = [{'name': 'palette-' + d + '-' + n + '-' + t, 'hash': h, 'width': 1440, 'height': 900, 'dsf': 0.5, 'theme': t, 'wait': w}
                 for n, h, w in palette_pages for t in ('light', 'dark')]
        spec = {'site': 'designs/dist/' + d, 'out': 'designs/dist/compare', 'shots': shots}
        r = subprocess.run(['node', 'designs/tools/shot.cjs', json.dumps(spec)], capture_output=True, text=True)
        bad = [e for e in json.loads(r.stdout) if e.get('overflowX') or e.get('events')] if r.returncode == 0 else r.stderr
        print(d, 'ok' if not bad else bad)
        continue
    shots = [{'name': d + '-' + n, 'hash': h, 'width': 1440, 'height': 900, 'dsf': 0.5, 'wait': 1700 if h in ('#/', '#/architecture') else 700 if 'arch' in h else 250} for n, h in desktop]
    shots += [{'name': d + '-' + n + '-dark', 'hash': h, 'width': 1440, 'height': 900, 'dsf': 0.5, 'theme': 'dark', 'wait': w}
              for n, h, w in (('home', '#/', 1700), ('datapath', '#/architecture/datapath/base', 700))]
    shots += [{'name': d + '-dark', 'hash': '#/guides/configuration', 'width': 1440, 'height': 900, 'dsf': 0.5, 'theme': 'dark'},
              {'name': d + '-phone-home', 'hash': '#/', 'width': 390, 'height': 844, 'dsf': 1, 'mobile': True, 'wait': 1700},
              {'name': d + '-phone-guide', 'hash': '#/guides/firmware', 'width': 390, 'height': 844, 'dsf': 1, 'mobile': True},
              {'name': d + '-phone-datapath', 'hash': '#/architecture/datapath/base', 'width': 390, 'height': 844, 'dsf': 1, 'mobile': True, 'wait': 700},
              {'name': d + '-phone-nav', 'hash': '#/reference/address-map', 'width': 390, 'height': 844, 'dsf': 1, 'mobile': True,
               'before': 'document.getElementById("menu-button").click()', 'wait': 400}]
    spec = {'site': 'designs/dist/' + d, 'out': 'designs/dist/compare', 'shots': shots}
    r = subprocess.run(['node', 'designs/tools/shot.cjs', json.dumps(spec)], capture_output=True, text=True)
    bad = [e for e in json.loads(r.stdout) if e.get('overflowX') or e.get('events')] if r.returncode == 0 else r.stderr
    print(d, 'ok' if not bad else bad)
