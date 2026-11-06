# Axis — variable font editor
<img width="1623" height="1302" alt="screencapture-delarryguilherme-ctrl-github-io-Typographust-2026-08-17-17_07_19" src="https://github.com/user-attachments/assets/74724092-0284-42be-b38d-8eef377f1c42" />
Upload a static font — or several weights and italics of one family — define variation axes, preview
them live, and export a single variable `.ttf`. Reads `.ttf`, `.otf` (CFF and CFF2), `.woff`, `.woff2`,
`.ttc` and `.otc`.

## What it actually does

A font with one master has no information about how it should look at other weights. This tool
does not invent that information — it **synthesises masters** by transforming the outlines you
upload, then writes those transforms out as real `fvar`/`gvar` variation data.

The weight ramp is calibrated against the font in front of it. On upload, every glyph is crossed
with a horizontal scanline through the middle of its bounding box and the narrowest run of ink is
recorded; the median across the whole font is the stem thickness. Stems then follow a geometric
progression — each 100 weight steps multiplies thickness by about 1.17 — which never crosses zero,
so extrapolating downward from a heavy source stays valid. Because the measurement needs no
`cmap`, it works on a font with no Latin in it.

If that measurement disagrees with `usWeightClass` by more than 100, the measurement wins and the
Source panel says so. Fonts misdeclare their weight often enough that trusting the label would
anchor the whole ramp in the wrong place.

An axis carries as many **masters** as you want. Each one sits at a coordinate on the axis and is
a recipe of outline operations applied to the source. The axis default needs no master — that
position *is* the uploaded outline. Masters that push the drawing past roughly half its stem
thickness — or scale it past ±20%, or shear it past 15° — are flagged, because that is where the
synthesis stops being believable.

Two masters give a plain linear axis. More let each position be shaped on its own: a weight axis
with masters at every hundred can have 500 retuned without touching 400 or 600, because each
master is written as a gvar tuple with an intermediate region covering only its neighbours.

The operations available at each master:

| Control  | Effect                                                                       |
| -------- | ---------------------------------------------------------------------------- |
| Weight   | Offsets every point along its contour normal — thickens or thins stems        |
| Grade    | Same, but the advance width is left untouched (`GRAD` behaviour)              |
| Slant    | Shears the outline around the baseline — the basis of synthetic italics       |
| Width    | Horizontal scale, applied to outlines and advances together                   |
| Height   | Vertical scale around the baseline                                            |
| Tracking | Uniform advance change, centred so sidebearings stay balanced                 |
| Advance  | Extra advance change on top of the above                                      |
| Y shift  | Vertical displacement                                                         |

Because every operation preserves point count and order, gvar deltas can be computed by
subtracting the default master from each synthetic one. That is what makes a single-master
source workable at all.

Peaks are written into gvar's shared tuple array rather than embedded per glyph. Embedded peaks
are equally legal, but HarfBuzz — and therefore Chrome — ignored the intermediate regions on
them in testing, silently falling back to linear interpolation.

**This is not a substitute for drawn weights.** Contour offsetting rounds sharp joins, ignores
the optical corrections a type designer would make, and degrades at extreme deltas. It is good
for prototyping, mockups and internal tooling — not for shipping a retail typeface.

A master only shows up in the preview at its own coordinate, so selecting one — or touching any
of its controls — moves the preview there. Adding a master copies whatever the axis already
produces at that coordinate, so inserting one changes nothing until you edit it.

## Uploading a family

One master can only be stretched so far. Drop the weights you have — Regular and Bold, say, plus the
italics — and they become **drawn masters**: real outlines written as gvar deltas, so the axis
interpolates between drawings instead of synthesising them.

- The default is the upright closest to 400; its tables (cmap, kerning, features, names) are the ones
  carried into the export. Every other face only contributes outlines and advances.
- Uprights land on `wght` at their declared weight. If the declared weights clash with how heavy the
  drawings measure, the measurements place them instead.
- An italic at the default weight becomes the `ital` master. Italics at other weights become **corner
  masters** — a Bold Italic at (wght 700, ital 1) — whose regions span both axes, exactly as fontTools'
  `VariationModel` lays them out.
- Synthetic stops are only added outside the drawn range, and each one deforms the nearest drawn
  master: a Black past an uploaded Bold starts from the Bold drawing, not from the Regular.
- Faces from another family, another width or another units-per-em are listed but left out.

Glyphs are matched by code point, then by glyph name, then by position when two fonts share a glyph
order. Outlines then have to correspond point for point, which statics of one family often do not
quite: a CFF optimiser turns a flat curve into a line in one weight only, or TrueType leaves an
on-curve point implied in one and explicit in the other. Contours are therefore matched by position,
size and winding (the outside of an "o" and its counter share a centre), start points are found by
rotation, and segments are promoted to the highest degree any master uses. CFF outlines are converted
to quadratics jointly, so every master splits a curve the same number of times.

A glyph that still cannot be matched falls back to synthesis at that master — the measured stem
difference as a weight offset, the italic angle as a shear — but keeps the drawn glyph's real advance
and ink centre. The Sources panel shows how much of each face is drawn.

## Tabular and proportional figures

Tables need digits that share one advance (`tnum`); running text reads better with digits spaced to
their shapes (`pnum`). Design tools only offer the choice when the font has both — Figma's Type details
→ Numbers lists Monospace and Proportional from exactly these features.

