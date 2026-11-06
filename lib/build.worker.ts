/**
 * Runs font builds off the main thread. A family build takes seconds and a
 * large CJK font tens of seconds; on the main thread every edit froze the UI
 * for that long.
 *
 * The source is sent once per assembly ("source"), then each request carries
 * only the build options.
 */
import { buildStaticFonts, buildVariableFont, type BuildOptions, type SourceFont } from "./font/build";
import { buildZip } from "./font/zip";

export type WorkerRequest =
  | { type: "source"; source: SourceFont }
  | { type: "build"; id: number; options: BuildOptions }
  | { type: "statics"; id: number; options: BuildOptions };

export type WorkerResponse =
  | { type: "built"; id: number; data: Uint8Array; masterCount: number; warnings: string[] }
  | { type: "statics"; id: number; zip: Uint8Array; count: number }
  | { type: "error"; id: number; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
};

let source: SourceFont | null = null;

scope.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "source") {
    source = msg.source;
    return;
  }
  try {
    if (!source) throw new Error("No font loaded.");
    if (msg.type === "build") {
      const result = buildVariableFont(source, msg.options);
      scope.postMessage(
        { type: "built", id: msg.id, data: result.data, masterCount: result.masterCount, warnings: result.warnings },
        [result.data.buffer],
      );
    } else {
      const statics = buildStaticFonts(source, msg.options);
      const zip = buildZip(statics.map((s) => ({ name: s.fileName, data: s.data })));
      scope.postMessage({ type: "statics", id: msg.id, zip, count: statics.length }, [zip.buffer]);
    }
  } catch (e) {
    scope.postMessage({ type: "error", id: msg.id, message: e instanceof Error ? e.message : String(e) });
  }
};
