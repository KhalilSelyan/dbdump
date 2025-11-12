/**
 * Color helpers using picocolors
 */
import pc from 'picocolors';

// Helper functions for common use cases
export const c = {
  success: (text: string) => pc.green(text),
  error: (text: string) => pc.red(text),
  warning: (text: string) => pc.yellow(text),
  info: (text: string) => pc.blue(text),
  highlight: (text: string) => pc.cyan(text),
  dim: (text: string) => pc.dim(text),
  bold: (text: string) => pc.bold(text),

  // Semantic helpers
  header: (text: string) => pc.bold(pc.cyan(text)),
  subheader: (text: string) => pc.blue(text),
  step: (text: string) => pc.magenta(text),
  count: (num: number | string) => pc.yellow(String(num)),
  path: (text: string) => pc.cyan(text),
  checkmark: () => pc.green('✓'),
  cross: () => pc.red('✗'),
  arrow: () => pc.cyan('→'),

  // Health/severity colors
  critical: (text: string) => pc.bold(pc.red(text)),
  moderate: (text: string) => pc.yellow(text),
  minor: (text: string) => pc.yellow(text),
  healthy: (text: string) => pc.green(text),
};

// Create a divider with color
export function divider(char: string = '=', length: number = 70): string {
  return pc.cyan(char.repeat(length));
}

// Create a box around text
export function box(text: string): string {
  const lines = text.split('\n');
  const maxLen = Math.max(...lines.map(l => l.length));
  const top = pc.cyan(`╔${'═'.repeat(maxLen + 2)}╗`);
  const bottom = pc.cyan(`╚${'═'.repeat(maxLen + 2)}╝`);
  const content = lines.map(l => pc.cyan('║') + ` ${l.padEnd(maxLen)} ` + pc.cyan('║'));

  return [top, ...content, bottom].join('\n');
}
