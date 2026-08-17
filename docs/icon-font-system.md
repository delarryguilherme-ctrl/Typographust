# From a variable text font to a variable icon system

Two parts. The first records what building the Typographust variable-font editor actually taught
us about writing OpenType binaries by hand — including the mistakes, because the mistakes are the
expensive part. The second is a build plan for the icon system, written on top of that knowledge.

---

# Part 1 — What the font editor established

## The shape of the pipeline

Turning a static TrueType font into a variable one comes down to five steps:

1. **Parse the sfnt table directory** into a `tag → bytes` map.
2. **Parse `glyf`/`loca`**, decomposing composite glyphs into plain contours.
3. **Generate masters** by transforming the default outlines.
4. **Compute `gvar` deltas** by subtracting the default master from each generated one.
5. **Reassemble** the font: rebuilt `glyf`/`loca`/`hmtx`/`hhea`/`maxp`/`head`, new `fvar`/`gvar`/
   `STAT`/`name`, and dropped hinting tables.

Everything else is detail. But the details are where the time goes.

## The constraint that decides everything

**`gvar` deltas are per point index.** A master can only be expressed as a delta if it has the
same number of contours, the same number of points, in the same order, as the default. There is
no matching, no resampling, no tolerance — index 47 in the master must be the same conceptual
point as index 47 in the default.

This single fact explains most of the architecture:

- Composite glyphs must be **decomposed**, because a composite's points live in its components and
  the point numbering is defined differently for composites.
- Masters must be produced by **transforms that preserve point structure** — offsetting, shearing,
  scaling. Anything that adds, removes, or reorders points is unusable.
- Hinting must be **dropped**, because decomposed and deformed outlines cannot honour instructions
  written for the original.

For a text font this is a limitation you work around. For an icon system it is something you can
design *for*, which is the central insight of Part 2.

## Eight things that cost time

### 1. Table field offsets are easy to get wrong and fail silently

Writing `maxPoints` at `maxp` offset 4 overwrites `numGlyphs`. The font still loaded; `gvar`
parsing failed later with a glyph-count mismatch, several layers away from the cause.

Verified layouts:

```
maxp   0 version(F)  4 numGlyphs  6 maxPoints  8 maxContours
      10 maxCompositePoints 12 maxCompositeContours 14 maxZones
      16 maxTwilightPoints  18 maxStorage  20 maxFunctionDefs
      22 maxInstructionDefs 24 maxStackElements 26 maxSizeOfInstructions
      28 maxComponentElements 30 maxComponentDepth

head   0 major 2 minor 4 fontRevision(F) 8 checkSumAdjustment 12 magic
      16 flags 18 unitsPerEm 20 created(8) 28 modified(8)
      36 xMin 38 yMin 40 xMax 42 yMax 44 macStyle 46 lowestRecPPEM
      48 fontDirectionHint 50 indexToLocFormat 52 glyphDataFormat

hhea   0 version(F) 4 ascender 6 descender 8 lineGap 10 advanceWidthMax
      12 minLeftSideBearing 14 minRightSideBearing 16 xMaxExtent
      18 caretSlopeRise 20 caretSlopeRun 22 caretOffset
      24..31 reserved 32 metricDataFormat 34 numberOfHMetrics

OS/2   0 version 2 xAvgCharWidth 4 usWeightClass 6 usWidthClass
```

Patch a field, then immediately re-read the whole table with an independent parser. Do not batch
several patches and check at the end.

### 2. `head.checkSumAdjustment` has an order of operations

Zero the field, checksum the entire file, write `0xB1B0AFBA - sum` back. Doing it in any other
order produces a font most renderers still accept, which is worse than an outright failure.

### 3. Phantom points are how advance width varies

Every glyph's delta array has four extra entries after its real points:

```
index n     left sidebearing point
index n+1   advance width point      ← x-delta here changes the advance
index n+2   top sidebearing point
index n+3   bottom (vertical advance)
```

Without `HVAR`, this is the *only* mechanism that makes advances vary. Omit them and every
instance renders at the default's metrics — outlines get heavier, spacing does not, and the result
looks subtly broken in a way that is hard to name.

### 4. The `gvar` region chain

Given normalised peaks on one side of the default, sorted outward as `p₁ … pₙ`:

```
region(pᵢ) = ( start = pᵢ₋₁ or 0 ,  peak = pᵢ ,  end = pᵢ₊₁ or ±1 )
```

Each master's deltas stay relative to the **default**, not to its neighbours. The overlapping
regions produce the linear blend on their own — at `pᵢ` every other region evaluates to zero, so
the value there is exactly `default + deltaᵢ`. No cumulative correction is needed for a chain
along a single axis.

