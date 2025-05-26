import { CompilerOptions, BuildOptions } from "typescript";

/**
 * Configuration data passed to the TypeScript worker
 */
export interface WorkerData {
  /**
   * @description
   * Determines operation mode
   * - "build": using `tsc --build`
   * - "compile": just run `tsc`
   * @default "build"
   */
  mode?: "build" | "compile";

  /**
   * @description
   * Path to the tsconfig.json file
   * @default "./tsconfig.json"
   */
  tsconfigPath?: string;

  /**
   * @description
   * Directory to store cached compilation results
   * @default "./.tsBuildCache"
   */
  cacheDir?: string;

  /**
   * @description
   * Output directory for compiled files
   * @default
   * `declarationDir` or `outDir` property of tsconfig.json (relative to tsconfig.json located).
   */
  outDir?: string;

  /**
   * @description
   * Override `include` glob (relative to root).
   * @default
   * `include` property of tsconfig.json (relative to tsconfig.json located).
   */
  include?: string | string[];

  /**
   * @description
   * Override `exclude` glob.
   * @default
   * `exclude` property of tsconfig.json or `'node_modules/**'` if not supplied.
   */
  exclude?: string | string[];

  /**
   * @description
   * Custom TypeScript compiler options
   * Will be merged with options from tsconfig.json
   */
  compilerOptions?: CompilerOptions;

  /**
   * @description
   * Custom TypeScript build options
   */
  buildOptions?: BuildOptions;
}

/**
 * Plugin options extending worker configuration with lifecycle hooks
 */
export interface PluginDtsBuildOptions extends WorkerData {
  /**
   * @description
   * Callback function to execute after build completion
   * @default () => {}
   */
  afterBuild?: () => void | Promise<void>;
}

/**
 * Message types sent from worker to main thread
 */
export type WorkerToMainMessage = "build-end" | "check-end";

/**
 * Message types sent from main thread to worker
 */
export type MainToWorkerMessage = "copy-start";
