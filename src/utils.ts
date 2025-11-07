import type { ColumnInfo } from './types';

/**
 * Mask password in connection string
 */
export function maskConnectionString(url: string): string {
  try {
    const urlObj = new URL(url);
    if (urlObj.password) {
      urlObj.password = '****';
    }
    return urlObj.toString();
  } catch {
    return url;
  }
}

/**
 * Format column definition for SQL CREATE TABLE
 */
export function formatColumnDefinition(col: ColumnInfo): string {
  let def = `"${col.column_name}" ${col.data_type}`;

  if (col.character_maximum_length) {
    def += `(${col.character_maximum_length})`;
  } else if (col.numeric_precision !== null && col.numeric_scale !== null) {
    def += `(${col.numeric_precision}, ${col.numeric_scale})`;
  }

  if (col.is_nullable === 'NO') {
    def += ' NOT NULL';
  }

  if (col.column_default) {
    def += ` DEFAULT ${col.column_default}`;
  }

  return def;
}

/**
 * Parse PostgreSQL array format: {col1,col2} or {"col1","col2"}
 */
export function parsePostgresArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const inner = trimmed.slice(1, -1);
      if (inner) {
        return inner.split(',').map((c: string) => {
          return c.trim().replace(/^"/, '').replace(/"$/, '');
        });
      }
    }
  }

  return [];
}

/**
 * Normalize CHECK constraint clause for comparison
 */
export function normalizeCheckClause(clause: string | undefined): string {
  if (!clause) return '';

  let normalized = clause.trim()
    .replace(/\s+/g, ' ')  // Normalize whitespace
    .replace(/\(\s+/g, '(') // Remove space after (
    .replace(/\s+\)/g, ')') // Remove space before )
    .toLowerCase();         // Case insensitive

  // Remove outer parentheses if present
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized;
}

/**
 * Compare two arrays of columns (order-independent)
 */
export function areColumnArraysEqual(arr1: string[], arr2: string[]): boolean {
  if (arr1.length !== arr2.length) return false;
  const sorted1 = [...arr1].sort().join(',');
  const sorted2 = [...arr2].sort().join(',');
  return sorted1 === sorted2;
}
