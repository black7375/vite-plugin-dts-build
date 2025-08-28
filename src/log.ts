// Shared logging utilities for vite-plugin-tsc-build
// https://gist.github.com/abritinthebay/d80eb99b2726c83feb0d97eab95206c4
// Color codes
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const PREFIX = `${CYAN}[vite-tsc-build]`;

export function printInfo(message: string) {
  console.log(`${PREFIX} ${GREEN}${message}${RESET}`);
}

export function printWarn(message: string) {
  console.warn(`${PREFIX} ${YELLOW}${message}${RESET}`);
}
