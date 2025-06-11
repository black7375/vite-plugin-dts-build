import { Worker } from "node:worker_threads";
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { cwd } from "node:process";
import { performance } from "node:perf_hooks";

import ts from "typescript";
import { PromisePool } from "@supercharge/promise-pool";

import type { WorkerData, PluginDtsBuildOptions, WorkerToMainMessage } from "./types.js";

/**
 * Typescript is CommonJS package, pnp error
 * SyntaxError: Named export 'createEmitAndSemanticDiagnosticsBuilderProgram' not found. The requested module 'typescript' is a CommonJS module, which may not support all module.exports as named exports.
 * CommonJS modules can always be imported via the default export, for example using:
 */
const {
  ModuleKind,
  ModuleResolutionKind
} = ts;

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

// == Specialized DTS for Modules ==============================================
export function dtsForEsm(options: PluginDtsBuildOptions = {}) {
  const { 
    cacheDir = resolve(PackageJson.projectRootPath, ".cache", "typescript-esm"),
    outDir = join(PackageJson.projectRootPath, "dist", "esm"),
    afterBuild,
    ...restOptions
  } = options;
  
  return dts({
    ...restOptions,
    cacheDir,
    outDir,
    compilerOptions: {
      module: ModuleKind.NodeNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
      ...(restOptions.compilerOptions ?? {})
    },
    afterBuild: async () => {
      if (await PackageJson.isCjsProject(PackageJson.projectRootPath)) {
        // Rename the ESM declaration file to .d.mts
        await renameDeclarationFiles(outDir, "esm");
      }
      if (afterBuild) {
        await Promise.resolve(afterBuild());
      }
    }
  });
}

export function dtsForCjs(options: PluginDtsBuildOptions = {}) {
  const { 
    cacheDir = resolve(PackageJson.projectRootPath, ".cache", "typescript-cjs"),
    outDir = join(PackageJson.projectRootPath, "dist", "cjs"),
    afterBuild,
    ...restOptions
  } = options;
  return dts({
    ...restOptions,
    cacheDir,
    outDir,
    compilerOptions: {
      module: ModuleKind.CommonJS,
      moduleResolution: ModuleResolutionKind.Node10,
      ...(restOptions.compilerOptions ?? {})
    },
    afterBuild: async () => {
      if (await PackageJson.isEsmProject(PackageJson.projectRootPath)) {
        // Rename the CommonJS declaration file to .d.cts
        await renameDeclarationFiles(outDir, "cjs");
      }
      if (afterBuild) {
        await Promise.resolve(afterBuild());
      }
    }
  });
}

type ModuleKindType = "cjs" | "esm";
interface PackageJsonType {
  type?: "commonjs" | "module";
  [k: string]: unknown;
}

class PackageJson {
  private static projectRoot: string;
  private static data: PackageJsonType;
  private constructor() { }

  public static get projectRootPath(): string {
    if (!PackageJson.projectRoot) {
      PackageJson.projectRoot = cwd();
    }
    return PackageJson.projectRoot;
  }

  public static async getData(rootDir?: string): Promise<PackageJsonType>  {
    if(!PackageJson.data) {
      const file = join(rootDir ?? PackageJson.projectRootPath, "package.json");
      PackageJson.data = JSON.parse(await readFile(file, "utf8"));
    }
    return PackageJson.data;
  }

  public static async isEsmProject(rootDir?: string): Promise<boolean> {
    const data = await PackageJson.getData(rootDir);
    return data.type === "module";
  }
  public static async isCjsProject(rootDir?: string): Promise<boolean> {
    const data = await PackageJson.getData(rootDir);
    return data.type === "commonjs" || data.type === undefined;
  }
}

async function renameDeclarationFiles(dir: string, type: ModuleKindType) {
  try {
    const allFiles = await collectDeclarationFiles(dir);

    if (allFiles.length === 0) {
      return;
    }
    console.log(`Processing ${allFiles.length} declaration files...`);

    const { errors } = await PromisePool.for(allFiles)
      .withConcurrency(10)
      .process(async (fullPath) => {
        await processDtsFile(fullPath, type);
      });

    if (errors.length > 0) {
      console.error(`${errors.length} files failed to process`);
    }
  } catch (error) {
    console.error(`Error processing: ${getErrorMessage(error)}`);
  }
}

async function collectDeclarationFiles(dir: string, fileList: string[] = []) {
  try {
    const fileOrDirs = await readdir(dir, { withFileTypes: true });
    const subDirectories: string[] = [];

    for (const fileOrDir of fileOrDirs) {
      const fullPath = join(dir, fileOrDir.name);

      if (fileOrDir.isDirectory()) {
        subDirectories.push(fullPath);
      } else if (fileOrDir.name.endsWith(".d.ts")) {
        fileList.push(fullPath);
      }
    }

    if (subDirectories.length > 0) {
      await PromisePool.for(subDirectories)
        .withConcurrency(8)
        .process(async (subDir) => {
          await collectDeclarationFiles(subDir, fileList);
        });
    }

    return fileList;
  } catch (error) {
    console.error(`Error reading directory ${dir}: ${getErrorMessage(error)}`);
    return fileList;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const IMPORT_REGEX = /import ['"](.+)\.js['"];?$/gm;
const IMPORT_FROM_REGEX = /from ['"](.+)\.js['"];?$/gm;
// Source map comment patterns (line and block styles)
const SOURCE_MAP_LINE_REGEX = /(\/\/\# sourceMappingURL=)([^\n]+?)\.d\.ts\.map/;
const SOURCE_MAP_BLOCK_REGEX = /(\/\*# sourceMappingURL=)([^*]+?)\.d\.ts\.map(\s*\*\/)?/;
async function processDtsFile(fullPath: string, type: ModuleKindType) {
  const jsExt = type === "esm" ? "mjs" : "cjs";
  const tsExt = type === "esm" ? "mts" : "cts";

  // Change import paths from .js to .mjs | .cjs
  const content = await readFile(fullPath, "utf8");
  const modifiedContent = content
    .replace(IMPORT_REGEX, `import '$1.${jsExt}';`)
    .replace(IMPORT_FROM_REGEX, `from '$1.${jsExt}';`);

  // Update sourceMappingURL (//# or /*#) to new .d.mts/.d.cts.map
  const sourceMapUpdated = modifiedContent
    .replace(SOURCE_MAP_LINE_REGEX, `$1$2.d.${tsExt}.map`)
    .replace(SOURCE_MAP_BLOCK_REGEX, `$1$2.d.${tsExt}.map$3`);

  // Change file extension from .d.ts to .d.mts | .d.cts
  const newPath = fullPath.replace(".d.ts", `.d.${tsExt}`);
  await writeFile(newPath, sourceMapUpdated, "utf8");

  // Source map handling (index.d.ts.map -> index.d.mts.map | index.d.cts.map)
  const oldMapPath = `${fullPath}.map`;
  const newMapPath = `${newPath}.map`;
  try {
    const mapRaw = await readFile(oldMapPath, "utf8");
    try {
      const mapJson = JSON.parse(mapRaw) as { file?: string; [k: string]: unknown };
      // Update the "file" property to reflect new declaration filename
      mapJson.file = basename(newPath);
      await writeFile(newMapPath, JSON.stringify(mapJson), "utf8");
      await unlink(oldMapPath).catch(() => {});
    } catch (e) {
      console.warn(`Failed to update source map ${oldMapPath}: ${getErrorMessage(e)}`);
    }
  } catch {
    // No map file; ignore
  }

  await unlink(fullPath);
}
