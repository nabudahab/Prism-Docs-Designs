# Design prototypes

Alternative front ends for the Prism documentation site: three directions,
and two unified designs that combine the parts of them chosen for keeping. Each is a
different shell, navigation and visual system over the same pages: no design
holds a copy of any documentation.

| Design | Direction |
| --- | --- |
| `datasheet` | Engineering reference: contents tree, ruled tables, address-space figure, find by register or address |
| `coursebook` | Educational text: ordered course outline, reading column, saved progress, tutorial checklist |
| `exploded` | Platform landing: section panels in a top bar, full-width pages, the SoC drawn apart into its layers |
| `unified-claude` | Unified A: contents tree in reading order with search at its head, dark landing band with the exploded layers, beam on the architecture overview |
| `unified-sol` | Unified B: the same parts on one light surface, with the contents tree in reference order |
| `unified-c` | Unified C: Unified B with one serif type system (sans and mono kept for technical material) and contents that fold below the second level |

## Palettes

A design may hold colour palettes in `designs/<name>/palettes/<palette>.css`.
The build writes each as its own site, `designs/dist/<name>-<palette>/`: the
same design with the palette loaded after `design.css` and named in
`data-palette` on `<html>`. A palette sets colour tokens only, for both themes.
Unified C has `mono`, `current` and `indigo` palettes and three more by
Claude Fable 5.2.

## Build and view

```sh
python3 designs/build.py                 # every design, into designs/dist/<name>/
python3 designs/build.py datasheet       # one design
```

Open `designs/dist/index.html` to compare them, or a design's own
`designs/dist/<name>/index.html`. `designs/dist/current/` is the existing site,
built from the same content, for side-by-side reading.

Content comes from `--content-root`, a Prism-Website checkout that the build
only reads. It defaults to the frozen snapshot in `designs/build/snapshot/`
when one exists, otherwise to this checkout. To pick up newer content:

```sh
python3 designs/build.py --content-root ../Prism-Website
```

## How a design is put together

`build.py` stages the canonical site with the content checkout's own
`scripts/build.py`, so the pages, data, simulators and the private-reference
check are exactly the canonical ones. For each design it then:

- replaces `index.html` with the design's `shell.html`, filling in the
  canonical stylesheet and script lists read from the canonical `index.html`;
- joins the canonical stylesheets into `assets/canon.css`, loaded before the
  design's `design.css`, so a design restyles components and anything it
  leaves alone keeps the canonical presentation;
- writes the canonical navigation as `data/nav.js` and adds the shared
  `kit/kit.js` and the design's files under `assets/design/`.

The canonical `app.js` renders every page into `#main` unchanged. `kit.js`
runs after it and gives a design the site's pages, the current route, an
outline of the rendered page and a search index over the generated data; the
design's `design.js` builds navigation from those. A shell must keep the
elements `app.js` looks up at load; the build stops and names any it lacks.

Page lists come from the canonical navigation and from the generated guides
and tutorials, grouped by route (`#/guides/…`, `#/reference/…`), so a page or
guide added to the content appears in every design's navigation by itself.

## Checking

```sh
node designs/tools/audit.cjs             # every page, five screen sizes, both themes, the tools
node designs/tools/shot.cjs '<spec>'     # screenshots; the spec format is in the file
python3 designs/tools/gallery.py [design ...]   # the comparison page's screenshots
python3 designs/tools/gallery.py --palettes unified-c-mono   # light and dark shots of one palette
```

All three drive headless Chrome over the built files and need the `ws` module.

## Fonts

The designs bundle open-licensed typefaces (SIL Open Font License 1.1) as
Latin subsets from Fontsource. Each design's `fonts/licenses/` holds the
licence texts, which are published with the fonts.

| Design | Typefaces |
| --- | --- |
| `datasheet` | Barlow, Barlow Semi Condensed, IBM Plex Mono |
| `coursebook` | Charis SIL, Atkinson Hyperlegible Next, Atkinson Hyperlegible Mono |
| `exploded` | Archivo, Commit Mono |
| `unified-claude`, `unified-sol`, `unified-c` | Charis SIL, Atkinson Hyperlegible Next, Atkinson Hyperlegible Mono |
