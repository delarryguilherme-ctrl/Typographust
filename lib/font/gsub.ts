import { Reader, Writer } from "./binary";

/**
 * Adds single-substitution features (`tnum`, `pnum`…) to a font's GSUB
 * without disturbing anything already in it.
 *
 * Re-serialising every existing lookup would mean understanding all eight
 * lookup types and their sub-formats. Instead, the original table is kept
 * byte for byte at the end of the new one, and a fresh header, script list,
 * feature list and lookup list are written in front of it. Each original
 * lookup becomes an Extension lookup whose 32-bit offsets point forward into
 * the untouched original subtables. Lookup indices do not change, so
 * contextual lookups that call other lookups keep working.
 *
 * FeatureVariations (GSUB 1.1) is dropped: its conditions refer to the
 * source's own axes, which the export replaces anyway.
 */

export interface SubstitutionFeature {
  tag: string;
  /** [from, to] glyph ids. */
  pairs: [number, number][];
}

interface LangSys {
  required: number;
  features: number[];
}

interface Script {
  tag: string;
  defaultLangSys: LangSys | null;
  langSys: { tag: string; sys: LangSys }[];
}

interface Feature {
  tag: string;
  params: Uint8Array | null;
  lookups: number[];
}

interface LookupRef {
  type: number;
  flag: number;
  markFilteringSet: number | null;
  /** Absolute positions (in the original table) of each real subtable. */
  subtables: number[];
}

interface Parsed {
  scripts: Script[];
  features: Feature[];
  lookups: LookupRef[];
}

/** Feature tags present in GSUB (or GPOS). */
export function featureTags(table: Uint8Array | undefined): string[] {
  if (!table || table.length < 10) return [];
  try {
    const r = new Reader(table);
    r.skip(4);
    r.u16(); // scriptList
    const featureList = r.u16();
    const f = new Reader(table, featureList);
    const count = f.u16();
    const tags = new Set<string>();
    for (let i = 0; i < count; i++) {
      tags.add(f.tag());
      f.u16();
    }
    return [...tags].sort();
  } catch {
    return [];
  }
}

function readLangSys(table: Uint8Array, at: number): LangSys {
  const r = new Reader(table, at);
  r.u16(); // lookupOrderOffset (reserved)
  const required = r.u16();
  const count = r.u16();
  const features: number[] = [];
  for (let i = 0; i < count; i++) features.push(r.u16());
  return { required, features };
}

/** Feature parameter blocks have per-feature layouts; copy the ones that matter. */
function readParams(table: Uint8Array, featureAt: number, featureListAt: number, tag: string, offset: number): Uint8Array | null {
  if (!offset) return null;
  if (tag === "size") {
    // Old Adobe fonts measured this offset from the FeatureList, not the Feature.
    for (const base of [featureAt, featureListAt]) {
      const at = base + offset;
      if (at + 10 > table.length) continue;
      const designSize = new Reader(table, at).u16();
      if (designSize > 0) return table.slice(at, at + 10);
    }
    return null;
  }
  const at = featureAt + offset;
  if (/^ss\d\d$/.test(tag)) return at + 4 <= table.length ? table.slice(at, at + 4) : null;
  if (/^cv\d\d$/.test(tag)) {
    if (at + 14 > table.length) return null;
    const charCount = new Reader(table, at + 12).u16();
    const end = at + 14 + charCount * 3;
    return end <= table.length ? table.slice(at, end) : null;
  }
  return null;
}

