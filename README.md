# vite-plugin-dts-build

A Vite plugin that runs TypeScript incremental build process in a separate worker thread for better performance and more efficient builds.

[![npm version](https://img.shields.io/npm/v/vite-plugin-dts-build.svg)](https://www.npmjs.com/package/vite-plugin-dts-build)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Features

- 🚀 Worker-thread TypeScript build (keeps Vite main thread responsive)
- ⚡ Incremental compilation with cached state for fast rebuilds
- 🧩 Accurate declaration-only builds (supports `tsc --build` project references or plain compile) with extension normalization
- 📦 Sensible defaults, easily overridden via options
- 🔀 (Optional) Dual ESM & CJS output (via dtsForEsm / dtsForCjs): `.mjs` / `.cjs` runtime + `.d.mts` / `.d.cts` declarations (specifier rewrite)
- 🧱 (Optional) Legacy subpath stubs (Node10 Support) for deep `require('pkg/sub')` under modern `exports`

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

> [!TIP]
> This customization is designed to [correctly generate all TypeScript output](https://github.com/arethetypeswrong/arethetypeswrong.github.io).
>
> <img width="576" height="312" alt="all types supports" src="https://github.com/user-attachments/assets/3ad37680-a7cb-468d-a304-1740aa73d68c" />

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

**API Reference:**

```typescript
interface PluginDtsDualModeBuildOptions extends PluginDtsBuildOptions {
  /**
   * @description
   * When true, creates per-subpath package.json redirect stubs (main/types) for legacy Node compatibility; disable if you do not publish deep `require()` paths.
   */
  packageRedirect?: boolean; // dtsForCjs() only, default: true
}
```

**Limitations:**

The Dual mode plugin may cause errors by overriding [`module`](https://www.typescriptlang.org/tsconfig/#module) and [`moduleResolution`](https://www.typescriptlang.org/tsconfig/#moduleResolution) in compilerOptions in tsconfig to generate the correct types.

If you see errors or warnings, you may **need to change your source code**.

**How it works:**
1. Each function generates declaration files with module-specific TypeScript compiler options
2. Automatically detects the project's module type from `package.json`
3. Renames declaration files and updates import paths based on the target module format
4. Handles file extensions properly (`.d.mts` for ESM, `.d.cts` for CommonJS)
5. Processes import statements to use correct file extensions (`.mjs` for ESM, `.cjs` for CommonJS)
6. (Optional) Can be combined with a Node 10 compatibility stub step ("Node10 Support") that materializes per-subpath `package.json` files when legacy `require('pkg/sub')` resolution would otherwise break due to modern `exports` usage.

### Custom configuration

> [!TIP]
> If you want to customize, you can also look at the `dtsForEsm()` or `dtsForCjs()` implementations [in this package](./src/index.ts).

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

