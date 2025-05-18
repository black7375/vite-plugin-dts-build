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
npm install vite-plugin-dts-build -D

# yarn
yarn add vite-plugin-dts-build -D

# pnpm
pnpm add vite-plugin-dts-build -D
```

## Usage

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

### Custom configuration

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