Most fonts ship one kind as the default figures. The editor generates the other kind as ten new glyphs
(`zero.tf` … or `zero.pf` …) and the GSUB features that switch between them:

- **Tabular**: every digit gets the same advance — the widest digit by default, adjustable — with the
  extra space split evenly on both sides, which keeps the optical offset built into each digit's
  sidebearings.
- **Proportional**: loose sidebearings (the 1 above all) are tightened to what the widest digit uses.

Only spacing changes; the drawings are not touched. The new glyphs are derived inside every master
from that master's own digits, so tabular figures keep one shared advance at every point in the design
space.

The source's GSUB is kept byte for byte. A new header, script list, feature list and lookup list are
written in front of it, and each original lookup becomes an Extension lookup pointing into the
untouched subtables — lookup indices do not change, so nothing that already worked stops working.

## The slider

Every numeric control is the same component (`components/Slider.tsx`): the track is the whole
control surface, with the label and value floating inside it. Drag anywhere for continuous
control; click to snap to the nearest decile with a spring; press and hold the value for 800ms to
type an exact number; drag past either end and the card rubber-bands, after a dead zone. Ticks
and the handle only appear while you are on the control. Arrow keys step (hold Shift for ×10),
Home/End jump to the ends, and double-click resets to the default.

## Axes

Registered axes (`wght`, `wdth`, `slnt`, `ital`, `opsz`, `GRAD`) come with sensible starting
recipes. Any custom 4-character tag can be added — `TRML`, `VOLT`, whatever the design calls for.
Custom tags must contain an uppercase letter; all-lowercase tags are reserved for registered axes
and the editor will refuse to export one.

## What the export contains

Two artifacts. **Download variable .ttf** gives the font itself. **Statics .zip** flattens every
named instance into its own static `.ttf` — the reliable path when an app will not drive the axes.
Statics are produced by summing gvar deltas exactly as a renderer would, so a static is identical
to what the variable font shows at the same coordinate, not merely close to it.

Static names use both models at once: typographic family and subfamily (`nameID` 16/17) so modern
tools collect every weight into one family with a style menu, and the legacy RIBBI split
(`nameID` 1/2) — `Family Light` / `Italic` for anything outside Regular/Bold/Italic/Bold Italic —
so older tools still behave. `OS/2.fsSelection`, `head.macStyle` and `usWeightClass` are set per
instance.

The family name is suffixed with `VF` by default so the export never resolves to a static of the
same name that is already installed.

- `fvar` with every axis and named instance
- `gvar` with per-glyph deltas, including phantom points so advance widths vary correctly
- `STAT` with design axes and named positions for `wght`, `wdth`, `ital` and `slnt`
- A rebuilt `name` table with axis names, instance names and PostScript names
- Rebuilt `glyf`/`loca`/`hmtx`/`hhea`/`maxp`/`head`

Composite glyphs are decomposed and TrueType hinting is dropped (`fpgm`, `prep`, `cvt `), since
decomposed and deformed outlines can't honour the original instructions.

CFF and CFF2 outlines are converted to TrueType quadratics within a tolerance of one unit per
thousand em; CFF2 sources are read at their default instance. Every container — WOFF, WOFF2 (Brotli
and the transformed `glyf`/`hmtx`), TTC/OTC — is unwrapped to plain tables first. Bitmap- and SVG-only
fonts have no outlines to vary and are refused.

## Development

```bash
npm run dev
```

Builds run in a Web Worker so the page stays responsive. The worker is bundled separately by esbuild
(`npm run worker`, run automatically before `dev` and `build`) into `public/build-worker.js`.

To check binary output outside the browser, build a font on the command line and inspect it with
[fontTools](https://github.com/fonttools/fonttools):

```bash
npx tsx scripts/smoke.ts C:/Windows/Fonts/arial.ttf out.ttf
npx tsx scripts/smoke.ts Inter-Regular.otf Inter-Bold.otf Inter-Italic.woff2 out.ttf
```

The last argument is the output; everything before it is a source.

## Layout

- `lib/font/` — the font engine, browser-safe and free of React
  - `binary.ts` big-endian reader/writer · `sfnt.ts` table directory and checksums
  - `container.ts` sfnt, TTC/OTC, WOFF and WOFF2 unwrapping · `cff.ts` CFF/CFF2 charstrings
  - `glyf.ts` outline parsing, composite decomposition, glyph serialisation
  - `face.ts` reads and measures one uploaded font · `family.ts` matches faces into masters
  - `curves.ts` contour alignment, segment promotion, cubic → quadratic
  - `model.ts` master locations → gvar regions and deltas (fontTools' `VariationModel`)
  - `figures.ts` tabular/proportional figures · `gsub.ts` adds features to an existing GSUB
  - `cmap.ts`, `post.ts`, `stdnames.ts` code points and glyph names
  - `transform.ts` the deformation operations · `axes.ts` axis presets and validation
  - `gvar.ts`, `fvar.ts`, `name.ts` table writers · `build.ts` assembles the font
- `lib/store.ts` — application state, debounced rebuild, live `FontFace` registration
- `lib/build.worker.ts`, `lib/buildClient.ts` — the build worker and the client that supersedes stale builds
- `components/` — the editor UI
