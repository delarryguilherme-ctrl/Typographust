"use client";

import type { BuildOptions, SourceFont } from "./font/build";
import type { WorkerRequest, WorkerResponse } from "./build.worker";

/**
 * Talks to the build worker. Builds are superseded rather than queued: when a
 * new build is requested while one is still running, the running worker is
 * terminated, so the latest edit never waits behind a stale one. Static
 * exports get a worker of their own, so a preview rebuild cannot kill them.
 */

/**
 * The worker is bundled on its own by esbuild (`npm run worker`, run before
 * dev and build) into `public/`: the bundler that builds the app emits a
 * `new Worker(new URL(...))` target as a raw file instead of compiling it.
 * Resolving against the document keeps the GitHub Pages base path.
 */
function createWorker() {
  return new Worker(new URL("build-worker.js", document.baseURI));
}

type Settle = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void };

class BuildWorker {
  private worker: Worker | null = null;
  private source: SourceFont | null = null;
  private pending = new Map<number, Settle>();
  private nextId = 0;

  private spawn() {
    const worker = createWorker();
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const settle = this.pending.get(event.data.id);
      if (!settle) return;
      this.pending.delete(event.data.id);
      if (event.data.type === "error") settle.reject(new Error(event.data.message));
      else settle.resolve(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(event.message || "The build worker crashed — the font may be too large for this browser."));
    };
    this.worker = worker;
    this.source = null;
    return worker;
  }

  private fail(error: Error) {
    for (const settle of this.pending.values()) settle.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  /** Stops whatever is running; its promise is rejected with `superseded`. */
  cancel() {
    if (this.pending.size === 0) return;
    this.fail(Object.assign(new Error("superseded"), { superseded: true }));
  }

  run(source: SourceFont, request: Omit<Extract<WorkerRequest, { id: number }>, "id">): Promise<WorkerResponse> {
    const worker = this.worker ?? this.spawn();
    if (this.source !== source) {
      worker.postMessage({ type: "source", source } satisfies WorkerRequest);
      this.source = source;
    }
    const id = ++this.nextId;
    const promise = new Promise<WorkerResponse>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    worker.postMessage({ ...request, id } as WorkerRequest);
    return promise;
  }

  dispose() {
    this.fail(Object.assign(new Error("superseded"), { superseded: true }));
  }
}

const preview = new BuildWorker();

export function isSuperseded(e: unknown) {
  return Boolean(e && typeof e === "object" && "superseded" in e);
}

export async function buildInWorker(source: SourceFont, options: BuildOptions) {
  preview.cancel();
  const res = await preview.run(source, { type: "build", options });
  if (res.type !== "built") throw new Error("Unexpected worker reply.");
  return res;
}

export function cancelBuild() {
  preview.cancel();
}

export async function exportStaticsInWorker(source: SourceFont, options: BuildOptions) {
  const worker = new BuildWorker();
  try {
    const res = await worker.run(source, { type: "statics", options });
    if (res.type !== "statics") throw new Error("Unexpected worker reply.");
    return res;
  } finally {
    worker.dispose();
  }
}
