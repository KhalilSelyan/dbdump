/**
 * Programmatic API for dbdump
 *
 * Provides TypeScript functions for schema comparison and migration generation.
 *
 * @example
 * ```typescript
 * import { generateMigration, generateFullDump, compareWithHistory } from 'dbdump/api';
 *
 * // Compare two databases and generate migration files
 * const result = await generateMigration({
 *   sourceUrl: 'postgresql://localhost/source_db',
 *   targetUrl: 'postgresql://localhost/target_db',
 *   outputDir: './migrations',
 *   format: 'sql',
 *   dryRun: false,
 *   skipEmptyFiles: true,
 *   useTransactions: true,
 *   transactionScope: 'per-file',
 *   sortDependencies: true,
 *   handleCircularDeps: true,
 *   generateFullMigrations: false,
 *   generateCleanupSQL: true,
 *   cleanupDryRun: true,
 *   saveHistory: true,
 * });
 *
 * // Generate full database dump
 * const files = await generateFullDump({
 *   dbUrl: 'postgresql://localhost/my_db',
 *   outputDir: './dumps',
 *   format: 'sql',
 *   skipEmptyFiles: true,
 * });
 *
 * // Compare against historical snapshot
 * const historyResult = await compareWithHistory(
 *   'postgresql://localhost/my_db',
 *   './history/db-schema-2025-01-01.json'
 * );
 * ```
 */

import { fetchAllSchemas, fetchSchemas } from './database';
import { compareSchemas, applyFilters } from './comparison';
import { generateSplitMigrationSQL, generateFullDatabaseSQL, generateRollbackSQL } from './generators/sql';
import { writeMarkdown } from './generators/markdown';
import type { SchemaMetadata, SchemaDiff, FilterOptions, AnalysisResult } from './types';

// ============================================================
// API TYPES
// ============================================================

export interface MigrationOptions {
  // Required
  sourceUrl: string;
  targetUrl: string;
  outputDir: string;

  // Output options
  migrationNumber?: number;
  skipEmptyFiles?: boolean;
  format?: 'sql' | 'json' | 'markdown';
  dryRun?: boolean;

  // Filter options
  excludeTables?: string[];
  skipSchemas?: string[];
  onlyMissingTables?: boolean;
  onlyColumnDiffs?: boolean;
  criticalOnly?: boolean;

  // SQL generation options
  useTransactions?: boolean;
  transactionScope?: 'per-file' | 'single' | 'none';
  sortDependencies?: boolean;
  handleCircularDeps?: boolean;

  // Advanced features
  generateFullMigrations?: boolean;
  generateCleanupSQL?: boolean;
  cleanupDryRun?: boolean;
  saveHistory?: boolean;
  compareWith?: string;
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
  // Required
  dbUrl: string;
  outputDir: string;

  // Output options
  migrationNumber?: number;
  skipEmptyFiles?: boolean;
  format?: 'sql' | 'json' | 'markdown';
  dryRun?: boolean;

  // Filter options
  excludeTables?: string[];
  skipSchemas?: string[];

