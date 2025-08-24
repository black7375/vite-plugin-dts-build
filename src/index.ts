import { Worker } from "node:worker_threads";
import { readdir, readFile, mkdir, writeFile, unlink, stat } from "node:fs/promises";
import { dirname, join, resolve, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cwd } from "node:process";
import { performance } from "node:perf_hooks";

import ts from "typescript";
import { PromisePool } from "@supercharge/promise-pool";
import { printInfo, printWarn } from "./log.js";

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
      printInfo(`Declaration files built in ${measureTime(startTime)}ms.`);
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
      printInfo("Copy files completed.");
      Promise.resolve(afterBuild()).then(() => resolve());
    });
  });
}

function measureTime(startTime: number) {
  const elapsed = performance.now() - startTime;
  const duration = Math.round(elapsed);
  return duration;
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
      printInfo("Starting TypeScript build...");
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

      printInfo("Starting Copy files...");
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
export interface PluginDtsDualModeBuildOptions extends PluginDtsBuildOptions {
  packageRedirect?: boolean;
}

export function dtsForEsm(options: PluginDtsDualModeBuildOptions = {}) {
  const { 
    packageRedirect = false,
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
      if (packageRedirect) {
        // Generate package.json redirects for Node.js 10 compatibility
        await generatePackageJsonRedirects("import");
      }
      if (afterBuild) {
        await Promise.resolve(afterBuild());
      }
    }
  });
}

