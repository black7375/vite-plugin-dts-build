import { resolve, join, dirname, relative, sep } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { cwd } from "node:process";

import ts from "typescript";
import type {
  CompilerOptions,
  CompilerHost,
  EmitAndSemanticDiagnosticsBuilderProgram,
  Diagnostic,
  ProjectReference,
  BuildOptions,
  ParseConfigFileHost
} from "typescript";
import { copy } from "fs-extra";

import type { WorkerData, WorkerToMainMessage } from "./types.js";
import { printWarn } from "./log.js";

/**
 * Typescript is CommonJS package, pnp error
 * SyntaxError: Named export 'createEmitAndSemanticDiagnosticsBuilderProgram' not found. The requested module 'typescript' is a CommonJS module, which may not support all module.exports as named exports.
 * CommonJS modules can always be imported via the default export, for example using:
 */
const {
  readConfigFile,
  parseJsonConfigFileContent,
  createProgram,
  createEmitAndSemanticDiagnosticsBuilderProgram,
  createSolutionBuilderHost,
  createSolutionBuilder,
  getParsedCommandLineOfConfigFile,
  getPreEmitDiagnostics,
  sys,
  formatDiagnostic,
  getLineAndCharacterOfPosition,
  flattenDiagnosticMessageText,
} = ts;

// == Main =====================================================================
const PROJECT_ROOT = cwd();
const WORKER_DATA: WorkerData = workerData as WorkerData;

const tsconfigPath = resolve(
  WORKER_DATA.tsconfigPath ?? join(PROJECT_ROOT, "tsconfig.json")
);
const configFile = readConfigFile(tsconfigPath, sys.readFile);

if (configFile.error) {
  throw new Error(errFormatDiagnostic(configFile.error));
}

if (WORKER_DATA.include) {
  configFile.config.include = stringToStringArray(WORKER_DATA.include);
}
if (WORKER_DATA.exclude) {
  configFile.config.exclude = stringToStringArray(WORKER_DATA.exclude);
}

const parsedConfig = parseJsonConfigFileContent(
  configFile.config,
  sys,
  dirname(tsconfigPath)
);

if (parsedConfig.errors.length > 0) {
  parsedConfig.errors.forEach((error) => {
    reportDiagnostic(error);
  });
  throw new Error("Failed to parse tsconfig.json");
}

const compilerOptions: CompilerOptions = {
  incremental: true,
  // assumeChangesOnlyAffectDirectDependencies: false,
  declaration: true,
  // declarationMap: false,
  emitDeclarationOnly: true,
  // sourceMap: false,
  // inlineSourceMap: false,
  // traceResolution: false,
  ...parsedConfig.options,
  ...(WORKER_DATA.compilerOptions ?? {})
};

const distDir =
  WORKER_DATA.outDir ??
  compilerOptions.declarationDir ??
  compilerOptions.outDir ??
  join(PROJECT_ROOT, "dist");
const cacheDir = WORKER_DATA.cacheDir ?? join(PROJECT_ROOT, ".tsBuildCache");
compilerOptions.declarationDir = cacheDir;

// Compare relative depth between distDir and cacheDir with respect to each root source file
if (shouldWarnSourceMapDepth()) {
  warnIfSourceMapDepthMismatch();
}

const buildOptions: BuildOptions = {
  dry: false,
  force: false,
  verbose: false,
  stopBuildOnErrors: false,
  ...(WORKER_DATA.buildOptions ?? {})
};

const checkerMode = compilerOptions?.noEmit === true || buildOptions?.dry === true;

if (WORKER_DATA.mode === "compile") {
  (async () => await runCompile())();
} else {
  (async () => await runBuild())();
}

// == Functions ================================================================
// -- Compile ------------------------------------------------------------------
async function runCompile() {
  const program = createProgram({
    rootNames: parsedConfig.fileNames,
    options: compilerOptions
  });

  const emitResult = program.emit();
  const allDiagnostics = getPreEmitDiagnostics(program).concat(
    emitResult.diagnostics
  );

  allDiagnostics.forEach((diagnostic) => {
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line, character } = getLineAndCharacterOfPosition(
        diagnostic.file,
        diagnostic.start
      );
      const message = flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n"
      );
      console.error(
        `${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`
      );
    } else {
      console.error(flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    }
  });

  const exitCode = emitResult.emitSkipped ? 1 : 0;
  return await copyToDist(exitCode);
}