function parse(table: Uint8Array): Parsed {
  const h = new Reader(table);
  h.skip(4); // version
  const scriptListAt = h.u16();
  const featureListAt = h.u16();
  const lookupListAt = h.u16();

  const scripts: Script[] = [];
  if (scriptListAt) {
    const r = new Reader(table, scriptListAt);
    const count = r.u16();
    for (let i = 0; i < count; i++) {
      const tag = r.tag();
      const scriptAt = scriptListAt + r.u16();
      const s = new Reader(table, scriptAt);
      const defaultOffset = s.u16();
      const langCount = s.u16();
      const langSys: Script["langSys"] = [];
      for (let k = 0; k < langCount; k++) {
        const langTag = s.tag();
        langSys.push({ tag: langTag, sys: readLangSys(table, scriptAt + s.u16()) });
      }
      scripts.push({ tag, defaultLangSys: defaultOffset ? readLangSys(table, scriptAt + defaultOffset) : null, langSys });
    }
  }

  const features: Feature[] = [];
  if (featureListAt) {
    const r = new Reader(table, featureListAt);
    const count = r.u16();
    for (let i = 0; i < count; i++) {
      const tag = r.tag();
      const featureAt = featureListAt + r.u16();
      const f = new Reader(table, featureAt);
      const paramsOffset = f.u16();
      const n = f.u16();
      const lookups: number[] = [];
      for (let k = 0; k < n; k++) lookups.push(f.u16());
      features.push({ tag, params: readParams(table, featureAt, featureListAt, tag, paramsOffset), lookups });
    }
  }

  const lookups: LookupRef[] = [];
  if (lookupListAt) {
    const r = new Reader(table, lookupListAt);
    const count = r.u16();
    for (let i = 0; i < count; i++) {
      const lookupAt = lookupListAt + r.u16();
      const l = new Reader(table, lookupAt);
      let type = l.u16();
      const flag = l.u16();
      const n = l.u16();
      const offsets: number[] = [];
      for (let k = 0; k < n; k++) offsets.push(lookupAt + l.u16());
      const markFilteringSet = flag & 0x10 ? l.u16() : null;

      // Unwrap existing extension lookups to their real subtables.
      let subtables = offsets;
      if (type === 7) {
        let realType = 0;
        subtables = offsets.map((at) => {
          const e = new Reader(table, at);
          e.u16(); // format
          realType = e.u16();
          return at + e.u32();
        });
        type = realType;
      }
      lookups.push({ type, flag, markFilteringSet, subtables });
    }
  }
  return { scripts, features, lookups };
}

const SCRIPT_DEFAULT = "DFLT";

