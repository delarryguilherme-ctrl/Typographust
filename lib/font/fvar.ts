import { Writer } from "./binary";
import type { AxisDef } from "./axes";

export interface InstanceEntry {
  subfamilyNameID: number;
  postScriptNameID: number;
  coords: number[];
}

export function buildFvar(axes: AxisDef[], axisNameIDs: number[], instances: InstanceEntry[]): Uint8Array {
  const axisCount = axes.length;
  const instanceSize = axisCount * 4 + 6; // + postScriptNameID

  const w = new Writer(1024);
  w.u16(1); // majorVersion
  w.u16(0); // minorVersion
  w.u16(16); // axesArrayOffset
  w.u16(2); // reserved
  w.u16(axisCount);
  w.u16(20); // axisSize
  w.u16(instances.length);
  w.u16(instanceSize);

  axes.forEach((axis, i) => {
    w.tag(axis.tag);
    w.fixed(axis.min);
    w.fixed(axis.def);
    w.fixed(axis.max);
    w.u16(axis.hidden ? 0x0001 : 0);
    w.u16(axisNameIDs[i]);
  });

  for (const inst of instances) {
    w.u16(inst.subfamilyNameID);
    w.u16(0); // flags
    for (const c of inst.coords) w.fixed(c);
    w.u16(inst.postScriptNameID);
  }

  w.pad(4);
  return w.toBytes();
}

export interface AxisValueEntry {
  axisIndex: number;
  value: number;
  nameID: number;
  /** ELIDABLE_AXIS_VALUE_NAME — set for the family's neutral position. */
  elidable: boolean;
}

/**
 * STAT is required for any font with an fvar table. Design axes are always
 * emitted; axis values are only emitted for positions we can name confidently.
 */
export function buildStat(
  axes: AxisDef[],
  axisNameIDs: number[],
  values: AxisValueEntry[],
  elidedFallbackNameID: number,
): Uint8Array {
  const axisCount = axes.length;
  const designAxesOffset = 20;
  const axisValueOffsetsPos = designAxesOffset + axisCount * 8;
  const valuesStart = axisValueOffsetsPos + values.length * 2;

  const w = new Writer(512);
  w.u16(1); // majorVersion
  w.u16(2); // minorVersion
  w.u16(8); // designAxisSize
  w.u16(axisCount);
  w.u32(designAxesOffset);
  w.u16(values.length);
  w.u32(values.length > 0 ? axisValueOffsetsPos : 0);
  w.u16(elidedFallbackNameID);

  axes.forEach((axis, i) => {
    w.tag(axis.tag);
    w.u16(axisNameIDs[i]);
    w.u16(i); // axisOrdering
  });

  // Every axis value below uses format 1, which is a fixed 12 bytes.
  const entrySize = 12;
  values.forEach((_, i) => {
    w.u16(valuesStart - axisValueOffsetsPos + i * entrySize);
  });

  for (const v of values) {
    w.u16(1); // format
    w.u16(v.axisIndex);
    w.u16(v.elidable ? 0x0002 : 0);
    w.u16(v.nameID);
    w.fixed(v.value);
  }

  w.pad(4);
  return w.toBytes();
}
