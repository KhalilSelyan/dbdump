/**
 * Programmatic API for dbdump
 * Provides TypeScript functions for schema comparison and migration generation
 */

import { fetchAllSchemas, fetchSchemas } from './database';
import { compareSchemas } from './comparison';
import { generateSplitMigrationSQL, generateFullDatabaseSQL } from './generators/sql';
import type { SchemaMetadata, SchemaDiff } from './types';

// ============================================================
// API TYPES
// ============================================================

export interface MigrationOptions {
  sourceUrl: string;
  targetUrl: string;
  outputDir: string;
  migrationNumber?: number;
  skipEmptyFiles?: boolean;
  excludeTables?: string[];
  skipSchemas?: string[];
  useTransactions?: boolean;
  transactionScope?: 'per-file' | 'single' | 'none';
  sortDependencies?: boolean;
  handleCircularDeps?: boolean;
}

export interface MigrationResult {
  version: number;
  filesCreated: string[];
  totalChanges: number;
  changeTypes: {
    tables: number;
    columns: number;
    indexes: number;
    constraints: number;
    functions: number;
    triggers: number;
    policies: number;
  };
}

export interface FullDumpOptions {
  dbUrl: string;
  outputDir: string;
  migrationNumber?: number;
  skipEmptyFiles?: boolean;
  excludeTables?: string[];
  skipSchemas?: string[];
  useTransactions?: boolean;
  transactionScope?: 'per-file' | 'single' | 'none';
  sortDependencies?: boolean;
  handleCircularDeps?: boolean;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function isEmptySQL(sql: string): boolean {
  const trimmed = sql.trim();
  if (trimmed.length === 0) return true;

  const noChangePatterns = [
    /^-- No .* to create\s*$/,
    /^-- No changes.*$/,
    /^-- Nothing to migrate.*$/,
  ];

  for (const pattern of noChangePatterns) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

function calculateTotalChanges(diff: SchemaDiff, sourceMetadata: SchemaMetadata, targetMetadata: SchemaMetadata): number {
  let total = 0;

  // Tables
  total += diff.tablesOnlyInSource.length;
  total += diff.tablesOnlyInTarget.length;

  // Columns, indexes, constraints
  for (const table of diff.tablesInBoth) {
    total += table.columnsOnlyInSource.length;
    total += table.columnsOnlyInTarget.length;
    total += table.columnsWithDifferences.length;
    total += table.indexesOnlyInSource.length;
    total += table.indexesOnlyInTarget.length;
    total += table.constraintsOnlyInSource.length;
    total += table.constraintsOnlyInTarget.length;
    total += table.foreignKeysOnlyInSource.length;
    total += table.foreignKeysOnlyInTarget.length;
  }

  // Functions
  total += Math.abs(sourceMetadata.functions.length - targetMetadata.functions.length);

  return total;
}

function categorizeChanges(diff: SchemaDiff): {
  tables: number;
  columns: number;
  indexes: number;
  constraints: number;
  functions: number;
  triggers: number;
  policies: number;
} {
  let columns = 0;
  let indexes = 0;
  let constraints = 0;
  let triggers = 0;
  let policies = 0;

  for (const table of diff.tablesInBoth) {
    columns += table.columnsOnlyInSource.length + table.columnsOnlyInTarget.length + table.columnsWithDifferences.length;
    indexes += table.indexesOnlyInSource.length + table.indexesOnlyInTarget.length;
    constraints += table.constraintsOnlyInSource.length + table.constraintsOnlyInTarget.length +
                  table.foreignKeysOnlyInSource.length + table.foreignKeysOnlyInTarget.length;
  }

  return {
    tables: diff.tablesOnlyInSource.length + diff.tablesOnlyInTarget.length,
    columns,
    indexes,
    constraints,
    functions: 0, // Would need to compare metadata
    triggers,
    policies,
  };
}

// ============================================================
// PUBLIC API FUNCTIONS
// ============================================================

/**
 * Generate migration files comparing two databases
 */
export async function generateMigration(
  options: MigrationOptions
): Promise<MigrationResult> {
  // Discover schemas
  const sourceSchemaNames = await fetchSchemas(options.sourceUrl);
  const targetSchemaNames = await fetchSchemas(options.targetUrl);
  let allSchemas = Array.from(new Set([...sourceSchemaNames, ...targetSchemaNames]));

  // Apply schema filters
  if (options.skipSchemas && options.skipSchemas.length > 0) {
    allSchemas = allSchemas.filter(schema => !options.skipSchemas!.includes(schema));
  }

  // Fetch metadata
  const sourceMetadata = await fetchAllSchemas(
    options.sourceUrl,
    allSchemas,
    options.excludeTables || [],
    "source"
  );

  const targetMetadata = await fetchAllSchemas(
    options.targetUrl,
    allSchemas,
    options.excludeTables || [],
    "target"
  );

  // Compare schemas
  const diff = compareSchemas(sourceMetadata, targetMetadata);

  // Determine output directory
  let outputDir = options.outputDir;
  if (options.migrationNumber !== undefined) {
    outputDir = `${outputDir}/migrations-${options.migrationNumber}`;
  }

  // Create output directory
  await Bun.write(`${outputDir}/.gitkeep`, "");

  // Determine options
  const transactionScope = options.useTransactions
    ? (options.transactionScope || 'per-file')
    : 'none';
  const sortDependencies = options.sortDependencies !== false;
  const handleCircularDeps = options.handleCircularDeps !== false;

  // Generate SQL migrations
  const splitSourceToTarget = generateSplitMigrationSQL(
    diff,
    sourceMetadata,
    targetMetadata,
    "source-to-target",
    transactionScope,
    sortDependencies,
    handleCircularDeps
  );

  const splitTargetToSource = generateSplitMigrationSQL(
    diff,
    sourceMetadata,
    targetMetadata,
    "target-to-source",
    transactionScope,
    sortDependencies,
    handleCircularDeps
  );

  // Write files
  const filesCreated: string[] = [];

  // Write source-to-target files
  const diffSourceTargetDir = `${outputDir}/diff-source-to-target`;
  await Bun.write(`${diffSourceTargetDir}/.gitkeep`, "");

  for (const [key, sql] of Object.entries(splitSourceToTarget)) {
    if (options.skipEmptyFiles && isEmptySQL(sql)) {
      continue;
    }
    const filename = `${diffSourceTargetDir}/${key}.sql`;
    await Bun.write(filename, sql);
    filesCreated.push(filename);
  }

  // Write target-to-source files
  const diffTargetSourceDir = `${outputDir}/diff-target-to-source`;
  await Bun.write(`${diffTargetSourceDir}/.gitkeep`, "");

  for (const [key, sql] of Object.entries(splitTargetToSource)) {
    if (options.skipEmptyFiles && isEmptySQL(sql)) {
      continue;
    }
    const filename = `${diffTargetSourceDir}/${key}.sql`;
    await Bun.write(filename, sql);
    filesCreated.push(filename);
  }

  // Calculate result
  const totalChanges = calculateTotalChanges(diff, sourceMetadata, targetMetadata);
  const changeTypes = categorizeChanges(diff);

  return {
    version: options.migrationNumber ?? 0,
    filesCreated,
    totalChanges,
    changeTypes,
  };
}

/**
 * Generate full database dump
 */
export async function generateFullDump(
  options: FullDumpOptions
): Promise<string[]> {
  // Discover schemas
  const schemaNames = await fetchSchemas(options.dbUrl);
  let allSchemas = [...schemaNames];

  // Apply schema filters
  if (options.skipSchemas && options.skipSchemas.length > 0) {
    allSchemas = allSchemas.filter(schema => !options.skipSchemas!.includes(schema));
  }

  // Fetch metadata
  const metadata = await fetchAllSchemas(
    options.dbUrl,
    allSchemas,
    options.excludeTables || [],
    "source"
  );

  // Determine output directory
  let outputDir = options.outputDir;
  if (options.migrationNumber !== undefined) {
    outputDir = `${outputDir}/migrations-${options.migrationNumber}`;
  }

  // Create output directory
  await Bun.write(`${outputDir}/.gitkeep`, "");

  // Determine options
  const transactionScope = options.useTransactions
    ? (options.transactionScope || 'per-file')
    : 'none';
  const sortDependencies = options.sortDependencies !== false;
  const handleCircularDeps = options.handleCircularDeps !== false;

  // Generate full dump
  const fullDump = generateFullDatabaseSQL(
    metadata,
    "source",
    transactionScope,
    sortDependencies,
    handleCircularDeps
  );

  // Write files
  const filesCreated: string[] = [];
  const fullDumpDir = `${outputDir}/full-source`;
  await Bun.write(`${fullDumpDir}/.gitkeep`, "");

  for (const [key, sql] of Object.entries(fullDump)) {
    if (options.skipEmptyFiles && isEmptySQL(sql)) {
      continue;
    }
    const filename = `${fullDumpDir}/${key}.sql`;
    await Bun.write(filename, sql);
    filesCreated.push(filename);
  }

  return filesCreated;
}
