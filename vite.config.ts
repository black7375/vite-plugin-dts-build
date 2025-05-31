import { resolve } from "node:path";
import { cwd } from "node:process";

import { defineConfig } from "vite";

import { externalizeDeps } from "vite-plugin-externalize-deps";
import tsconfigPaths from "vite-tsconfig-paths";

import { dtsForEsm, dtsForCjs } from "./compiled/index.js";

const packageRoot = cwd();
const entryRoot = resolve(packageRoot, "src");
const entryFile = resolve(entryRoot, "index.ts");

export default defineConfig(() => ({
  build: {
    lib: {
      entry: {
        index: entryFile,
        worker: resolve(entryRoot, "worker.ts")
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${format === "es" ? "esm" : "cjs"}/${entryName}.${
          format === "es" ? "js" : "cjs"
        }`
    },
    target: ["es2020"],
    minify: false
  },
  plugins: [
    tsconfigPaths(),
    externalizeDeps(),
    dtsForEsm({
      include: ["src"],
      tsconfigPath: resolve(packageRoot, "tsconfig.lib.json")
    }),
    dtsForCjs({
      include: ["src"],
      tsconfigPath: resolve(packageRoot, "tsconfig.lib.json"),
      compilerOptions: {
        tsBuildInfoFile: resolve(
          packageRoot,
          ".cache",
          "typescript",
          "tsbuildinfo-cjs"
        )
      }
    })
  ]
}));