// -- Build --------------------------------------------------------------------
async function runBuild() {
  const host = createSolutionBuilderHost(
    sys,
    createBuilderProgram,
    reportDiagnostic,
    reportSolutionBuilderStatus,
    reportErrorSummary
  );

  const parseConfigHost: ParseConfigFileHost = {
    fileExists: sys.fileExists,
    readFile: sys.readFile,
    readDirectory: sys.readDirectory,
    useCaseSensitiveFileNames: sys.useCaseSensitiveFileNames,
    getCurrentDirectory: sys.getCurrentDirectory,
    onUnRecoverableConfigFileDiagnostic: reportDiagnostic
  };
  host.getParsedCommandLine = (fileName) =>
    getParsedCommandLineOfConfigFile(
      fileName,
      compilerOptions,
      parseConfigHost
    );

  const builder = createSolutionBuilder(host, [tsconfigPath], buildOptions);
  const exitCode = builder.build();
  return await copyToDist(exitCode);
}

function createBuilderProgram(
  rootNames?: readonly string[],
  options?: CompilerOptions,
  host?: CompilerHost,
  oldProgram?: EmitAndSemanticDiagnosticsBuilderProgram,
  configFileParsingDiagnostics?: readonly Diagnostic[],
  projectReferences?: readonly ProjectReference[] | undefined
) {
  return createEmitAndSemanticDiagnosticsBuilderProgram(
    rootNames,
    { ...(options ?? {}), ...compilerOptions },
    host,
    oldProgram,
    configFileParsingDiagnostics,
    projectReferences
  );
}

function reportDiagnostic(diagnostic: Diagnostic) {
  console.error(errFormatDiagnostic(diagnostic));
}

function reportSolutionBuilderStatus(diagnostic: Diagnostic) {
  console.info(errFormatDiagnostic(diagnostic));
}

function reportErrorSummary(errorCount: number) {
  if (errorCount !== 0) {
    console.error(`${errorCount} errors occurred.`);
  }
}

// -- Copy ---------------------------------------------------------------------
function copyToDist(exitCode: number) {
  return new Promise<void>((resolve, reject) => {
    if (exitCode === 0) {
      if (checkerMode) {
        parentPort?.postMessage("check-end" satisfies WorkerToMainMessage);
        resolve();
      }
      else {
        parentPort?.postMessage("build-end" satisfies WorkerToMainMessage);
        parentPort?.once("message", () => {
          copy(`${cacheDir}/`, `${distDir}/`)
            .then(() => {
              parentPort?.close();
              resolve();
            })
            .catch((error) => {
              console.error("failed:", error);
              reject(error);
            });
        });
      }
    } else {
      reject();
    }
  });
}

// -- Source Map Depth Warning -------------------------------------------------
function shouldWarnSourceMapDepth(): boolean {
  const sourceMapEnabled = Boolean(
    compilerOptions.sourceMap ||
    compilerOptions.inlineSourceMap ||
    compilerOptions.declarationMap
  );
  return sourceMapEnabled;
}

function warnIfSourceMapDepthMismatch() {
  const roots = parsedConfig.fileNames;
  const entry = roots[0];
  if (entry == null) return;
  const depthFromJs = computeRelativeDepth(entry, distDir);
  const depthFromTs = computeRelativeDepth(entry, cacheDir);
  if (depthFromJs !== depthFromTs) {
    printWarn(
      `SourceMap relative path depth mismatch: distDir -> entry depth(${depthFromJs}) !== cacheDir -> entry depth(${depthFromTs}).\n` +
      `This may cause broken relative source paths inside *.map files after copying. Consider aligning directory nesting.\n` +
      `  distDir: ${relative(entry, distDir)}\n` +
      `  cacheDir: ${relative(entry, cacheDir)}`
    );
  }
}

function computeRelativeDepth(fromFile: string, toDir: string): number {
  const relPath = relative(fromFile, toDir); // Always returns a string
  if (relPath === "") return 0;
  const segments = relPath.split(sep);
  // Exclude the last segment (file name) and filter out empty/current dir markers
  const dirSegments = segments.slice(0, -1).filter(seg => seg !== "" && seg !== ".");
  return dirSegments.length;
}

// -- Utils --------------------------------------------------------------------
function stringToStringArray(value: string | string[]): string[] {
  return typeof value === "string" ? [value] : value;
}

function errFormatDiagnostic(diagnostic: Diagnostic) {
  return formatDiagnostic(diagnostic, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: sys.getCurrentDirectory,
    getNewLine: () => sys.newLine
  });
}