A region only has to be written out when it differs from the one implied by the peak alone, which
is `min(peak, 0) … max(peak, 0)`. That implied region is a triangle that collapses at the peak,
so **any peak that is not at ±1 needs an explicit region**, or it contributes nothing past its own
coordinate.

### 5. Shared tuples, not embedded peaks

This one cost the most and would never have been found by reading the spec.

Peaks can be written two ways: embedded in each tuple header (`EMBEDDED_PEAK_TUPLE`, `0x8000`), or
referenced by index into the table's shared tuple array. Both are legal. fontTools reads both and
reports identical regions for both.

**HarfBuzz — and therefore Chrome — ignored the intermediate regions on embedded peaks**, silently
falling back to linear interpolation between the outer masters. Measured on the same logical font,
same regions, only the encoding differing:

| wdth | embedded peaks | shared tuples | correct |
| ---- | -------------- | ------------- | ------- |
| 106  | 1374           | 1336          | 1336    |
| 112  | 1456           | 1380          | 1380    |
| 118  | 1538           | 1497          | 1497    |

No error, no warning, no rejected font. Just quietly wrong curves. **Use the shared tuple array.**
It is also smaller — the same font went from 8.51 MB to 7.76 MB.

### 6. Custom axis tags must not be all lowercase

All-lowercase four-character tags are reserved for registered axes (`wght`, `wdth`, `slnt`, `ital`,
`opsz`). A custom axis needs at least one uppercase character — `FILL`, `GRAD`, `ROND`. Validate
this before export; some tools accept a bad tag and then behave unpredictably.

### 7. `STAT` is required whenever `fvar` exists

A minimal valid `STAT` is design axis records plus `axisValueCount = 0` and an
`elidedFallbackNameID`. Axis values are only worth emitting for positions with a defensible public
name — weight classes, width classes, Roman/Italic. Leaving an axis with no named positions is
legal and better than inventing names.

### 8. Testing lessons that had nothing to do with fonts

- **Validate in the target engine, not only in the toolkit.** fontTools accepted output that Chrome
  mis-rendered. The decisive technique was A/B: build the font, have fontTools re-save it, load
  *both* in the browser and compare. Identical logical content, different bytes — the difference
  isolates the encoding bug immediately.
- **A hidden browser pane does not composite.** `requestAnimationFrame` never fires, timers are
  throttled, and any measurement of an animated value reads as its initial state. Several
  "failures" were the harness, not the code. Measure state (attributes, layout) rather than
  animation.
- **Key repeat outruns React rendering.** Ten rapid arrow presses computed from the same stale
  prop and produced one step. Step from a ref holding the last committed value.
- **Tailwind class order in the attribute does not decide the winner.** A base `w-full` beat a
  caller's `w-[68px]`; both have the same specificity and the stylesheet order decides. Do not put
  a width in a shared base class if callers need to override it.

## The validation loop worth reusing

```bash
# 1. build headlessly, outside the browser
npx tsx scripts/smoke.ts <input.ttf> out.ttf

# 2. structural check: does an independent parser agree?
python validate.py out.ttf      # fontTools: read fvar/gvar/STAT, instantiate, re-save

# 3. engine check: does the real target render it correctly?
#    load out.ttf AND fontTools' re-saved copy in the browser, measure both
```

Step 3 is the one people skip and the one that found the real bug.

---

# Part 2 — The icon system

## What you are building

An editor that takes a set of icons and produces a variable font (and vectors) where the designer
controls stroke width, fill style, corner radius and optical size as live axes — the SF Symbols
idea, but authored by you and exportable.

There is a direct precedent worth studying rather than guessing at:
**Google's Material Symbols** ships exactly this, as a single variable font with axes
`FILL` (0–1), `wght` (100–700), `GRAD` (−50–200) and `opsz` (20–48). Every question below has an
answer already shipped in that font; when in doubt, instantiate it with fontTools and look.

## The thing that makes this project *easier* than the text font

For the text editor, we received a finished, filled outline and had to approximate a heavier
version of it by pushing points along their normals. It works, but it is an approximation, and it
degrades at the extremes.

For icons, **you control how the outline is generated**. If the source is a centreline drawing and
you outline it yourself, you can guarantee that every master emits the same points in the same
order by construction. The `gvar` point-compatibility constraint stops being a limitation and
becomes free.

That inverts the architecture. Do not build an SVG importer that flattens arbitrary artwork and
then tries to thicken it. Build a **parametric stroker**, and treat the icon source as instructions
for it.

### Source format

Each icon is a list of primitives on a fixed grid (say 24×24, matching your largest size):

```ts
type Primitive =
  | { kind: "path"; points: Vec2[]; closed: boolean; corners: number[] }  // centreline
  | { kind: "circle"; center: Vec2; radius: number }
  | { kind: "rect"; at: Vec2; size: Vec2; corners: number[] };
```