  // SQL generation options
  useTransactions?: boolean;
  transactionScope?: 'per-file' | 'single' | 'none';
  sortDependencies?: boolean;
  handleCircularDeps?: boolean;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Helper function to format differences as JSON
function formatDifferencesAsJSON(diff: SchemaDiff, sourceMetadata: SchemaMetadata, targetMetadata: SchemaMetadata) {
  // Extract table changes
  const tableChanges = {
    added: diff.tablesOnlyInSource.map((t: any) => `${t.schema}.${t.table}`),
    removed: diff.tablesOnlyInTarget.map((t: any) => `${t.schema}.${t.table}`),
    modified: diff.tablesInBoth.map((t: any) => ({
      table: `${t.table_schema}.${t.table_name}`,
      changes: [
        ...t.columnsOnlyInSource.map((c: any) => ({
          type: 'column_added',
          column: c.column_name,
          dataType: c.data_type
        })),
        ...t.columnsOnlyInTarget.map((c: any) => ({
          type: 'column_removed',
          column: c.column_name
        })),
        ...t.columnsWithDifferences.map((c: any) => ({
          type: 'column_modified',
          column: c.column_name,
          differences: c.differences
        })),
        ...t.indexesOnlyInSource.map((i: any) => ({
          type: 'index_added',
          index: i.index_name
        })),
        ...t.indexesOnlyInTarget.map((i: any) => ({
          type: 'index_removed',
          index: i.index_name
        })),
        ...t.foreignKeysOnlyInSource.map((fk: any) => ({
          type: 'foreign_key_added',
          constraint: fk.constraint_name
        })),
        ...t.foreignKeysOnlyInTarget.map((fk: any) => ({
          type: 'foreign_key_removed',
          constraint: fk.constraint_name
        }))
      ]
    })).filter((t: any) => t.changes.length > 0)
  };

  // Extract function changes
  const sourceFunctions = new Set(sourceMetadata.functions.map((f: any) => `${f.schema}.${f.name}`));
  const targetFunctions = new Set(targetMetadata?.functions?.map((f: any) => `${f.schema}.${f.name}`) || []);

  const functionChanges = {
    added: Array.from(sourceFunctions).filter(f => !targetFunctions.has(f)),
    removed: Array.from(targetFunctions).filter(f => !sourceFunctions.has(f)),
    modified: []
  };

  // Calculate summary
  const totalChanges =
    tableChanges.added.length +
    tableChanges.removed.length +
    tableChanges.modified.reduce((sum: number, t: any) => sum + t.changes.length, 0) +
    functionChanges.added.length +
    functionChanges.removed.length;

  const hasBreakingChanges =
    tableChanges.removed.length > 0 ||
    tableChanges.modified.some((t: any) =>
      t.changes.some((c: any) =>
        c.type === 'column_removed' ||
        c.type === 'column_modified' ||
        c.type === 'foreign_key_removed'
      )
    );

  return {
    differences: {
      tables: tableChanges,
      functions: functionChanges,
      triggers: { added: [], removed: [], modified: [] },
      policies: { added: [], removed: [], modified: [] }
    },
    summary: {
      totalChanges,
      breaking: hasBreakingChanges,
      fileCount: 0
    }
  };
}

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
  let diff = compareSchemas(sourceMetadata, targetMetadata);

  // Apply filters if specified
  const filters: FilterOptions = {
    onlyMissingTables: options.onlyMissingTables || false,
    onlyColumnDiffs: options.onlyColumnDiffs || false,
    criticalOnly: options.criticalOnly || false,
  };

  if (filters.onlyMissingTables || filters.onlyColumnDiffs || filters.criticalOnly) {
    diff = applyFilters(diff, filters);
  }

  // Handle JSON format output
  if (options.format === 'json') {
    const jsonOutput = formatDifferencesAsJSON(diff, sourceMetadata, targetMetadata);
    return {
      version: options.migrationNumber ?? 0,
      filesCreated: [],
      totalChanges: jsonOutput.summary.totalChanges,
      changeTypes: {
        tables: jsonOutput.differences.tables.added.length + jsonOutput.differences.tables.removed.length,
        columns: jsonOutput.differences.tables.modified.reduce((sum: number, t: any) =>
          sum + t.changes.filter((c: any) => c.type.includes('column')).length, 0),
        indexes: jsonOutput.differences.tables.modified.reduce((sum: number, t: any) =>
          sum + t.changes.filter((c: any) => c.type.includes('index')).length, 0),
        constraints: jsonOutput.differences.tables.modified.reduce((sum: number, t: any) =>
          sum + t.changes.filter((c: any) => c.type.includes('constraint') || c.type.includes('foreign_key')).length, 0),
        functions: jsonOutput.differences.functions.added.length + jsonOutput.differences.functions.removed.length,
        triggers: 0,
        policies: 0,
      },
      jsonOutput, // Add the JSON output to the result
    } as any;
  }

  // Determine output directory
  let outputDir = options.outputDir;
  if (options.migrationNumber !== undefined) {
    outputDir = `${outputDir}/migrations-${options.migrationNumber}`;
  }

  // Create output directory (unless dry-run)
  if (!options.dryRun) {
    await Bun.write(`${outputDir}/.gitkeep`, "");
  }

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
  if (!options.dryRun) {
    await Bun.write(`${diffSourceTargetDir}/.gitkeep`, "");
  }

