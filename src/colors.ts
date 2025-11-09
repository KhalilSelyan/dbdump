/**
 * ANSI color codes for terminal output
 */

export const colors = {
  // Basic colors
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Bright foreground colors
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

// Helper functions for common use cases
export const c = {
  success: (text: string) => `${colors.green}${text}${colors.reset}`,
  error: (text: string) => `${colors.red}${text}${colors.reset}`,
  warning: (text: string) => `${colors.yellow}${text}${colors.reset}`,
  info: (text: string) => `${colors.blue}${text}${colors.reset}`,
  highlight: (text: string) => `${colors.cyan}${text}${colors.reset}`,
  dim: (text: string) => `${colors.dim}${text}${colors.reset}`,
  bold: (text: string) => `${colors.bright}${text}${colors.reset}`,

  // Semantic helpers
  header: (text: string) => `${colors.bright}${colors.cyan}${text}${colors.reset}`,
  subheader: (text: string) => `${colors.brightBlue}${text}${colors.reset}`,
  step: (text: string) => `${colors.brightMagenta}${text}${colors.reset}`,
  count: (num: number | string) => `${colors.brightYellow}${num}${colors.reset}`,
  path: (text: string) => `${colors.cyan}${text}${colors.reset}`,
  checkmark: () => `${colors.green}✓${colors.reset}`,
  cross: () => `${colors.red}✗${colors.reset}`,
  arrow: () => `${colors.brightCyan}→${colors.reset}`,

  // Health/severity colors
  critical: (text: string) => `${colors.brightRed}${text}${colors.reset}`,
  moderate: (text: string) => `${colors.brightYellow}${text}${colors.reset}`,
  minor: (text: string) => `${colors.yellow}${text}${colors.reset}`,
  healthy: (text: string) => `${colors.green}${text}${colors.reset}`,
};

// Create a divider with color
export function divider(char: string = '=', length: number = 70, color: string = colors.cyan): string {
  return `${color}${char.repeat(length)}${colors.reset}`;
}

// Create a box around text
export function box(text: string, color: string = colors.cyan): string {
  const lines = text.split('\n');
  const maxLen = Math.max(...lines.map(l => l.length));
  const top = `${color}╔${'═'.repeat(maxLen + 2)}╗${colors.reset}`;
  const bottom = `${color}╚${'═'.repeat(maxLen + 2)}╝${colors.reset}`;
  const content = lines.map(l => `${color}║${colors.reset} ${l.padEnd(maxLen)} ${color}║${colors.reset}`);

  return [top, ...content, bottom].join('\n');
}
