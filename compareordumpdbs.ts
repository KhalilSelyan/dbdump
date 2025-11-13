#!/usr/bin/env bun

/**
 * Database Schema Comparison Tool
 * Refactored modular version
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { fetchSchemas, fetchAllSchemas } from './src/database';
import { compareSchemas, applyFilters } from './src/comparison';
import {
  generateSplitMigrationSQL,
  generateFullDatabaseSQL,
  generateMigrationReadme,
  generateRollbackSQL,
  type TransactionScope
} from './src/generators/sql';
import { writeMarkdown, printSummary, writeWarningReports } from './src/generators/markdown';
import { calculateHealthMetrics, calculateSyncDirections } from './src/health';
import { loadCompleteWarningConfig } from './src/config-loader';
import { parseArguments, printHelp, loadConfig } from './src/config';
import { maskConnectionString } from './src/utils';
import { c, divider } from './src/colors';
import { runInteractiveMode } from './src/interactive';
import type {
  AnalysisResult,
  FilterOptions,
  HealthMetrics,
  SyncDirections
} from './src/types';

// Helper function to check if SQL content is meaningful
function isEmptySQL(sql: string): boolean {
  const trimmed = sql.trim();
  if (trimmed.length === 0) return true;

  // Check if it's just a comment saying no changes
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

// Helper function to generate migration summary
function generateMigrationSummary(
  diff: any,
  sourceMetadata: any,
  targetMetadata: any,
  filesCreated: string[]
) {
  const tableChanges = diff.tablesOnlyInSource.length + diff.tablesOnlyInTarget.length;
  let columnChanges = 0;
  let indexChanges = 0;
  let constraintChanges = 0;

  for (const table of diff.tablesInBoth) {
    columnChanges += table.columnsOnlyInSource.length + table.columnsOnlyInTarget.length + table.columnsWithDifferences.length;
    indexChanges += table.indexesOnlyInSource.length + table.indexesOnlyInTarget.length;
    constraintChanges += table.constraintsOnlyInSource.length + table.constraintsOnlyInTarget.length +
                        table.foreignKeysOnlyInSource.length + table.foreignKeysOnlyInTarget.length;
  }

  const functionChanges = Math.abs((sourceMetadata.functions?.length || 0) - (targetMetadata.functions?.length || 0));

  return {
    tables: tableChanges,
    columns: columnChanges,
    indexes: indexChanges,
    constraints: constraintChanges,
    functions: functionChanges,
    filesCreated: filesCreated.length,
  };
}

// Helper function to format differences as JSON
function formatDifferencesAsJSON(diff: any, sourceMetadata: any, targetMetadata: any) {
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
      triggers: { added: [], removed: [], modified: [] }, // TODO: Add trigger tracking
      policies: { added: [], removed: [], modified: [] }  // TODO: Add policy tracking
    },
    summary: {
      totalChanges,
      breaking: hasBreakingChanges,
      fileCount: 0 // Will be calculated if generating files
    }
  };
}

// Main function
async function main() {
  let args = parseArguments();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Check if we should use interactive mode (no args provided except possibly help)
  const hasNoArgs = !args.source && !args.config;

  if (hasNoArgs) {
    // Run interactive mode
    args = await runInteractiveMode();
  }

  let sourceUrl: string;
  let targetUrl: string | undefined;
  let excludeTables: string[];
  let skipSchemas: string[];
  let skipExtensions: string[];
  let outputDir: string;

  // Load from config file if provided
  if (args.config) {
    const config = await loadConfig(args.config);
    sourceUrl = config.source;
    targetUrl = config.target;
    excludeTables = (args.excludeTables ||
      config.excludeTables ||
      []) as string[];
    skipSchemas = (args.skipSchemas || config.skipSchemas || []) as string[];
    skipExtensions = (args.skipExtensions || config.skipExtensions || []) as string[];
    outputDir = (args.outputDir || config.outputDir || ".") as string;

    // Merge config values with CLI args (CLI args take precedence)
    if (args.skipEmptyFiles === undefined && config.skipEmptyFiles !== undefined) {
      args.skipEmptyFiles = config.skipEmptyFiles;
    }
    if (args.transactionScope === undefined && config.transactionScope !== undefined) {
      args.transactionScope = config.transactionScope;
    }
    if (args.format === undefined && config.format !== undefined) {
      args.format = config.format;
    }
  } else {
    // Load from command line arguments
    if (!args.source) {
      console.error(
        "Error: Either provide --config or --source"
      );
      printHelp();
      process.exit(1);
    }
    sourceUrl = args.source;
    targetUrl = args.target as string | undefined;
    excludeTables = (args.excludeTables || []) as string[];
    skipSchemas = (args.skipSchemas || []) as string[];
    skipExtensions = (args.skipExtensions || []) as string[];
    outputDir = (args.outputDir || ".") as string;
  }

  // Check if we're in dump-only mode (no target specified)
  const dumpOnlyMode = !targetUrl;

  // If dump-only mode, require --generateFullMigrations
  if (dumpOnlyMode && !args.generateFullMigrations) {
    console.error(
      "Error: When no target database is specified, you must use --generateFullMigrations"
    );
    printHelp();
    process.exit(1);
  }

  const outputPrefix = args.output || "db-schema-diff";

  // If migrationNumber is provided, wrap output in migrations-N directory
  if (args.migrationNumber !== undefined) {
    outputDir = `${outputDir}/migrations-${args.migrationNumber}`;
  }

  // Create output directory if it doesn't exist
  if (outputDir !== ".") {
    try {
      await Bun.write(`${outputDir}/.gitkeep`, "");
      p.log.info(`Output directory: ${pc.cyan(outputDir + '/')}`);
    } catch (error) {
      p.log.error(`Error creating output directory: ${error}`);
      process.exit(1);
    }
  }

  // Show mode
  if (!hasNoArgs) {
    // Only show intro for CLI mode (interactive mode already showed it)
    p.intro(pc.bgCyan(pc.black(dumpOnlyMode ? ' 🗄️  Database Schema Dump ' : ' 🗄️  Database Schema Comparison ')));
  }

  // Load warning configuration
  const { config: warningConfig, ignoreRules, summary: configSummary } = await loadCompleteWarningConfig();
  if (configSummary) {
    p.log.info(configSummary);
  }

  // Fetch all available schemas from both databases
  const s1 = p.spinner();
  s1.start('Discovering schemas from source database');
  const sourceSchemas = await fetchSchemas(sourceUrl);
  s1.stop(`Found ${pc.yellow(String(sourceSchemas.length))} schemas in source`);

  let targetSchemas: string[] = [];
  if (!dumpOnlyMode) {
    const s2 = p.spinner();
    s2.start('Discovering schemas from target database');
    targetSchemas = await fetchSchemas(targetUrl!);
    s2.stop(`Found ${pc.yellow(String(targetSchemas.length))} schemas in target`);
  }

  // Merge schema lists (compare all schemas that exist in either DB)
  let allSchemas = Array.from(new Set([...sourceSchemas, ...targetSchemas]));

  // Filter out skipped schemas
  if (skipSchemas.length > 0) {
    const beforeCount = allSchemas.length;
    allSchemas = allSchemas.filter((schema) => !skipSchemas.includes(schema));
    p.log.warn(`Skipping ${beforeCount - allSchemas.length} schemas: ${skipSchemas.join(", ")}`);
  }

  p.log.info(`Comparing ${pc.yellow(String(allSchemas.length))} schemas: ${pc.cyan(allSchemas.join(", "))}`);

  if (excludeTables.length > 0) {
    p.log.info(`Excluding tables: ${pc.yellow(excludeTables.join(", "))}`);
  }

  const s3 = p.spinner();
  s3.start('Fetching source database schema');
  const sourceMetadata = await fetchAllSchemas(
    sourceUrl,
    allSchemas,
    excludeTables,
    "source",
    false,
    skipExtensions
  );
  s3.stop(`Source: ${pc.yellow(String(sourceMetadata.tables.size))} tables, ${pc.yellow(String(sourceMetadata.enums.length))} enums, ${pc.yellow(String(sourceMetadata.functions.length))} functions`);

  let targetMetadata;
  let diff;

  if (dumpOnlyMode) {
    // Skip target and comparison in dump-only mode
    targetMetadata = {
      tables: new Map(),
      enums: [],
      extensions: [],
      functions: []
    };
    diff = {
      tablesOnlyInSource: [],
      tablesOnlyInTarget: [],
      tablesInBoth: []
    };
  } else {
    const s4 = p.spinner();
    s4.start('Fetching target database schema');
    targetMetadata = await fetchAllSchemas(
      targetUrl!,
      allSchemas,
      excludeTables,
      "target",
      false,
      skipExtensions
    );
    s4.stop(`Target: ${pc.yellow(String(targetMetadata.tables.size))} tables, ${pc.yellow(String(targetMetadata.enums.length))} enums, ${pc.yellow(String(targetMetadata.functions.length))} functions`);

    const s5 = p.spinner();
    s5.start('Comparing schemas');
    diff = compareSchemas(sourceMetadata, targetMetadata);
    s5.stop('Schema comparison complete');

    // Early exit for JSON format output
    if (args.format === 'json') {
      const jsonOutput = formatDifferencesAsJSON(diff, sourceMetadata, targetMetadata);
      console.log(JSON.stringify(jsonOutput, null, 2));
      process.exit(0);
    }
  }

  // Skip comparison-related operations in dump-only mode
  let result: AnalysisResult | undefined;
  let healthMetrics: HealthMetrics | undefined;
  let syncDirections: SyncDirections | undefined;

  if (!dumpOnlyMode) {
    // Apply filters if specified
    const filters: FilterOptions = {
      onlyMissingTables: args.onlyMissingTables || false,
      onlyColumnDiffs: args.onlyColumnDiffs || false,
      criticalOnly: args.criticalOnly || false,
    };

    if (
      filters.onlyMissingTables ||
      filters.onlyColumnDiffs ||
      filters.criticalOnly
    ) {
      console.log(c.info(`  Applying filters...`));
      if (filters.onlyMissingTables)
        console.log(c.dim(`    - Only showing missing tables`));
      if (filters.onlyColumnDiffs)
        console.log(c.dim(`    - Only showing column differences`));
      if (filters.criticalOnly)
        console.log(c.dim(`    - Only showing critical/breaking changes`));
      diff = applyFilters(diff, filters);
    }

    // Calculate summary stats
    const totalColumnDifferences = diff.tablesInBoth.reduce(
      (sum, table) =>
        sum +
        table.columnsOnlyInSource.length +
        table.columnsOnlyInTarget.length +
        table.columnsWithDifferences.length,
      0
    );

    result = {
      timestamp: new Date().toISOString(),
      sourceDb: sourceUrl,
      targetDb: targetUrl!,
      summary: {
        tablesOnlyInSource: diff.tablesOnlyInSource.length,
        tablesOnlyInTarget: diff.tablesOnlyInTarget.length,
        tablesWithDifferences: diff.tablesInBoth.length,
        totalColumnDifferences,
      },
      diff,
    };

    // Calculate health metrics and sync directions
    console.log(c.dim(`  Calculating health metrics...`));
    healthMetrics = calculateHealthMetrics(diff, sourceMetadata, targetMetadata, warningConfig, ignoreRules);
    syncDirections = calculateSyncDirections(diff);

    // Save history if requested
    if (args.saveHistory) {
      const timestamp = new Date().toISOString().split("T")[0];
      const historyPath = `${outputDir}/${outputPrefix}-${timestamp}.json`;
      await Bun.write(historyPath, JSON.stringify(result, null, 2));
      console.log(c.success(`  Saved snapshot: `) + c.path(historyPath));
    }

    // Write outputs
    console.log(`\n${c.step(`[5/5] Writing output...`)}`);
    await writeMarkdown(
      result,
      outputPrefix,
      outputDir,
      syncDirections,
      healthMetrics,
      sourceMetadata.tables,
      targetMetadata.tables
    );

    // Write separate warning reports
    await writeWarningReports(
      sourceUrl,
      targetUrl!,
      healthMetrics,
      outputDir
    );

    // Determine transaction scope
    let transactionScope: TransactionScope = 'none';
    if (args.useTransactions) {
      const scopeValue = args.transactionScope || 'per-file';
      if (scopeValue === 'per-file' || scopeValue === 'single') {
        transactionScope = scopeValue;
      } else {
        p.log.error(`Invalid transaction scope: ${scopeValue}. Using 'per-file'.`);
        transactionScope = 'per-file';
      }
      p.log.info(`Transaction mode: ${pc.cyan(transactionScope)}`);
    }

    // Determine dependency sorting
    const sortDependencies = args.sortDependencies !== false; // Default true
    if (sortDependencies) {
      p.log.info(`Dependency sorting: ${pc.cyan('enabled')}`);
    }

    // Determine circular dependency handling
    const handleCircularDeps = args.handleCircularDeps !== false; // Default true
    if (handleCircularDeps && sortDependencies) {
      p.log.info(`Circular dependency handling: ${pc.cyan('enabled')}`);
    }

    // Generate split SQL migration files
    const s6 = p.spinner();
    const modeLabel = args.dryRun ? 'Previewing migrations (dry-run)' : 'Generating migration SQL files';
    s6.start(modeLabel);

    const splitSourceToTarget = generateSplitMigrationSQL(diff, sourceMetadata, targetMetadata, "source-to-target", transactionScope, sortDependencies, handleCircularDeps);
    const splitTargetToSource = generateSplitMigrationSQL(diff, sourceMetadata, targetMetadata, "target-to-source", transactionScope, sortDependencies, handleCircularDeps);
    s6.stop('Migration files generated');

    if (args.dryRun) {
      p.log.warn('DRY-RUN MODE: No files will be written');
    }

    // Check for circular dependencies and warn
    if (handleCircularDeps && sortDependencies) {
      const tablesSQL = splitSourceToTarget['3-tables'];
      if (tablesSQL.includes('CIRCULAR DEPENDENCY HANDLING')) {
        p.note(
          'Tables with circular FK relationships will use DEFERRABLE constraints.\nCheck the generated SQL for details.',
          '⚠️  Circular Dependencies Detected'
        );
      }
    }

    // Create subdirectories for organized output
    const diffSourceTargetDir = `${outputDir}/diff-source-to-target`;
    const diffTargetSourceDir = `${outputDir}/diff-target-to-source`;

    // Track files created
    const filesCreated: string[] = [];

    // Write source-to-target files
    p.log.step(`Source → Target migrations`);
    if (!args.dryRun) {
      await Bun.write(`${diffSourceTargetDir}/.gitkeep`, "");
    }
    for (const [key, sql] of Object.entries(splitSourceToTarget)) {
      // Skip empty files if flag is set
      if (args.skipEmptyFiles && isEmptySQL(sql)) {
        p.log.info(pc.dim(`⊘ ${diffSourceTargetDir}/${key}.sql (empty, skipped)`));
        continue;
      }
      const filename = `${diffSourceTargetDir}/${key}.sql`;
      if (args.dryRun) {
        const lineCount = sql.split('\n').length;
        p.log.info(`${pc.dim('[DRY RUN]')} ${pc.cyan(filename)} ${pc.dim(`(${lineCount} lines)`)}`);
      } else {
        await Bun.write(filename, sql);
        filesCreated.push(filename);
        p.log.success(`${pc.cyan(filename)}`);
      }
    }

    // Write target-to-source files
    p.log.step(`Target → Source migrations`);
    if (!args.dryRun) {
      await Bun.write(`${diffTargetSourceDir}/.gitkeep`, "");
    }
    for (const [key, sql] of Object.entries(splitTargetToSource)) {
      // Skip empty files if flag is set
      if (args.skipEmptyFiles && isEmptySQL(sql)) {
        p.log.info(pc.dim(`⊘ ${diffTargetSourceDir}/${key}.sql (empty, skipped)`));
        continue;
      }
      const filename = `${diffTargetSourceDir}/${key}.sql`;
      if (args.dryRun) {
        const lineCount = sql.split('\n').length;
        p.log.info(`${pc.dim('[DRY RUN]')} ${pc.cyan(filename)} ${pc.dim(`(${lineCount} lines)`)}`);
      } else {
        await Bun.write(filename, sql);
        filesCreated.push(filename);
        p.log.success(`${pc.cyan(filename)}`);
      }
    }

    // Show migration summary
    if (!args.dryRun) {
      const summary = generateMigrationSummary(diff, sourceMetadata, targetMetadata, filesCreated);
      const summaryLines: string[] = [];
      if (summary.tables > 0) summaryLines.push(`Tables: ${pc.yellow(String(summary.tables))} changes`);
      if (summary.columns > 0) summaryLines.push(`Columns: ${pc.yellow(String(summary.columns))} changes`);
      if (summary.indexes > 0) summaryLines.push(`Indexes: ${pc.yellow(String(summary.indexes))} changes`);
      if (summary.constraints > 0) summaryLines.push(`Constraints: ${pc.yellow(String(summary.constraints))} changes`);
      if (summary.functions > 0) summaryLines.push(`Functions: ${pc.yellow(String(summary.functions))} changes`);
      summaryLines.push(`Total files created: ${pc.cyan(String(summary.filesCreated))}`);

      p.note(summaryLines.join('\n'), 'Migration Summary');
    }
  } else {
    p.log.info('Dump-only mode: Skipping schema comparison');
  }

  // Generate README (only in comparison mode)
  if (!dumpOnlyMode && !args.dryRun) {
    const readme = generateMigrationReadme(outputPrefix);
    const readmePath = `${outputDir}/${outputPrefix}-MIGRATION-README.md`;
    await Bun.write(readmePath, readme);
    p.log.success(`Migration guide: ${pc.cyan(readmePath)}`);
  }

  // Generate rollback/cleanup scripts if requested
  if (args.generateCleanupSQL && !dumpOnlyMode) {
    const s7 = p.spinner();
    s7.start('Generating rollback/cleanup scripts');

    const dryRun = args.cleanupDryRun !== false; // default to true
    if (dryRun) {
      p.log.warn('DRY-RUN MODE: DROP statements will be commented out');
      p.log.info('To enable actual execution, use: --cleanupDryRun=false');
    } else {
      p.log.error('⚠️  DRY-RUN DISABLED: DROP statements will execute!');
    }

    // Generate rollback for source→target migration
    const rollbackSourceToTarget = generateRollbackSQL(
      diff,
      sourceMetadata,
      targetMetadata,
      "source-to-target",
      dryRun
    );

    // Generate rollback for target→source migration
    const rollbackTargetToSource = generateRollbackSQL(
      diff,
      sourceMetadata,
      targetMetadata,
      "target-to-source",
      dryRun
    );

    s7.stop('Rollback scripts generated');

    // Create subdirectories for rollback scripts
    const rollbackSourceToTargetDir = `${outputDir}/rollback-source-to-target`;
    const rollbackTargetToSourceDir = `${outputDir}/rollback-target-to-source`;

    // Write source→target rollback files
    p.log.step(`Rollback Source → Target`);
    await Bun.write(`${rollbackSourceToTargetDir}/.gitkeep`, "");
    for (const [key, sql] of Object.entries(rollbackSourceToTarget)) {
      // Skip empty files if flag is set
      if (args.skipEmptyFiles && isEmptySQL(sql)) {
        p.log.info(pc.dim(`⊘ ${rollbackSourceToTargetDir}/${key}.sql (empty, skipped)`));
        continue;
      }
      const filename = `${rollbackSourceToTargetDir}/${key}.sql`;
      await Bun.write(filename, sql);
      p.log.success(`${pc.cyan(filename)}${dryRun ? pc.yellow(' (DRY RUN)') : ''}`);
    }

    // Write target→source rollback files
    p.log.step(`Rollback Target → Source`);
    await Bun.write(`${rollbackTargetToSourceDir}/.gitkeep`, "");
    for (const [key, sql] of Object.entries(rollbackTargetToSource)) {
      // Skip empty files if flag is set
      if (args.skipEmptyFiles && isEmptySQL(sql)) {
        p.log.info(pc.dim(`⊘ ${rollbackTargetToSourceDir}/${key}.sql (empty, skipped)`));
        continue;
      }
      const filename = `${rollbackTargetToSourceDir}/${key}.sql`;
      await Bun.write(filename, sql);
      p.log.success(`${pc.cyan(filename)}${dryRun ? pc.yellow(' (DRY RUN)') : ''}`);
    }

    p.log.info('💡 Execute rollback files in reverse order (7→6→5→4→3→2→1)');
  }

  // Generate full database migrations if requested
  if (args.generateFullMigrations) {
    const s8 = p.spinner();
    s8.start('Generating full database schema dumps');

    // Determine transaction scope for full dumps
    let fullDumpTransactionScope: TransactionScope = 'none';
    if (args.useTransactions) {
      const scopeValue = args.transactionScope || 'per-file';
      if (scopeValue === 'per-file' || scopeValue === 'single') {
        fullDumpTransactionScope = scopeValue;
      }
    }

    // Use same dependency sorting and circular dep settings
    const fullDumpSortDependencies = args.sortDependencies !== false;
    const fullDumpHandleCircularDeps = args.handleCircularDeps !== false;

    const fullSourceDir = `${outputDir}/full-source`;

    // Generate source database full dump
    const fullSourceDump = generateFullDatabaseSQL(sourceMetadata, "source", fullDumpTransactionScope, fullDumpSortDependencies, fullDumpHandleCircularDeps);

    s8.stop('Full schema dumps generated');

    p.log.step(`Source database full schema`);
    await Bun.write(`${fullSourceDir}/.gitkeep`, "");
    for (const [key, sql] of Object.entries(fullSourceDump)) {
      // Skip empty files if flag is set
      if (args.skipEmptyFiles && isEmptySQL(sql)) {
        p.log.info(pc.dim(`⊘ ${fullSourceDir}/${key}.sql (empty, skipped)`));
        continue;
      }
      const filename = `${fullSourceDir}/${key}.sql`;
      await Bun.write(filename, sql);
      p.log.success(pc.cyan(filename));
    }

    // Generate target database full dump (only if not in dump-only mode)
    if (!dumpOnlyMode) {
      const fullTargetDir = `${outputDir}/full-target`;
      p.log.step(`Target database full schema`);
      await Bun.write(`${fullTargetDir}/.gitkeep`, "");
      const fullTargetDump = generateFullDatabaseSQL(targetMetadata, "target", fullDumpTransactionScope, fullDumpSortDependencies, fullDumpHandleCircularDeps);
      for (const [key, sql] of Object.entries(fullTargetDump)) {
        // Skip empty files if flag is set
        if (args.skipEmptyFiles && isEmptySQL(sql)) {
          p.log.info(pc.dim(`⊘ ${fullTargetDir}/${key}.sql (empty, skipped)`));
          continue;
        }
        const filename = `${fullTargetDir}/${key}.sql`;
        await Bun.write(filename, sql);
        p.log.success(pc.cyan(filename));
      }
    }

    p.log.info('💡 To recreate a database locally, execute the files in order (1-7)');
  }

  // Print summary (only in comparison mode)
  if (!dumpOnlyMode && result) {
    printSummary(result);

    // Print health summary to console
    const sync = healthMetrics!.sync;
    const syncSeverity = sync.overall.score >= 90 ? 'healthy' :
                         sync.overall.score >= 70 ? 'minor' :
                         sync.overall.score >= 40 ? 'moderate' : 'critical';
    const icon = sync.overall.score >= 90 ? '✓' : '⚠️';

    const healthLines: string[] = [];
    healthLines.push(`Overall Sync: ${pc.yellow(String(sync.overall.score))}/100 ${icon}`);
    healthLines.push('');
    healthLines.push(pc.bold('Category Breakdown:'));

    const formatScore = (cat: any) => {
      const catIcon = cat.score === 100 ? pc.green('✓') : pc.yellow('⚠️');
      const scoreStr = cat.score === 100 ? pc.green(`${cat.score}/100`) : pc.yellow(`${cat.score}/100`);
      return `${cat.label.padEnd(12)} ${scoreStr} ${catIcon}`;
    };

    healthLines.push(formatScore(sync.categories.tables));
    healthLines.push(formatScore(sync.categories.columns));
    healthLines.push(formatScore(sync.categories.indexes));
    healthLines.push(formatScore(sync.categories.constraints));
    healthLines.push(formatScore(sync.categories.other));

    if (sync.overall.issues.length > 0) {
      healthLines.push('');
      healthLines.push(pc.yellow('Sync Issues:'));
      sync.overall.issues.forEach((issue: string) => healthLines.push(pc.dim(`- ${issue}`)));
    }

    p.note(healthLines.join('\n'), 'Schema Sync Health');

    const formatQuality = (label: string, quality: any) => {
      const gradeColor = quality.grade === 'A' ? pc.green :
                         quality.grade === 'B' ? pc.green :
                         quality.grade === 'C' ? pc.yellow :
                         quality.grade === 'D' ? pc.yellow :
                         pc.red;
      const severityLabel = quality.severity === 'healthy' ? 'Excellent' :
                           quality.severity === 'minor' ? 'Good' :
                           quality.severity === 'moderate' ? 'Needs Attention' :
                           'Critical';

      const qualityLines: string[] = [];
      qualityLines.push(`${pc.yellow(String(quality.score))}/100 (Grade: ${gradeColor(quality.grade)}) - ${severityLabel}`);

      if (quality.warnings.totalWarnings > 0) {
        let warningMsg = `${quality.warnings.totalWarnings} warning(s): ` +
          `${quality.warnings.criticalCount} critical, ` +
          `${quality.warnings.moderateCount} moderate, ` +
          `${quality.warnings.minorCount} minor`;
        if (quality.warnings.filteredCount) {
          warningMsg += pc.dim(` [${quality.warnings.filteredCount} filtered]`);
        }
        qualityLines.push(pc.dim(warningMsg));
      }

      p.note(qualityLines.join('\n'), label);
    };

    formatQuality('Source Database Quality', healthMetrics!.sourceQuality);
    formatQuality('Target Database Quality', healthMetrics!.targetQuality);
  } else if (dumpOnlyMode) {
    const dumpLines: string[] = [];
    dumpLines.push(`Dumped schema from: ${pc.cyan(maskConnectionString(sourceUrl))}`);
    dumpLines.push(`Tables: ${pc.yellow(String(sourceMetadata.tables.size))}`);
    dumpLines.push(`Enums: ${pc.yellow(String(sourceMetadata.enums.length))}`);
    dumpLines.push(`Functions: ${pc.yellow(String(sourceMetadata.functions.length))}`);
    dumpLines.push(`Extensions: ${pc.yellow(String(sourceMetadata.extensions.length))}`);

    p.note(dumpLines.join('\n'), 'Schema Dump Complete');
  }

  // Outro message
  p.outro(pc.green('✓ All done!'));
}

// Run main
main().catch((error) => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