  for (const [key, sql] of Object.entries(splitSourceToTarget)) {
    if (options.skipEmptyFiles && isEmptySQL(sql)) {
      continue;
    }
    const filename = `${diffSourceTargetDir}/${key}.sql`;
    if (!options.dryRun) {
      await Bun.write(filename, sql);
    }
    filesCreated.push(filename);
  }

  // Write target-to-source files
  const diffTargetSourceDir = `${outputDir}/diff-target-to-source`;
  if (!options.dryRun) {
    await Bun.write(`${diffTargetSourceDir}/.gitkeep`, "");
  }

  for (const [key, sql] of Object.entries(splitTargetToSource)) {
    if (options.skipEmptyFiles && isEmptySQL(sql)) {
      continue;
    }
    const filename = `${diffTargetSourceDir}/${key}.sql`;
    if (!options.dryRun) {
      await Bun.write(filename, sql);
    }
    filesCreated.push(filename);
  }

  // Generate markdown report if requested
  if (options.format === 'markdown' && !options.dryRun) {
    const totalColumnDifferences = diff.tablesInBoth.reduce(
      (sum, table) =>
        sum +
        table.columnsOnlyInSource.length +
        table.columnsOnlyInTarget.length +
        table.columnsWithDifferences.length,
      0
    );

    const result: AnalysisResult = {
      timestamp: new Date().toISOString(),
      sourceDb: options.sourceUrl,
      targetDb: options.targetUrl,
      summary: {
        tablesOnlyInSource: diff.tablesOnlyInSource.length,
        tablesOnlyInTarget: diff.tablesOnlyInTarget.length,
        tablesWithDifferences: diff.tablesInBoth.length,
        totalColumnDifferences,
      },
      diff,
    };

    await writeMarkdown(
      result,
      'db-schema-diff',
      outputDir,
      undefined, // syncDirections - would need to calculate
      undefined, // healthMetrics - would need to calculate
      sourceMetadata.tables,
      targetMetadata.tables
    );
  }

  // Generate rollback/cleanup SQL if requested
  if (options.generateCleanupSQL && !options.dryRun) {
    const cleanupDryRun = options.cleanupDryRun !== false;

    const rollbackSourceToTarget = generateRollbackSQL(
      diff,
      sourceMetadata,
      targetMetadata,
      "source-to-target",
      cleanupDryRun
    );

    const rollbackTargetToSource = generateRollbackSQL(
      diff,
      sourceMetadata,
      targetMetadata,
      "target-to-source",
      cleanupDryRun
    );

    // Write rollback files
    const rollbackSourceToTargetDir = `${outputDir}/rollback-source-to-target`;
    await Bun.write(`${rollbackSourceToTargetDir}/.gitkeep`, "");

    for (const [key, sql] of Object.entries(rollbackSourceToTarget)) {
      if (options.skipEmptyFiles && isEmptySQL(sql)) {
        continue;
      }
      const filename = `${rollbackSourceToTargetDir}/${key}.sql`;
      await Bun.write(filename, sql);
      filesCreated.push(filename);
    }

    const rollbackTargetToSourceDir = `${outputDir}/rollback-target-to-source`;
    await Bun.write(`${rollbackTargetToSourceDir}/.gitkeep`, "");

    for (const [key, sql] of Object.entries(rollbackTargetToSource)) {
      if (options.skipEmptyFiles && isEmptySQL(sql)) {
        continue;
      }
      const filename = `${rollbackTargetToSourceDir}/${key}.sql`;
      await Bun.write(filename, sql);
      filesCreated.push(filename);
    }
  }

