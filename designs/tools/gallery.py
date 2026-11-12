# Screenshots for the comparison page (designs/dist/compare/). Run from the folder that
# contains designs/, after python3 designs/build.py.
import json, subprocess, sys
designs = ['datasheet', 'coursebook', 'exploded', 'current']
desktop = [('home', '#/'), ('guide', '#/guides/configuration'), ('address-map', '#/reference/address-map/uart'),
           ('datapath', '#/architecture/datapath/base'), ('tutorial', '#/tutorials/instantiate-core'),
           ('guides', '#/guides'), ('roadmap', '#/roadmap'), ('architecture', '#/architecture'),
           ('caches', '#/architecture/caches'), ('bus', '#/architecture/system-bus'), ('concepts', '#/reference/peripherals/i2c'),
           ('generator', '#/tools/peripheral-docs')]
for d in designs:
    shots = [{'name': d + '-' + n, 'hash': h, 'width': 1440, 'height': 900, 'dsf': 0.5, 'wait': 700 if 'arch' in h else 250} for n, h in desktop]
    shots += [{'name': d + '-dark', 'hash': '#/guides/configuration', 'width': 1440, 'height': 900, 'dsf': 0.5, 'theme': 'dark'},
              {'name': d + '-phone-home', 'hash': '#/', 'width': 390, 'height': 844, 'dsf': 1, 'mobile': True},
              {'name': d + '-phone-guide', 'hash': '#/guides/firmware', 'width': 390, 'height': 844, 'dsf': 1, 'mobile': True},
              {'name': d + '-phone-datapath', 'hash': '#/architecture/datapath/base', 'width': 390, 'height': 844, 'dsf': 1, 'mobile': True, 'wait': 700},
              {'name': d + '-phone-nav', 'hash': '#/reference/address-map', 'width': 390, 'height': 844, 'dsf': 1, 'mobile': True,
               'before': 'document.getElementById("menu-button").click()', 'wait': 400}]
    spec = {'site': 'designs/dist/' + d, 'out': 'designs/dist/compare', 'shots': shots}
    r = subprocess.run(['node', 'designs/tools/shot.cjs', json.dumps(spec)], capture_output=True, text=True)
    bad = [e for e in json.loads(r.stdout) if e.get('overflowX') or e.get('events')] if r.returncode == 0 else r.stderr
    print(d, 'ok' if not bad else bad)