export function dtsForCjs(options: PluginDtsDualModeBuildOptions = {}) {
  const { 
    packageRedirect = true,
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
      if (packageRedirect) {
        // Generate package.json redirects for Node.js 10 compatibility
        await generatePackageJsonRedirects("require");
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
  exports?: ExportsField;
  [k: string]: unknown;
}

type ExportsField = string | string[] | ExportsMap | null | undefined;
type ExportsMap = Record<string, ExportTarget>;
type ExportTarget = string | string[] | Conditions;
interface Conditions {
  types?: string;
  default?: unknown;
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

//-- Node10 Support -----------------------------------------------------------
type StubPrefer = "require" | "import";

interface StubJson {
  private: true;
  main: string;
  types?: string;
}

interface StubTaskResult {
  stubDir: string;
  stubJsonPath: string;
  stub: StubJson | null;
}

async function generatePackageJsonRedirects(prefer: StubPrefer = "require") {
  const rootDir = resolve(PackageJson.projectRootPath);
  const pkg = await PackageJson.getData(rootDir);

  if (pkg.exports != null) {
    const tasks = computeRedirectStubs({
      pkg,
      rootDir,
      prefer,
    });

    await writeRedirectStubs(tasks);
  }
}

type BranchOrder = "import" | "default" | "node" | "require" | "browser";
function computeRedirectStubs({
  pkg,
  rootDir,
  prefer = "require",
}: {
  pkg: PackageJsonType;
  rootDir: string;
  prefer?: StubPrefer;
}): StubTaskResult[] {
  const exp = normalizeExports(pkg.exports);
  if (exp == null) {
    return [];
  }

  const rootTypes = typeof pkg.types === "string" ? pkg.types : undefined;
  const branchOrder =
    prefer === "import"
      ? ["import", "node", "default", "require", "browser"] satisfies BranchOrder[]
      : ["require", "node", "default", "import", "browser"] satisfies BranchOrder[];

  const results: StubTaskResult[] = [];

  for (const [key, entry] of Object.entries(exp)) {
    if (!isStubAbleKey(key)) continue;
    if (typeof entry === "string" && exportKeyDirectMatch(key, entry)) {
      continue;
    }


    const { main, types } = selectTargets(entry, {
      branchOrder,
      rootTypes,
    });

    const subDirRel = normalizeSubpath(key);
    const stubDir = join(rootDir, subDirRel);
    const stubJsonPath = join(stubDir, "package.json");

    if (!main) {
      results.push({
        stubDir,
        stubJsonPath,
        stub: null,
      });
      continue;
    }

    // 1) Node10 Resolvable - Skip stub creation when already node10 resolvable (key path matches physical file pattern)
    if (isAlreadyNode10Resolved(key, main)) {
      printWarn(`Skip redirect stub for export key '${key}' -> '${main}' (already Node.js 10 resolvable).`);
      continue;
    }

    const mainAbs = resolve(rootDir, main);
    const mainRel = toPosixRelative(stubDir, mainAbs);

    const stub: StubJson = { private: true, main: mainRel };

    if (types) {
      const typesAbs = resolve(rootDir, types);
      stub.types = toPosixRelative(stubDir, typesAbs);
    }

    results.push({
      stubDir,
      stubJsonPath,
      stub,
    });
  }

  return results;
}

const LEADING_DOT_SLASH_RE = /^\.\//;
const TRAILING_EXT_RE = /\.[^./]+$/;
function normalizeSubpath(p: string): string {
  return p.replace(LEADING_DOT_SLASH_RE, "");
}
function stripExt(p: string): string {
  return p.replace(TRAILING_EXT_RE, "");
}

function exportKeyDirectMatch(key: string, value: string): boolean {
  return normalizeSubpath(key) === normalizeSubpath(value);
}

function isAlreadyNode10Resolved(key: string, main: string): boolean {
  const keyBase = normalizeSubpath(key);
  const mainBase = normalizeSubpath(main);

  const candidates: string[] = [];
  ["js", "cjs", "mjs", "json", "node"].forEach(ext => {
    candidates.push(`${keyBase}.${ext}`);
  });
  ["js", "cjs", "mjs", "json", "node"].forEach(ext => {
    candidates.push(`${keyBase}/index.${ext}`);
  });
  candidates.push(keyBase);

  if (candidates.includes(mainBase)) return true;
  if (stripExt(mainBase) === keyBase) return true;
  if (stripExt(mainBase) === stripExt(keyBase)) return true;

  return false;
}

async function writeRedirectStubs(
  tasks: StubTaskResult[],
): Promise<void> {

  for (const task of tasks) {
    if (!task.stub || !task.stubDir || !task.stubJsonPath) continue;

    // 2) Node10 Resolvable - Warn if a file already exists where a stub directory should be created
    const dirStat = await stat(task.stubDir).catch(err => err);
    if (dirStat && !(dirStat instanceof Error) && !dirStat.isDirectory()) {
      printWarn(`Cannot create redirect stub for '${task.stubDir}' because a file already exists at that path.`);
      continue;
    }

    await mkdir(task.stubDir, { recursive: true });

    const json = JSON.stringify(task.stub, null, 2) + "\n";
    await writeFile(task.stubJsonPath, json, "utf8");
  }
}

function normalizeExports(exportsField: ExportsField): ExportsMap | null {
  if (!exportsField) return null;

  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    return { ".": exportsField };
  }

  if (isPlainObject(exportsField)) {
    return exportsField as ExportsMap;
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStubAbleKey(key: string): key is string {
  // filter subpath keys only
  if (!key.startsWith("./")) return false;
  if (key === "." || key === "./") return false;
  if (key === "./package.json") return false;
  if (key.includes("*")) return false; // Skip wildcard stubs
  return true;
}

/**
 * Return remaining object keys after excluding branchOrder + reserved keys,
 * sorted alphabetically for deterministic traversal.
 */
function getRemainingOrderedKeys(obj: Record<string, unknown>, branchOrder: readonly string[]): string[] {
  const exclude = new Set([...branchOrder, "default", "types"]);
  return Object.keys(obj)
    .filter(k => !exclude.has(k))
    .sort();
}

/**
 * Pick both runtime(main) and types targets from an exports entry.
 */
function selectTargets(
  entry: ExportTarget,
  {
    branchOrder,
    rootTypes,
  }: { branchOrder: BranchOrder[]; rootTypes?: string }
): { main?: string; types?: string } {
  const mainPick = pickMain(entry, branchOrder, undefined);
  const chosenBranch = mainPick?.branch;
  const typesPick = pickTypes(entry, chosenBranch, branchOrder) ?? rootTypes;
  return { main: mainPick?.path, types: typesPick };
}

/**
 * Select main export path (runtime entry) with branch preference order.
 * Ordering strategy:
 * 1. branchOrder conditions depth-first
 * 2. top-level default if string
 * 3. remaining keys (alphabetically) depth-first
 */
function pickMain(
  exportTarget: ExportTarget,
  branchOrder: BranchOrder[],
  inheritedBranch?: string
): { path: string; branch?: string } | undefined {
  if (typeof exportTarget === "string") return { path: exportTarget, branch: inheritedBranch };

  if (Array.isArray(exportTarget)) {
    for (const candidate of exportTarget) {
      const result = pickMain(candidate, branchOrder, inheritedBranch);
      if (result?.path != null) return result;
    }
    return undefined;
  }

  if (isPlainObject(exportTarget)) {
    // 1) condition branches in priority order
    for (const condition of branchOrder) {
      if (condition in exportTarget) {
        const conditionalValue = exportTarget[condition] as Conditions;
        const result = pickMain(conditionalValue, branchOrder, condition);
        if (result?.path != null) return result;
      }
    }

    // 2) top-level default (string)
    const explicitDefault = exportTarget.default;
    if (typeof explicitDefault === "string") {
      return { path: explicitDefault, branch: inheritedBranch };
    }

    // 3) remaining keys in deterministic order
    for (const propKey of getRemainingOrderedKeys(exportTarget, branchOrder)) {
      const propValue = exportTarget[propKey];
      if (typeof propValue === "string") return { path: propValue, branch: propKey };
      const result = pickMain(propValue as ExportTarget, branchOrder, propKey);
      if (result?.path) return result;
    }
  }

  return undefined;
}

/**
 * Choose types declaration path.
 * Priority:
 * 1. types in chosenBranch
 * 2. top-level types
 * 3. types in other branchOrder branches
 * 4. deep search: remaining keys (alphabetical) then nested branchOrder recursively
 *    to mirror pickMain deterministic ordering.
 */
function pickTypes(
  exportTarget: ExportTarget,
  chosenBranch: string | undefined,
  branchOrder: BranchOrder[]
): string | undefined {
  if (typeof exportTarget === "string") return undefined;

  if (Array.isArray(exportTarget)) {
    for (const candidate of exportTarget) {
      const found = pickTypes(candidate, chosenBranch, branchOrder);
      if (found) return found;
    }
    return undefined;
  }

  if (isPlainObject(exportTarget)) {
    // 1) types inside chosen branch
    if (chosenBranch && exportTarget[chosenBranch]) {
      const chosenBranchValueRaw = exportTarget[chosenBranch];
      if (Array.isArray(chosenBranchValueRaw)) {
        for (const element of chosenBranchValueRaw) {
          if (isPlainObject(element) && typeof (element as any).types === "string") {
            return (element as any).types as string;
          }
        }
      } else if (isPlainObject(chosenBranchValueRaw)) {
        const chosenBranchValue = chosenBranchValueRaw as Record<string, unknown>;
        if (typeof chosenBranchValue.types === "string") return chosenBranchValue.types;
      }
    }

    // 2) top-level types
    if (typeof exportTarget.types === "string") return exportTarget.types;

    // 3) other branches in priority order
    for (const condition of branchOrder) {
      if (condition !== chosenBranch && exportTarget[condition] && isPlainObject(exportTarget[condition])) {
        const conditionValue = exportTarget[condition] as Record<string, unknown>;
        const typesPath = conditionValue.types;
        if (typeof typesPath === "string") return typesPath;
      }
    }

    // 4a) remaining keys (alphabetical)
    for (const key of getRemainingOrderedKeys(exportTarget, branchOrder)) {
      const nestedValue = exportTarget[key];
      const found = pickTypes(nestedValue as ExportTarget, chosenBranch, branchOrder);
      if (found) return found;
    }
    // 4b) dive into branchOrder keys recursively
    for (const condition of branchOrder) {
      if (exportTarget[condition] && isPlainObject(exportTarget[condition])) {
        const nestedValue = exportTarget[condition] as ExportTarget;
        const found = pickTypes(nestedValue, chosenBranch, branchOrder);
        if (found) return found;
      }
    }
  }

  return undefined;
}

/** Stub directory based relative path (POSIX slash) */
function toPosixRelative(fromDir: string, toAbs: string): string {
  let rel = relative(fromDir, toAbs);
  rel = rel.split(sep).join("/");
  if (!rel.startsWith(".") && !rel.startsWith("/")) rel = "./" + rel;
  return rel;
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assert, expect } = import.meta.vitest;

  // Helper to simplify creation of test package structures
  function testStubs(pkg: any, prefer: "import" | "require" = "require") {
    return computeRedirectStubs({ pkg, rootDir: "/proj", prefer });
  }

  describe("computeRedirectStubs", () => {
    describe("empty and invalid exports", () => {
      it.each([
        [{}, []],
        [{ exports: null }, []],
        [{ exports: undefined }, []],
        [{ exports: "./dist/index.js" }, []], // string exports (root only)
        [{ exports: ["./dist/index.js", "./dist/index.mjs"] }, []] // array at root
      ])("returns empty for %o", (pkg: PackageJsonType, expected: StubTaskResult[]) => {
        expect(testStubs(pkg)).toEqual(expected);
      });
    });

    describe("filtering export keys", () => {
      it("skips root, wildcard, and package.json entries", () => {
        const pkg = {
          exports: {
            ".": "./dist/index.js",
            "./*": "./wildcard.js",
            "./package.json": "./package.json",
            "./valid": "./dist/valid.js",
            "./sub": "./dist/sub.js"
          }
        };
        const res = testStubs(pkg);
        expect(res.map((r) => r.stubDir).sort()).toEqual([
          "/proj/sub",
          "/proj/valid"
        ]);
      });
    });

    describe("module preference resolution", () => {
      const dualExports = {
        exports: {
          "./sub": {
            import: "./esm/sub.js",
            require: "./cjs/sub.cjs"
          }
        }
      };

      it("prefers import when prefer=import", () => {
        const res = testStubs(dualExports, "import");
        expect(res[0].stub?.main).toBe("../esm/sub.js");
      });

      it("prefers require when prefer=require", () => {
        const res = testStubs(dualExports, "require");
        expect(res[0].stub?.main).toBe("../cjs/sub.cjs");
      });

      it("uses fallback when preferred branch is missing", () => {
        const pkg = {
          exports: {
            "./sub": { require: "./cjs/sub.cjs" } // no import field
          }
        };
        const res = testStubs(pkg, "import");
        expect(res[0].stub?.main).toBe("../cjs/sub.cjs");
      });

      it("prioritizes node condition correctly", () => {
        const pkg = {
          exports: {
            "./sub": {
              node: "./node/sub.js",
              browser: "./browser/sub.js"
            }
          }
        };
        const res = testStubs(pkg, "require");
        expect(res[0].stub?.main).toBe("../node/sub.js");
      });
    });

    describe("types resolution", () => {
      it("picks types from chosen branch", () => {
        const pkg = {
          exports: {
            "./sub": {
              import: { types: "./types/sub.d.ts", default: "./esm/sub.js" },
              require: { types: "./types/sub.d.cts", default: "./cjs/sub.cjs" }
            }
          }
        };

        const importRes = testStubs(pkg, "import");
        expect(importRes[0].stub?.types).toBe("../types/sub.d.ts");

        const requireRes = testStubs(pkg, "require");
        expect(requireRes[0].stub?.types).toBe("../types/sub.d.cts");
      });

      it("falls back to root-level types", () => {
        const pkg = {
          types: "./types/root.d.ts",
          exports: {
            "./sub": {
              import: { default: "./esm/sub.js" },
              require: { default: "./cjs/sub.cjs" }
            }
          }
        };
        const res = testStubs(pkg, "import");
        expect(res[0].stub?.types).toBe("../types/root.d.ts");
      });

      it("finds types from other branch when necessary", () => {
        const pkg = {
          exports: {
            "./sub": {
              import: { default: "./esm/sub.js" },
              require: { types: "./types/sub.d.ts", default: "./cjs/sub.cjs" }
            }
          }
        };
        const res = testStubs(pkg, "import");
        expect(res[0].stub?.types).toBe("../types/sub.d.ts");
      });

      it("finds deeply nested types", () => {
        const pkg = {
          exports: {
            "./sub": {
              import: {
                default: {
                  node: {
                    types: "./types/deep.d.ts",
                    default: "./esm/sub.js"
                  }
                }
              }
            }
          }
        };
        const res = testStubs(pkg, "import");
        expect(res[0].stub?.types).toBe("../types/deep.d.ts");
      });
    });

    describe("array handling", () => {
      it("processes array exports at subpath level", () => {
        const pkg = {
          exports: {
            "./sub": [{ import: "./esm/sub.js" }, { require: "./cjs/sub.cjs" }]
          }
        };
        const res = testStubs(pkg, "import");
        expect(res[0].stub?.main).toBe("../esm/sub.js");
      });

      it("extracts types from nested arrays", () => {
        const pkg = {
          exports: {
            "./sub": {
              import: ["./esm/sub.js", { types: "./types/sub.d.ts" }]
            }
          }
        };
        const res = testStubs(pkg, "import");
        expect(res[0].stub?.main).toBe("../esm/sub.js");
        expect(res[0].stub?.types).toBe("../types/sub.d.ts");
      });
    });

    describe("edge cases", () => {
      it("returns null stub when no main path resolved", () => {
        const pkg = {
          exports: {
            "./sub": { import: { types: "./types/only.d.ts" } } // types only, no main
          }
        };
        const res = testStubs(pkg, "import");
        expect(res[0].stub).toBeNull();
      });

      it("processes multiple subpaths", () => {
        const pkg = {
          exports: {
            "./a": { require: "./cjs/a.cjs" },
            "./b": { import: "./esm/b.js" },
            "./c": "./dist/c.js"
          }
        };
        const res = testStubs(pkg);
        expect(res.map((r) => r.stubDir).sort()).toEqual([
          "/proj/a",
          "/proj/b",
          "/proj/c"
        ]);
      });

      it("handles Windows paths correctly", () => {
        const res = computeRedirectStubs({
          pkg: { exports: { "./sub/nested": "./dist/sub/nested.js" } },
          rootDir: "C:/proj",
          prefer: "require"
        });
        // On non-Windows platform path.join will yield POSIX style.
        expect(res[0].stubDir.replace(/\\/g, "/")).toBe("C:/proj/sub/nested");
        expect(res[0].stub?.main).toBe("../../dist/sub/nested.js");
      });

      it("always includes private field in stub", () => {
        const pkg = { exports: { "./sub": "./dist/sub.js" } };
        const res = testStubs(pkg);
        expect(res[0].stub?.private).toBe(true);
      });
    });

    describe("complex scenarios", () => {
      it("resolves nested conditions with correct priority", () => {
        const pkg = {
          exports: {
            "./sub": {
              node: {
                import: {
                  types: "./types/node.d.ts",
                  default: "./esm/node.js"
                },
                require: "./cjs/node.cjs"
              },
              default: "./dist/sub.js"
            }
          }
        };
        const res = testStubs(pkg, "import");
        expect(res[0].stub?.main).toBe("../esm/node.js");
        expect(res[0].stub?.types).toBe("../types/node.d.ts");
      });

      it("handles simple string exports at subpath level", () => {
        const pkg = {
          exports: {
            "./utils": "./dist/utils.js",
            "./helpers": "./dist/helpers.js"
          }
        };
        const res = testStubs(pkg);
        expect(res).toHaveLength(2);
        expect(res[0].stub?.main).toBe("../dist/utils.js");
        expect(res[1].stub?.main).toBe("../dist/helpers.js");
      });
    });
  });
}