  // Generate full database dumps if requested
  if (options.generateFullMigrations && !options.dryRun) {
    const fullSourceDump = generateFullDatabaseSQL(sourceMetadata, "source", transactionScope, sortDependencies, handleCircularDeps);
    const fullTargetDump = generateFullDatabaseSQL(targetMetadata, "target", transactionScope, sortDependencies, handleCircularDeps);

    const fullSourceDir = `${outputDir}/full-source`;
    await Bun.write(`${fullSourceDir}/.gitkeep`, "");

    for (const [key, sql] of Object.entries(fullSourceDump)) {
      if (options.skipEmptyFiles && isEmptySQL(sql)) {
        continue;
      }
      const filename = `${fullSourceDir}/${key}.sql`;
      await Bun.write(filename, sql);
      filesCreated.push(filename);
    }

    const fullTargetDir = `${outputDir}/full-target`;
    await Bun.write(`${fullTargetDir}/.gitkeep`, "");

    for (const [key, sql] of Object.entries(fullTargetDump)) {
      if (options.skipEmptyFiles && isEmptySQL(sql)) {
        continue;
      }
      const filename = `${fullTargetDir}/${key}.sql`;
      await Bun.write(filename, sql);
      filesCreated.push(filename);
    }
  }

  // Save history snapshot if requested
  if (options.saveHistory && !options.dryRun) {
    const totalColumnDifferences = diff.tablesInBoth.reduce(
      (sum, table) =>
        sum +
        table.columnsOnlyInSource.length +
        table.columnsOnlyInTarget.length +
        table.columnsWithDifferences.length,
      0
    );

    const result: AnalysisResult = {
      timestamp: new Date().toISOString(),
      sourceDb: options.sourceUrl,
      targetDb: options.targetUrl,
      summary: {
        tablesOnlyInSource: diff.tablesOnlyInSource.length,
        tablesOnlyInTarget: diff.tablesOnlyInTarget.length,
        tablesWithDifferences: diff.tablesInBoth.length,
        totalColumnDifferences,
      },
      diff,
    };

    const timestamp = new Date().toISOString().split("T")[0];
    const historyPath = `${outputDir}/db-schema-diff-${timestamp}.json`;
    await Bun.write(historyPath, JSON.stringify(result, null, 2));
    filesCreated.push(historyPath);
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

  // Handle JSON format output
  if (options.format === 'json') {
    return [JSON.stringify({
      timestamp: new Date().toISOString(),
      database: options.dbUrl,
      schemas: allSchemas,
      metadata: {
        tables: Array.from(metadata.tables.values()),
        enums: metadata.enums,
        extensions: metadata.extensions,
        functions: metadata.functions,
      }
    }, null, 2)];
  }

  // Determine output directory
  let outputDir = options.outputDir;
  if (options.migrationNumber !== undefined) {
    outputDir = `${outputDir}/migrations-${options.migrationNumber}`;
  }

  // Create output directory (unless dry-run)
  if (!options.dryRun) {
    await Bun.write(`${outputDir}/.gitkeep`, "");
  }

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
  if (!options.dryRun) {
    await Bun.write(`${fullDumpDir}/.gitkeep`, "");
  }

  for (const [key, sql] of Object.entries(fullDump)) {
    if (options.skipEmptyFiles && isEmptySQL(sql)) {
      continue;
    }
    const filename = `${fullDumpDir}/${key}.sql`;
    if (!options.dryRun) {
      await Bun.write(filename, sql);
    }
    filesCreated.push(filename);
  }

  return filesCreated;
}

/**
 * Compare current database state against a historical snapshot
 */
export async function compareWithHistory(
  currentDbUrl: string,
  historyFilePath: string,
  options: Partial<MigrationOptions> = {}
): Promise<MigrationResult> {
  // Load historical snapshot
  const historyFile = Bun.file(historyFilePath);
  const historyData = await historyFile.json() as AnalysisResult;

  // Fetch current metadata
  const schemaNames = await fetchSchemas(currentDbUrl);
  let allSchemas = [...schemaNames];

  if (options.skipSchemas && options.skipSchemas.length > 0) {
    allSchemas = allSchemas.filter(schema => !options.skipSchemas!.includes(schema));
  }

  const currentMetadata = await fetchAllSchemas(
    currentDbUrl,
    allSchemas,
    options.excludeTables || [],
    "current"
  );

  // Reconstruct metadata from history (simplified - would need full reconstruction)
  // For now, use the diff directly from history
  const diff = historyData.diff;

  const totalChanges = calculateTotalChanges(diff, currentMetadata, currentMetadata);
  const changeTypes = categorizeChanges(diff);

  return {
    version: 0,
    filesCreated: [],
    totalChanges,
    changeTypes,
  };
}
