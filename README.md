# vite-plugin-dts-build

A Vite plugin that runs TypeScript incremental build process in a separate worker thread for better performance and more efficient builds.

[![npm version](https://img.shields.io/npm/v/vite-plugin-dts-build.svg)](https://www.npmjs.com/package/vite-plugin-dts-build)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Features

- 🚀 Runs TypeScript build in a separate worker thread for improved performance
- ⚡ Supports incremental builds to dramatically reduce compilation time
- 🔧 Supports both ESM and CommonJS
- 📦 Flexible configuration options with sensible defaults
- 🛠️ Supports both TypeScript's `--build` mode and standard compile mode
- 🧩 Handles declaration files generation efficiently

## Installation

```bash
# npm
npm install -D vite-plugin-dts-build

# yarn
yarn add -D vite-plugin-dts-build

# pnpm
pnpm add -D vite-plugin-dts-build
```

## Usage

> [!IMPORTANT]
> This project works assuming you have set up [Project Reference](https://www.typescriptlang.org/docs/handbook/project-references.html) correctly.  
> We recommend using automatically generated or maintained:
> - Single Repo: [vite's scaffolding](https://vite.dev/guide/#scaffolding-your-first-vite-project)
> - Mono Repo: [`@monorepo-utils/workspaces-to-typescript-project-references`](https://github.com/azu/monorepo-utils/tree/master/packages/%40monorepo-utils/workspaces-to-typescript-project-references) with `--includesRoot` and `--includesLocal` options


```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { dts } from 'vite-plugin-dts-build';

export default defineConfig({
  plugins: [
    dts({
      // options (see API Reference below)
    })
  ]
});
```

## API Reference

### Plugin Options

```typescript
interface PluginDtsBuildOptions {
  /**
   * Determines operation mode
   * - "build": using `tsc --build`
   * - "compile": just run `tsc`
   * @default "build"
   */
  mode?: "build" | "compile";

  /**
   * Path to the tsconfig.json file
   * @default "./tsconfig.json"
   */
  tsconfigPath?: string;

  /**
   * Directory to store cached compilation results
   * @default "./.tsBuildCache"
   */
  cacheDir?: string;

  /**
   * Output directory for compiled files
   * @default `declarationDir` or `outDir` property of tsconfig.json
   */
  outDir?: string;

  /**
   * Override `include` glob (relative to root)
   * @default `include` property of tsconfig.json
   */
  include?: string | string[];

  /**
   * Override `exclude` glob
   * @default `exclude` property of tsconfig.json or 'node_modules/**'
   */
  exclude?: string | string[];

  /**
   * Custom TypeScript compiler options
   * Will be merged with options from tsconfig.json
   * @default
   * {
   *   incremental: true,
   *   "declaration": true,
   *   "emitDeclarationOnly": true,
   * }
   */
  compilerOptions?: ts.CompilerOptions;

  /**
   * Custom TypeScript build options
   * @default
   * {
   *   dry: false,
   *   force: false,
   *   verbose: false,
   *   stopBuildOnErrors: true,
   * }
   */
  buildOptions?: ts.BuildOptions;

  /**
   * Callback function to execute after build completion
   * @default () => {}
   */
  afterBuild?: () => void | Promise<void>;
}
```

## Examples

### Basic usage

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { dts } from 'vite-plugin-dts-build';

export default defineConfig({
  plugins: [
    dts()
  ]
});
```

### Checker mode

If you want to check without creating a type, use noEmit options.  
Assuming it's a service, not a library.

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { dts } from 'vite-plugin-dts-build';

export default defineConfig({
  plugins: [
    dts({
      compilerOptions: {
        noEmit: true,
        emitDeclarationOnly: false
      }
    })
  ]
});
```

### Dual Module Support

For libraries that need to support both ESM and CommonJS, use the specialized functions `dtsForEsm` and `dtsForCjs`. \
These functions simplify complex module-specific configurations:

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { dtsForEsm, dtsForCjs } from 'vite-plugin-dts-build';

export default defineConfig({
  build: {
    lib: {
      entry: './src/index.ts',
      formats: ['es', 'cjs']
    }
  },
  plugins: [
    dtsForEsm({
      include: ['src'],
      tsconfigPath: './tsconfig.lib.json'
    }),
    dtsForCjs({
      include: ['src'], 
      tsconfigPath: './tsconfig.lib.json'
    })
  ]
});
```

**How it works:**
1. Each function generates declaration files with module-specific TypeScript compiler options
2. Automatically detects the project's module type from `package.json`
3. Renames declaration files and updates import paths based on the target module format
4. Handles file extensions properly (`.d.mts` for ESM, `.d.cts` for CommonJS)
5. Processes import statements to use correct file extensions (`.mjs` for ESM, `.cjs` for CommonJS)

### Custom configuration

> [!TIP]
> If you want to see a library that supports both ESM and CommonJS at the same time, see [this project `vite.config.ts`](./vite.config.ts).

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { dts } from 'vite-plugin-dts-build';

export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: './tsconfig.lib.json',
      mode: 'compile',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', 'node_modules/**'],
      outDir: './dist/types',
      afterBuild: async () => {
        console.log('TypeScript build completed!');
        // Do additional tasks after build
      }
    })
  ]
});
```

## For more performance

If you want to further improve performance, consider the following:
- [`assumeChangesOnlyAffectDirectDependencies`](https://www.typescriptlang.org/tsconfig/#assumeChangesOnlyAffectDirectDependencies): Affected files are not rechecked/rebuilt, and only changed files and directly imported files are rechecked/rebuilt, so it is faster but less accurate.
- [`isolatedDeclarations`](https://www.typescriptlang.org/tsconfig/#isolatedDeclarations): It is useful when building or checking types in parallel, but requires [explicitly changing each type](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-5.html#solution-explicit-types) at the code level.
- If you want to make it faster even by changing the code level, refer to [TypeScript Performance Wiki](https://github.com/microsoft/Typescript/wiki/Performance).

## How It Works

This plugin uses Node.js worker threads to offload TypeScript compilation from the main Vite process, improving build performance. It:

1. Runs TypeScript compilation in a separate worker thread
2. Leverages TypeScript's incremental build capabilities to only recompile changed files
3. Uses a cache directory to store compilation state for faster subsequent builds
4. Supports both `tsc --build` mode (for project references) and standard `tsc` mode
5. Optionally copies output files to a specified directory
6. Provides lifecycle hooks for post-build operations

## License

MIT