export function addSubstitutions(gsub: Uint8Array | undefined, add: SubstitutionFeature[]): Uint8Array {
  const wanted = add.filter((f) => f.pairs.length > 0);
  const original = gsub && gsub.length >= 10 ? gsub : null;
  const parsed: Parsed = original ? parse(original) : { scripts: [], features: [], lookups: [] };

  // --- lookups: originals keep their indices, new ones follow -------------
  const newLookupStart = parsed.lookups.length;

  // --- features: merged and sorted by tag ---------------------------------
  const merged = [
    ...parsed.features.map((f, i) => ({ ...f, old: i as number | null })),
    ...wanted.map((f, i) => ({ tag: f.tag, params: null, lookups: [newLookupStart + i], old: null as number | null })),
  ];
  const order = merged.map((f, i) => ({ f, i })).sort((a, b) => (a.f.tag < b.f.tag ? -1 : a.f.tag > b.f.tag ? 1 : a.i - b.i));
  const remap = new Map<number, number>();
  const added: number[] = [];
  order.forEach(({ f }, newIndex) => {
    if (f.old !== null) remap.set(f.old, newIndex);
    else added.push(newIndex);
  });
  const features = order.map(({ f }) => f);

  const fix = (sys: LangSys): LangSys => ({
    required: sys.required === 0xffff ? 0xffff : (remap.get(sys.required) ?? 0xffff),
    features: [...new Set([...sys.features.map((i) => remap.get(i)).filter((i): i is number => i !== undefined), ...added])].sort(
      (a, b) => a - b,
    ),
  });

  // --- scripts: every language system gains the new features --------------
  let scripts: Script[] = parsed.scripts.map((s) => ({
    tag: s.tag,
    defaultLangSys: s.defaultLangSys ? fix(s.defaultLangSys) : { required: 0xffff, features: [...added] },
    langSys: s.langSys.map((l) => ({ tag: l.tag, sys: fix(l.sys) })),
  }));
  if (!scripts.some((s) => s.tag === SCRIPT_DEFAULT)) {
    // Digits are script-neutral; shapers fall back to DFLT for them. Give it
    // what latn (or the first script) already had, so nothing is lost.
    const donor = parsed.scripts.find((s) => s.tag === "latn") ?? parsed.scripts[0];
    const sys = donor?.defaultLangSys ? fix(donor.defaultLangSys) : { required: 0xffff, features: [...added] };
    scripts.push({ tag: SCRIPT_DEFAULT, defaultLangSys: sys, langSys: [] });
  }
  if (!scripts.some((s) => s.tag === "latn") && parsed.scripts.length === 0) {
    scripts.push({ tag: "latn", defaultLangSys: { required: 0xffff, features: [...added] }, langSys: [] });
  }
  scripts = scripts.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  // --- write --------------------------------------------------------------
  const w = new Writer(4096);
  w.u16(1);
  w.u16(0);
  const headerScript = w.length;
  w.u16(0);
  const headerFeature = w.length;
  w.u16(0);
  const headerLookup = w.length;
  w.u16(0);

  const offset16 = (from: number, to: number) => {
    const d = to - from;
    if (d < 0 || d > 0xffff) throw new Error("GSUB grew past the 64 KB a 16-bit offset can reach.");
    return d;
  };

  const writeLangSys = (sys: LangSys) => {
    w.u16(0);
    w.u16(sys.required);
    w.u16(sys.features.length);
    for (const i of sys.features) w.u16(i);
  };

  // ScriptList
  const scriptListAt = w.length;
  w.patchU16(headerScript, offset16(0, scriptListAt));
  w.u16(scripts.length);
  const scriptRecordAt: number[] = [];
  for (const s of scripts) {
    w.tag(s.tag);
    scriptRecordAt.push(w.length);
    w.u16(0);
  }
  scripts.forEach((s, i) => {
    const scriptAt = w.length;
    w.patchU16(scriptRecordAt[i], offset16(scriptListAt, scriptAt));
    const defaultAt = w.length;
    w.u16(0);
    w.u16(s.langSys.length);
    const langRecordAt: number[] = [];
    for (const l of s.langSys) {
      w.tag(l.tag);
      langRecordAt.push(w.length);
      w.u16(0);
    }
    if (s.defaultLangSys) {
      w.patchU16(defaultAt, offset16(scriptAt, w.length));
      writeLangSys(s.defaultLangSys);
    }
    s.langSys.forEach((l, k) => {
      w.patchU16(langRecordAt[k], offset16(scriptAt, w.length));
      writeLangSys(l.sys);
    });
  });

  // FeatureList
  const featureListAt = w.length;
  w.patchU16(headerFeature, offset16(0, featureListAt));
  w.u16(features.length);
  const featureRecordAt: number[] = [];
  for (const f of features) {
    w.tag(f.tag);
    featureRecordAt.push(w.length);
    w.u16(0);
  }
  features.forEach((f, i) => {
    const featureAt = w.length;
    w.patchU16(featureRecordAt[i], offset16(featureListAt, featureAt));
    const paramsAt = w.length;
    w.u16(0);
    w.u16(f.lookups.length);
    for (const l of f.lookups) w.u16(l);
    if (f.params) {
      w.patchU16(paramsAt, offset16(featureAt, w.length));
      w.bytes(f.params);
    }
  });

  // LookupList
  const lookupListAt = w.length;
  w.patchU16(headerLookup, offset16(0, lookupListAt));
  const total = parsed.lookups.length + wanted.length;
  w.u16(total);
  const lookupRecordAt: number[] = [];
  for (let i = 0; i < total; i++) {
    lookupRecordAt.push(w.length);
    w.u16(0);
  }

  // Extension subtables point into the original table, appended at the end.
  // Their offsets are only known once everything in front is written.
  const pendingExtensions: { at: number; target: number }[] = [];

  parsed.lookups.forEach((l, i) => {
    const lookupAt = w.length;
    w.patchU16(lookupRecordAt[i], offset16(lookupListAt, lookupAt));
    w.u16(7);
    w.u16(l.flag);
    w.u16(l.subtables.length);
    const subRecordAt: number[] = [];
    for (let k = 0; k < l.subtables.length; k++) {
      subRecordAt.push(w.length);
      w.u16(0);
    }
    if (l.markFilteringSet !== null) w.u16(l.markFilteringSet);
    l.subtables.forEach((target, k) => {
      const extAt = w.length;
      w.patchU16(subRecordAt[k], offset16(lookupAt, extAt));
      w.u16(1); // format
      w.u16(l.type);
      pendingExtensions.push({ at: w.length, target });
      w.u32(0);
    });
  });

  wanted.forEach((f, i) => {
    const lookupAt = w.length;
    w.patchU16(lookupRecordAt[newLookupStart + i], offset16(lookupListAt, lookupAt));
    w.u16(1); // single substitution
    w.u16(0);
    w.u16(1);
    const subRecordAt = w.length;
    w.u16(0);

    const pairs = [...f.pairs].sort((a, b) => a[0] - b[0]);
    const subAt = w.length;
    w.patchU16(subRecordAt, offset16(lookupAt, subAt));
    w.u16(2); // format 2: explicit substitutes
    const coverageRecordAt = w.length;
    w.u16(0);
    w.u16(pairs.length);
    for (const [, to] of pairs) w.u16(to);
    w.patchU16(coverageRecordAt, offset16(subAt, w.length));
    w.u16(1); // coverage format 1
    w.u16(pairs.length);
    for (const [from] of pairs) w.u16(from);
  });

  if (original) {
    w.pad(4);
    const originalAt = w.length;
    for (const ext of pendingExtensions) {
      // Offset32 from the start of the ExtensionSubst subtable (2 + 2 bytes before the field).
      w.patchU32(ext.at, originalAt + ext.target - (ext.at - 4));
    }
    w.bytes(original);
  }
  return w.toBytes();
}