`corners` carries a per-vertex radius weight, so the `ROND` axis has something to act on.

If you also need to ingest existing SVG icons: their paths are already outlines, not centrelines.
You can either (a) run them through the same emboldening approximation this project uses, and
accept the same compromise, or (b) skeletonise them, which is a research problem. Be honest with
yourself about which one you are doing. The parametric route only pays off if the icons are
authored for it.

### The stroker, and why its point count must be fixed

Outlining a centreline means offsetting it by ±½·strokeWidth and closing the ends. The rule that
makes it interpolatable:

> Every join and every cap always emits the same number of points, regardless of the parameter
> values. A round cap sampled at 8 points is sampled at 8 points at every stroke width. A corner
> with radius 0 emits the same points as a corner with radius 4 — they are merely coincident.

Coincident points are legal, render as nothing, and interpolate cleanly. This is the mechanism
that lets a shape appear and disappear along an axis, and you will use it repeatedly.

Write the stroker so it is a pure function `(icon, parameters) → outline`, with the point layout
determined only by the icon, never by the parameters. Then a master is just a call with different
parameters, and deltas are a subtraction.

## Mapping your features onto axes

| Feature       | Tag    | Mechanism                                   | Interpolates? |
| ------------- | ------ | ------------------------------------------- | ------------- |
| Stroke width  | `wght` | stroker offset distance                     | yes           |
| Fill          | `FILL` | inner contour collapses to zero area        | yes           |
| Corner radius | `ROND` | per-corner arc radius, fixed sample count   | yes           |
| Optical size  | `opsz` | stroke compensation + spacing               | yes, with care |
| Grade         | `GRAD` | stroke offset with no advance change        | yes           |
| Duotone       | —      | `COLR`/`CPAL` layers, **not** an axis        | see below     |

### Stroke width → `wght`

Use `wght`, not a custom tag. It means `font-weight` in CSS drives it, design tools put it in the
style dropdown, and named instances line up with the weight names everyone already knows. Material
Symbols uses 100–700; SF Symbols spans Ultralight to Black.

The lesson from Part 1 applies: make the ramp **geometric**, not linear. Stroke width at weight
`w` should be `S₀ × r^((w−w₀)/100)` for a fixed ratio (≈1.17 works). A linear ramp extrapolating
downward from a heavy default crosses zero and inverts the outline.

### Fill / outline → `FILL` 0→1

An outlined icon has an outer contour and an inner one; a filled icon has only the outer. That is
a topology change, and topology changes do not interpolate — *unless you keep the topology
constant and vary the geometry*.

Always emit the inner contour. At `FILL = 0` it sits at its normal offset. At `FILL = 1` it
collapses onto the outer contour's path, enclosing zero area and disappearing. Point count never
changes; the icon fills in continuously as the axis moves.

Watch the winding: the inner contour must wind opposite to the outer for the non-zero fill rule to
punch a hole. As it collapses, it should not cross the outer contour, or you will get flickering
self-intersections mid-interpolation. Clamp the offset so the two never pass through each other.

### Duotone → `COLR`/`CPAL`, and it is not an axis

Two-colour icons need actual colour, which `gvar` has nothing to say about. The mechanism is
`COLR` v0 plus `CPAL`:

- `CPAL` holds the palette.
- `COLR` maps a base glyph to an ordered list of *layer glyphs*, each with a palette index.
- **Layer glyphs are ordinary glyphs**, so they get their own `gvar` deltas — the duotone artwork
  varies with `wght` and `FILL` exactly like everything else.

So duotone costs you extra glyphs (one per layer per icon), not a different pipeline. Toggling
between monotone and duotone is a *font-level or glyph-level* choice, not an axis: ship the
duotone variants as separate glyphs selected by a stylistic set (`ss01`) or as separate codepoints.

Support caveat: browsers handle `COLR` v0 well. Design-tool support is inconsistent and worth
testing before you commit — verify in whatever you actually design in rather than trusting a
compatibility table.

### Corner radius → `ROND`

Custom tag, uppercase. Each corner is sampled with a fixed number of points along its arc; radius 0
collapses them to the corner vertex. Because the sample count is fixed, radius interpolates
smoothly, including all the way to zero.

Decide early whether radius is absolute (font units) or relative to stroke width. Relative behaves
better across the weight range — a 2-unit radius that looks right on a thin icon disappears on a
heavy one.

### Size → `opsz`

Two different things hide under "size", and they need different treatment:

1. **Stroke and spacing compensation.** At 16 px a stroke needs to be proportionally heavier and
   the shape slightly more open than at 24 px. This is continuous and interpolates fine — it is
   exactly what `opsz` is for.
