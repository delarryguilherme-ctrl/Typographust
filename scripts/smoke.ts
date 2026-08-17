/**
 * Builds a variable font from a static TTF outside the browser so the binary
 * output can be validated with fontTools.
 *
 *   npx tsx scripts/smoke.ts C:/Windows/Fonts/arial.ttf out.ttf
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildStaticFonts, buildVariableFont, loadSource } from "../lib/font/build";
import { defaultInstances, makeAxis, makeStop } from "../lib/font/axes";

const input = process.argv[2];
const output = process.argv[3] ?? "smoke-out.ttf";

const data = new Uint8Array(readFileSync(input));
const source = loadSource(data, input.split(/[\\/]/).pop()!);
console.log(
  `source: ${source.familyName} · ${source.metrics.numGlyphs} glyphs · ${source.metrics.unitsPerEm} upem` +
    ` · declared weight ${source.declaredWeight} · measured stem ${Math.round(source.shape.stem)}u` +
    ` → weight ${source.shape.weight}${source.weightMismatch ? " (using the measurement)" : ""}`,
);

const axes = [
  makeAxis("wght", source.shape),
  makeAxis("slnt", source.shape),
  makeAxis("wdth", source.shape),
  makeAxis("opsz", source.shape),
  makeAxis("GRAD", source.shape),
];

// Give the width axis a hand-tuned intermediate master, so the export exercises
// gvar's intermediate regions rather than only the plain min/max case.
const wdth = axes.find((a) => a.tag === "wdth")!;
wdth.stops.push(makeStop(112, { widthScale: 1.05, weight: 12 }));
wdth.stops.sort((a, b) => a.at - b.at);
console.log(`wght masters: ${axes[0].stops.map((s) => s.at).join(", ")} (default ${axes[0].def})`);
console.log(`wdth masters: ${wdth.stops.map((s) => s.at).join(", ")} (default ${wdth.def})`);

const options = { familyName: "Smoke Test", axes, instances: defaultInstances(axes) };

const started = Date.now();
const result = buildVariableFont(source, options);

console.log(`built in ${Date.now() - started}ms · ${result.masterCount} synthetic masters · ${result.data.length} bytes`);
for (const warning of result.warnings) console.log(`warning: ${warning}`);

writeFileSync(output, result.data);
console.log(`wrote ${output}`);

// A couple of flattened instances, so the static path gets checked too. The
// point of interest is whether they match the variable font at the same
// coordinate — validate.py compares them.
const staticsStarted = Date.now();
const statics = buildStaticFonts(source, options);
console.log(`\n${statics.length} statics in ${Date.now() - staticsStarted}ms`);
for (const name of ["Bold", "Light Italic"]) {
  const font = statics.find((s) => s.styleName === name);
  if (!font) continue;
  const path = output.replace(/\.ttf$/, `.${font.fileName}`);
  writeFileSync(path, font.data);
  console.log(`  ${font.fileName} → ${path}`);
}
