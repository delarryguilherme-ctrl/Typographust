/**
 * Builds a variable font outside the browser so the binary output can be
 * validated with fontTools.
 *
 *   npx tsx scripts/smoke.ts C:/Windows/Fonts/arial.ttf out.ttf
 *   npx tsx scripts/smoke.ts Inter-Regular.otf Inter-Bold.otf Inter-Italic.woff2 out.ttf
 *
 * The last argument is the output; every argument before it is a source.
 * Several sources become a family: the extra weights and italics are used as
 * drawn masters.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildStaticFonts, buildVariableFont, loadFaces } from "../lib/font/build";
import { defaultInstances, makeAxis, makeFamilyAxes, makeStop, type AxisDef, type CornerMaster } from "../lib/font/axes";
import { assembleFamily } from "../lib/font/family";
import { analyzeFigures, DEFAULT_FIGURES } from "../lib/font/figures";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("usage: npx tsx scripts/smoke.ts <source…> <output.ttf>");
    process.exit(1);
  }
  const output = args.pop()!;

  const faces = [];
  for (const input of args) {
    faces.push(...(await loadFaces(new Uint8Array(readFileSync(input)), input.split(/[\\/]/).pop()!)));
  }

  const started = Date.now();
  const source = assembleFamily(faces);
  console.log(
    `source: ${source.familyName} ${source.subfamilyName} [${source.format}] · ${source.metrics.numGlyphs} glyphs · ` +
      `${source.metrics.unitsPerEm} upem · weight ${source.shape.weight} · stem ${Math.round(source.shape.stem)}u` +
      ` · assembled in ${Date.now() - started}ms`,
  );
  for (const role of source.roles) {
    const face = faces.find((f) => f.id === role.id)!;
    const detail =
      role.role === "master"
        ? `${role.drawn}/${role.total} glyphs drawn`
        : role.role === "excluded"
          ? role.reason
          : "default";
    console.log(`  ${role.role.padEnd(8)} ${face.subfamilyName.padEnd(18)} w${role.weight}${role.italic ? " italic" : ""} · ${detail}`);
  }
  for (const note of source.notes) console.log(`  note: ${note}`);

  const figures = analyzeFigures(source);
  console.log(
    `figures: ${figures.tabular ? "tabular" : "proportional"} by default · features [${figures.features.join(" ")}]` +
      ` · generates ${figures.generates ?? "nothing"}`,
  );

  let axes: AxisDef[];
  let corners: CornerMaster[];
  if (source.drawn.length > 0) {
    ({ axes, corners } = makeFamilyAxes(source.shape, source.drawn));
  } else {
    axes = [makeAxis("wght", source.shape), makeAxis("slnt", source.shape)];
    corners = [];
  }
  axes.push(makeAxis("wdth", source.shape), makeAxis("opsz", source.shape), makeAxis("GRAD", source.shape));

  // Give the width axis a hand-tuned intermediate master, so the export exercises
  // gvar's intermediate regions rather than only the plain min/max case.
  const wdth = axes.find((a) => a.tag === "wdth")!;
  wdth.stops.push(makeStop(112, { widthScale: 1.05, weight: 12 }));
  wdth.stops.sort((a, b) => a.at - b.at);
  for (const axis of axes) {
    console.log(
      `${axis.tag} ${axis.min}–${axis.def}–${axis.max}: ` +
        axis.stops.map((s) => `${s.at}${s.faceId ? "*" : ""}`).join(" ") +
        "   (* = drawn)",
    );
  }
  for (const c of corners) console.log(`corner: ${JSON.stringify(c.coords)}`);

  const options = { familyName: "Smoke Test", axes, corners, instances: defaultInstances(axes), figures: DEFAULT_FIGURES };

  const buildStarted = Date.now();
  const result = buildVariableFont(source, options);
  console.log(`built in ${Date.now() - buildStarted}ms · ${result.masterCount} masters · ${result.data.length} bytes`);
  for (const warning of result.warnings) console.log(`warning: ${warning}`);

  writeFileSync(output, result.data);
  console.log(`wrote ${output}`);

  // A couple of flattened instances, so the static path gets checked too.
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
}

void main();
