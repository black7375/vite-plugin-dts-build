// Shared logging utilities for vite-plugin-tsc-build
// https://gist.github.com/abritinthebay/d80eb99b2726c83feb0d97eab95206c4
// Color codes
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const PREFIX_MSG = "[vite-tsc-build]";
const COLORED_PREFIX_MSG = `${CYAN}${PREFIX_MSG}`;

function getMessageWithPrefix(message: string, messageColor: string) {
  const isNoColor = "NO_COLOR" in process.env;
  if (isNoColor) {
    return `${PREFIX_MSG} ${message}`;
  } else {
    return `${COLORED_PREFIX_MSG} ${messageColor}${message}${RESET}`;
  }
}

export function printInfo(message: string) {
  console.log(getMessageWithPrefix(message, GREEN));
}

export function printWarn(message: string) {
  console.warn(getMessageWithPrefix(message, YELLOW));
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { afterEach, describe, it, expect, vi } = import.meta.vitest;

  const ORIGINAL_NO_COLOR = process.env.NO_COLOR;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();

    if (ORIGINAL_NO_COLOR === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = ORIGINAL_NO_COLOR;
    }
  });

  describe("log", () => {
    it("prints colorized output when NO_COLOR is unset", async () => {
      delete process.env.NO_COLOR;
      vi.resetModules();

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      printInfo("hello");
      printWarn("warn");

      expect(logSpy).toHaveBeenCalledWith(
        `${COLORED_PREFIX_MSG} ${GREEN}hello${RESET}`
      );
      expect(warnSpy).toHaveBeenCalledWith(
        `${COLORED_PREFIX_MSG} ${YELLOW}warn${RESET}`
      );
    });

    it("prints uncolored output when NO_COLOR is set", async () => {
      process.env.NO_COLOR = "1";
      vi.resetModules();

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      printInfo("hello");
      printWarn("warn");

      expect(logSpy).toHaveBeenCalledWith(`${PREFIX_MSG} hello`);
      expect(warnSpy).toHaveBeenCalledWith(`${PREFIX_MSG} warn`);
    });
  });
}