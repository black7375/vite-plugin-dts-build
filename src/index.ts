import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import type { WorkerData, PluginDtsBuildOptions, WorkerToMainMessage } from "./types.js";

let _dirname: string, _filename: string;
let _workerName: string;
// @ts-ignore Support for ESM and CommonJS
if (typeof import.meta !== 'undefined') {
  // ESM
  // @ts-ignore Only available in ESM
  _filename = fileURLToPath(import.meta.url);
  _dirname = dirname(_filename);
  _workerName = "worker.js";
} else {
  // CommonJS
  _dirname = __dirname;
  _filename = __filename;
  _workerName = "worker.cjs";
}

function createWorker(options: WorkerData) {
  return new Worker(join(_dirname, _workerName), {
    workerData: options
  });
}

function waitBuildInWorker(worker: Worker, startTime: number) {
  return new Promise<WorkerToMainMessage>((resolve, reject) => {
    worker.once("message", (message: WorkerToMainMessage) => {
      printMessage(`Declaration files built in ${measureTime(startTime)}ms.`);
      worker.removeAllListeners();
      resolve(message);
    });

    worker.once("error", (err) => {
      reject(err);
    });

    worker.once("exit", (code) => {
      reject(new Error(`Worker stopped with exit code ${code}`));
    });
  });
}
function waitCopyInWorker(
  worker: Worker | undefined,
  afterBuild: NonNullable<PluginDtsBuildOptions["afterBuild"]>
) {
  return new Promise<void>((resolve, reject) => {
    worker?.once("error", (err) => {
      reject(err);
    });

    worker?.on("exit", async () => {
      printMessage("Copy files completed.");
      Promise.resolve(afterBuild()).then(() => resolve());
    });
  });
}

function measureTime(startTime: number) {
  const elapsed = performance.now() - startTime;
  const duration = Math.round(elapsed);
  return duration;
}

function printMessage(message: string) {
  // https://gist.github.com/abritinthebay/d80eb99b2726c83feb0d97eab95206c4
  const cyan = "\x1b[36m";
  const green = "\x1b[32m";
  const reset = "\x1b[0m";

  console.log(`${cyan}[vite-tsc-build] ${green}${message}${reset}`);
}

function noop() {}

export function dts(options: PluginDtsBuildOptions = {}) {
  const { afterBuild = noop, ...workerOptions } = options;
  let workerInstance: Worker | undefined;

  const runState = {
    hasStartRun: false,
    canWriteRun: false
  };
  return {
    name: "vite-plugin-dts-build",
    enforce: "pre" as const,
    apply: "build" as const,
    async buildStart() {
      // Only run once regardless of format
      if (runState.hasStartRun) {
        return;
      }
      runState.hasStartRun = true;

      const startTime = performance.now();
      printMessage("Starting TypeScript build...");
      workerInstance = createWorker(workerOptions);
      const result = await waitBuildInWorker(workerInstance, startTime);
      if (result === "build-end") {
        runState.canWriteRun = true;
      }
    },
    async writeBundle() {
      // Only run once regardless of format
      if (!runState.canWriteRun || workerInstance === undefined) {
        return;
      }
      runState.canWriteRun = false;

      printMessage("Starting Copy files...");
      workerInstance?.postMessage("copy-start");
      await waitCopyInWorker(workerInstance, afterBuild);
      workerInstance = undefined;
    },
    watchChange(
      _id: string,
      change: { event: "create" | "update" | "delete" }
    ) {
      // TODO: support watch without new Worker creation
      if (change.event === "update") {
        runState.hasStartRun = false;
        runState.canWriteRun = false;
      }
    }
  };
}