2. **Detail removal.** A real icon system draws *fewer elements* at 16 px than at 24 px. That is a
   topology change and it does not interpolate. SF Symbols and Material both handle this by
   shipping separate drawings per size class rather than by interpolating.

If you only need (1), one `opsz` axis covers it. If you need (2), plan for size-specific icon
sources selected by stylistic set or shipped as separate fonts, and set expectations accordingly —
do not try to make `opsz` do it.

## Codepoints, names, and lookup

Icons need a `cmap`, which the text editor never had to write.

- Assign codepoints in the **Private Use Area**, `U+E000`–`U+F8FF` (6,400 slots). Keep the
  assignment stable in a checked-in manifest — changing an icon's codepoint silently breaks every
  document that used it.
- Write `cmap` format 4 for the BMP. If you exceed the PUA, use plane 15 (`U+F0000`+) and format
  12.
- **Name-based lookup** (writing `home` in a text layer and having it become an icon) is a `liga`
  feature in `GSUB`: a ligature substitution mapping the letter sequence to the icon glyph. This
  is how Material Icons works. It is convenient in HTML and a liability in design tools, where it
  can fire inside ordinary words. Ship it as an option, not a default.

## Naming and packaging

Carry over the decisions from the font editor:

- Family name gets an explicit suffix so the variable font never collides with anything already
  installed.
- Static instances use **both** naming models: typographic family/subfamily (`nameID` 16/17) so
  modern tools group them into one family with a style dropdown, and legacy RIBBI (`nameID` 1/2)
  so older tools that only understand Regular/Bold/Italic still behave.
- `nameID` 25 holds the variations PostScript name prefix.

## Export targets

- **Variable `.ttf`** — the primary artifact.
- **Static `.ttf` per named instance**, zipped — the reliable path when a design tool will not
  cooperate with axes.
- **SVG** — nearly free, since the stroker already produces the outline. Emit per icon at a chosen
  axis position, plus optionally an SVG sprite sheet.
- **`.woff2`** — needs a wasm encoder in the browser; compressing outside the app with
  `woff2_compress` is a reasonable trade for a personal tool.

---

# Part 3 — Build order

Each phase should end with something you can look at.

**Phase 1 — Stroker and preview.** Icon source format, the parametric stroker, and a canvas or SVG
preview with live parameter sliders. No font output at all yet. The goal is to confirm the stroker
produces good-looking icons across the full parameter range *and* that its point count is
invariant. Assert that invariant in a test — it is the foundation of everything after.

**Phase 2 — Static font export.** Outline → `glyf`, plus `cmap`, `hmtx`, `head`, `hhea`, `maxp`,
`OS/2`, `post`, `name`. Install it and type an icon. This proves the binary writer independently of
any variation machinery, which is much easier to debug in isolation.

**Phase 3 — One axis.** Add `fvar`, `gvar`, `STAT` with `wght` alone, two masters. Run the Part 1
validation loop: fontTools reads it, fontTools instantiates it, the browser renders it, and the
browser agrees with fontTools.

**Phase 4 — Intermediate masters and the rest of the axes.** Region chains, then `FILL`, `ROND`,
`opsz`, `GRAD`. Re-run the loop after each axis, and specifically check a coordinate *between*
masters every time — that is where the shared-tuple bug hid.

**Phase 5 — Duotone.** `CPAL`, `COLR` v0, layer glyphs. Verify in the browser first, then in your
design tool.

**Phase 6 — Packaging.** Static instance export, zip, SVG export, naming.

## What to steal directly from this project

`lib/font/` is written to be reusable and has no React in it:

- `binary.ts` — big-endian reader/writer with back-patching. Use as is.
- `sfnt.ts` — table directory and checksums. Use as is.
- `glyf.ts` — the *writer* (`writeGlyph`) applies unchanged; the reader is only needed if you
  import existing fonts.
- `gvar.ts` — deltas, packing, regions, shared tuples. Use as is; it is the part that took the
  longest to get right.
- `fvar.ts`, `name.ts` — use as is.
- `transform.ts` — **do not reuse.** Its emboldening is an approximation for outlines you did not
  author. The parametric stroker replaces it entirely and does the job properly.

What you have to write new: SVG/centreline parsing, the stroker, `cmap`, and — only if duotone is
in scope — `COLR`/`CPAL`.

---

## Sources

- [Material Symbols guide](https://developers.google.com/fonts/docs/material_symbols) — axis names
  and ranges for the closest shipping precedent
- [google/material-design-icons](https://github.com/google/material-design-icons) — the actual
  variable font files, worth instantiating and inspecting
- OpenType spec: `gvar`, `fvar`, `STAT`, `COLR`, `CPAL`, `cmap` chapters
