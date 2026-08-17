# Axis — variable font editor

Upload a static TrueType font, define variation axes, preview them live, and export a single
variable `.ttf`.

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

Only TrueType outlines are supported. CFF-based `.otf` files and `.ttc` collections are rejected
with a message rather than silently mangled.

## Development

```bash
npm run dev
```

To check binary output outside the browser, build a font on the command line and inspect it with
[fontTools](https://github.com/fonttools/fonttools):

```bash
npx tsx scripts/smoke.ts C:/Windows/Fonts/arial.ttf out.ttf
```

## Layout

- `lib/font/` — the font engine, browser-safe and free of React
  - `binary.ts` big-endian reader/writer · `sfnt.ts` table directory and checksums
  - `glyf.ts` outline parsing, composite decomposition, glyph serialisation
  - `transform.ts` the deformation operations · `axes.ts` axis presets and validation
  - `gvar.ts`, `fvar.ts`, `name.ts` table writers · `build.ts` assembles the font
- `lib/store.ts` — application state, debounced rebuild, live `FontFace` registration
- `components/` — the editor UI
