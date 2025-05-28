import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { cwd } from "node:process";

import { PromisePool } from "@supercharge/promise-pool";
import { defineConfig } from "vite";

import { ModuleKind, ModuleResolutionKind } from "typescript";
import { externalizeDeps } from "vite-plugin-externalize-deps";
import tsconfigPaths from "vite-tsconfig-paths";

import { dts } from "./compiled/index.js";

const packageRoot = cwd();
const entryRoot = resolve(packageRoot, "src");
const entryFile = resolve(entryRoot, "index.ts");
const cacheEsmDir = resolve(packageRoot, ".cache", "typescript", "esm");
const cacheCjsDir = resolve(packageRoot, ".cache", "typescript", "cjs");
const outEsmDir = resolve(packageRoot, "dist", "esm");
const outCjsDir = resolve(packageRoot, "dist", "cjs");

export default defineConfig(() => ({
  build: {
    lib: {
      entry: {
        index: entryFile,
        "worker": resolve(entryRoot, "worker.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${format === "es" ? "esm" : "cjs"}/${entryName}.${
          format === "es" ? "js" : "cjs"
        }`,
    },
    target: ["es2020"],
    minify: false
  },
  plugins: [
    tsconfigPaths(),
    externalizeDeps(),
    dts({
      include: ["src"],
      cacheDir: cacheEsmDir,
      outDir: outEsmDir,
      tsconfigPath: resolve(packageRoot, "tsconfig.lib.json")
    }),
    dts({
      include: ["src"],
      cacheDir: cacheCjsDir,
      outDir: outCjsDir,
      tsconfigPath: resolve(packageRoot, "tsconfig.lib.json"),
      compilerOptions: {
        module: ModuleKind.CommonJS,
        moduleResolution: ModuleResolutionKind.Node10,
        tsBuildInfoFile: resolve(
          packageRoot,
          ".cache",
          "typescript",
          "tsbuildinfo-cjs"
        )
      },
      afterBuild: async () => {
        // Rename the CommonJS declaration file to .d.cts
        await renameDeclarationFiles(outCjsDir);
      }
    })
  ],
}));

async function renameDeclarationFiles(dir: string) {
  try {
    const allFiles = await collectDeclarationFiles(dir);

    if (allFiles.length === 0) {
      return;
    }
    console.log(`Processing ${allFiles.length} declaration files...`);

    const { errors } = await PromisePool.for(allFiles)
      .withConcurrency(10)
      .process(processCtsFile);

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

async function processCtsFile(fullPath: string) {
  // Change import paths from .js to .cjs
  const content = await readFile(fullPath, "utf8");
  const importRegex = /import ['"](.+)\.js['"];?$/gm;
  const importFromRegex = /from ['"](.+)\.js['"];?$/gm;
  const modifiedContent = content.replace(importRegex, "import '$1.cjs';")
                                 .replace(importFromRegex, "from '$1.cjs';");

  // Change file extension from .d.ts to .d.cts
  const newPath = fullPath.replace(".d.ts", ".d.cts");
  await writeFile(newPath, modifiedContent, "utf8");
  await unlink(fullPath);
}
