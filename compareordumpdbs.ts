#!/usr/bin/env bun

/**
 * Database Schema Comparison Tool
 * Refactored modular version
 */

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
import type {
  AnalysisResult,
  FilterOptions,
  HealthMetrics,
  SyncDirections
} from './src/types';

// Main function
async function main() {
  const args = parseArguments();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  let sourceUrl: string;
  let targetUrl: string | undefined;
  let excludeTables: string[];
  let skipSchemas: string[];
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
    outputDir = (args.outputDir || config.outputDir || ".") as string;
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

  // Create output directory if it doesn't exist
  if (outputDir !== ".") {
    try {
      await Bun.write(`${outputDir}/.gitkeep`, "");
      console.log(`\nOutput directory: ${outputDir}/`);
    } catch (error) {
      console.error(`Error creating output directory: ${error}`);
      process.exit(1);
    }
  }

  console.log(`\n${divider()}`);
  if (dumpOnlyMode) {
    console.log(c.header(`DATABASE SCHEMA DUMP (Source Only)`));
  } else {
    console.log(c.header(`DATABASE SCHEMA COMPARISON`));
  }
  console.log(`${divider()}\n`);

  // Load warning configuration
  const { config: warningConfig, ignoreRules, summary: configSummary } = await loadCompleteWarningConfig();
  if (configSummary) {
    console.log(configSummary);
  }

  // Fetch all available schemas from both databases
  console.log(c.step(`[1/${dumpOnlyMode ? 3 : 5}] Discovering schemas...`));
  process.stdout.write(c.dim(`  Fetching schemas from source...`));
  const sourceSchemas = await fetchSchemas(sourceUrl);
  console.log(` ${c.checkmark()} (${c.count(sourceSchemas.length)} schemas)`);

  let targetSchemas: string[] = [];
  if (!dumpOnlyMode) {
    process.stdout.write(c.dim(`  Fetching schemas from target...`));
    targetSchemas = await fetchSchemas(targetUrl!);
    console.log(` ${c.checkmark()} (${c.count(targetSchemas.length)} schemas)`);
  }

  // Merge schema lists (compare all schemas that exist in either DB)
  let allSchemas = Array.from(new Set([...sourceSchemas, ...targetSchemas]));

  // Filter out skipped schemas
  if (skipSchemas.length > 0) {
    const beforeCount = allSchemas.length;
    allSchemas = allSchemas.filter((schema) => !skipSchemas.includes(schema));
    console.log(
      c.dim(`  Skipping ${
        beforeCount - allSchemas.length
      } schemas: `) + c.warning(skipSchemas.join(", "))
    );
  }

  console.log(
    c.dim(`  Comparing across `) + c.count(allSchemas.length) + c.dim(` schemas: `) + c.highlight(allSchemas.join(", "))
  );

  if (excludeTables.length > 0) {
    console.log(c.dim(`  Excluding tables: `) + c.warning(excludeTables.join(", ")));
  }

  console.log(`\n${c.step(`[2/${dumpOnlyMode ? 3 : 5}] Fetching source database schema...`)}`);
  const sourceMetadata = await fetchAllSchemas(
    sourceUrl,
    allSchemas,
    excludeTables,
    "source"
  );
  console.log(c.dim(`  Found `) + c.count(sourceMetadata.tables.size) + c.dim(` tables, `) + c.count(sourceMetadata.enums.length) + c.dim(` enums, `) + c.count(sourceMetadata.functions.length) + c.dim(` functions, `) + c.count(sourceMetadata.extensions.length) + c.dim(` extensions`));

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
    console.log(`\n${c.step(`[3/5] Fetching target database schema...`)}`);
    targetMetadata = await fetchAllSchemas(
      targetUrl!,
      allSchemas,
      excludeTables,
      "target"
    );
    console.log(c.dim(`  Found `) + c.count(targetMetadata.tables.size) + c.dim(` tables, `) + c.count(targetMetadata.enums.length) + c.dim(` enums, `) + c.count(targetMetadata.functions.length) + c.dim(` functions, `) + c.count(targetMetadata.extensions.length) + c.dim(` extensions`));

    console.log(`\n${c.step(`[4/5] Comparing schemas...`)}`);
    diff = compareSchemas(sourceMetadata, targetMetadata);
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
        console.error(c.error(`Invalid transaction scope: ${scopeValue}. Using 'per-file'.`));
        transactionScope = 'per-file';
      }
      console.log(c.info(`  Transaction mode: ${c.highlight(transactionScope)}`));
    }

    // Determine dependency sorting
    const sortDependencies = args.sortDependencies !== false; // Default true
    if (sortDependencies) {
      console.log(c.info(`  Dependency sorting: ${c.highlight('enabled')}`));
    }

    // Determine circular dependency handling
    const handleCircularDeps = args.handleCircularDeps !== false; // Default true
    if (handleCircularDeps && sortDependencies) {
      console.log(c.info(`  Circular dependency handling: ${c.highlight('enabled')}`));
    }

    // Generate split SQL migration files
    console.log(`\n${c.subheader(`Generating split SQL migration files...`)}`);

    const splitSourceToTarget = generateSplitMigrationSQL(diff, sourceMetadata, targetMetadata, "source-to-target", transactionScope, sortDependencies, handleCircularDeps);
    const splitTargetToSource = generateSplitMigrationSQL(diff, sourceMetadata, targetMetadata, "target-to-source", transactionScope, sortDependencies, handleCircularDeps);

    // Create subdirectories for organized output
    const diffSourceTargetDir = `${outputDir}/diff-source-to-target`;
    const diffTargetSourceDir = `${outputDir}/diff-target-to-source`;

    // Write source-to-target files
    console.log(`\n  ${c.info(`Source ${c.arrow()} Target migrations:`)}`);
    await Bun.write(`${diffSourceTargetDir}/.gitkeep`, "");
    for (const [key, sql] of Object.entries(splitSourceToTarget)) {
      const filename = `${diffSourceTargetDir}/${key}.sql`;
      await Bun.write(filename, sql);
      console.log(`    ${c.checkmark()} ${c.path(filename)}`);
    }

    // Write target-to-source files
    console.log(`\n  ${c.info(`Target ${c.arrow()} Source migrations:`)}`);
    await Bun.write(`${diffTargetSourceDir}/.gitkeep`, "");
    for (const [key, sql] of Object.entries(splitTargetToSource)) {
      const filename = `${diffTargetSourceDir}/${key}.sql`;
      await Bun.write(filename, sql);
      console.log(`    ${c.checkmark()} ${c.path(filename)}`);
    }
  } else {
    console.log(`\n${c.step(`[3/3] Skipping comparison (dump-only mode)...`)}`);
  }

  // Generate README (only in comparison mode)
  if (!dumpOnlyMode) {
    const readme = generateMigrationReadme(outputPrefix);
    const readmePath = `${outputDir}/${outputPrefix}-MIGRATION-README.md`;
    await Bun.write(readmePath, readme);
    console.log(`\n  ${c.info(`Migration guide:`)}`);
    console.log(`    ${c.checkmark()} ${c.path(readmePath)}`);
  }

  // Generate rollback/cleanup scripts if requested
  if (args.generateCleanupSQL && !dumpOnlyMode) {
    console.log(`\n${c.subheader(`Generating rollback/cleanup scripts...`)}`);

    const dryRun = args.cleanupDryRun !== false; // default to true
    if (dryRun) {
      console.log(c.warning(`  ⚠️  DRY-RUN MODE: DROP statements will be commented out`));
      console.log(c.info(`  To enable actual execution, use: --cleanupDryRun=false`));
    } else {
      console.log(c.error(`  ⚠️  DRY-RUN DISABLED: DROP statements will execute!`));
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

    // Create subdirectories for rollback scripts
    const rollbackSourceToTargetDir = `${outputDir}/rollback-source-to-target`;
    const rollbackTargetToSourceDir = `${outputDir}/rollback-target-to-source`;

    // Write source→target rollback files
    console.log(`\n  ${c.info(`Rollback Source ${c.arrow()} Target:`)}`);
    await Bun.write(`${rollbackSourceToTargetDir}/.gitkeep`, "");
    for (const [key, sql] of Object.entries(rollbackSourceToTarget)) {
      const filename = `${rollbackSourceToTargetDir}/${key}.sql`;
      await Bun.write(filename, sql);
      console.log(`    ${c.checkmark()} ${c.path(filename)}${dryRun ? c.warning(' (DRY RUN)') : ''}`);
    }

    // Write target→source rollback files
    console.log(`\n  ${c.info(`Rollback Target ${c.arrow()} Source:`)}`);
    await Bun.write(`${rollbackTargetToSourceDir}/.gitkeep`, "");
    for (const [key, sql] of Object.entries(rollbackTargetToSource)) {
      const filename = `${rollbackTargetToSourceDir}/${key}.sql`;
      await Bun.write(filename, sql);
      console.log(`    ${c.checkmark()} ${c.path(filename)}${dryRun ? c.warning(' (DRY RUN)') : ''}`);
    }

    console.log(c.info(`\n  💡 Execute rollback files in reverse order (7→6→5→4→3→2→1)`));
  }

  // Generate full database migrations if requested
  if (args.generateFullMigrations) {
    console.log(`\n${c.subheader(`Generating full database schema dumps...`)}`);

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
    console.log(`\n  ${c.info(`Source database full schema:`)}`);
    await Bun.write(`${fullSourceDir}/.gitkeep`, "");
    const fullSourceDump = generateFullDatabaseSQL(sourceMetadata, "source", fullDumpTransactionScope, fullDumpSortDependencies, fullDumpHandleCircularDeps);
    for (const [key, sql] of Object.entries(fullSourceDump)) {
      const filename = `${fullSourceDir}/${key}.sql`;
      await Bun.write(filename, sql);
      console.log(`    ${c.checkmark()} ${c.path(filename)}`);
    }

    // Generate target database full dump (only if not in dump-only mode)
    if (!dumpOnlyMode) {
      const fullTargetDir = `${outputDir}/full-target`;
      console.log(`\n  ${c.info(`Target database full schema:`)}`);
      await Bun.write(`${fullTargetDir}/.gitkeep`, "");
      const fullTargetDump = generateFullDatabaseSQL(targetMetadata, "target", fullDumpTransactionScope, fullDumpSortDependencies, fullDumpHandleCircularDeps);
      for (const [key, sql] of Object.entries(fullTargetDump)) {
        const filename = `${fullTargetDir}/${key}.sql`;
        await Bun.write(filename, sql);
        console.log(`    ${c.checkmark()} ${c.path(filename)}`);
      }
    }

    console.log(`\n  ${c.highlight(`💡 To recreate a database locally, execute the files in order (1-7)`)}`);
  }

  // Print summary (only in comparison mode)
  if (!dumpOnlyMode && result) {
    printSummary(result);

    // Print health summary to console
    console.log(`\n${divider()}`);
    console.log(c.header(`SCHEMA SYNC HEALTH`));
    console.log(divider());

    const sync = healthMetrics!.sync;
    const syncSeverity = sync.overall.score >= 90 ? 'healthy' :
                         sync.overall.score >= 70 ? 'minor' :
                         sync.overall.score >= 40 ? 'moderate' : 'critical';
    const syncColor = syncSeverity === 'critical' ? c.critical :
                      syncSeverity === 'moderate' ? c.moderate :
                      syncSeverity === 'minor' ? c.minor : c.healthy;

    console.log(`Overall Sync: ${c.count(sync.overall.score)}/100 ${syncColor(sync.overall.score >= 90 ? '✓' : '⚠️')}`);

    console.log(`\n${c.subheader('Category Breakdown:')}`);
    const formatScore = (cat: any) => {
      const icon = cat.score === 100 ? c.healthy('✓') : c.warning('⚠️');
      const scoreStr = cat.score === 100 ? c.healthy(`${cat.score}/100`) : c.count(`${cat.score}/100`);
      return `  ${cat.label.padEnd(12)} ${scoreStr} ${icon}`;
    };

    console.log(formatScore(sync.categories.tables));
    console.log(formatScore(sync.categories.columns));
    console.log(formatScore(sync.categories.indexes));
    console.log(formatScore(sync.categories.constraints));
    console.log(formatScore(sync.categories.other));

    if (sync.overall.issues.length > 0) {
      console.log(`\n${c.warning('Sync Issues:')}`);
      sync.overall.issues.forEach((issue: string) => console.log(c.dim(`  - ${issue}`)));
    }

    console.log(`\n${divider()}`);
    console.log(c.header(`SCHEMA QUALITY`));
    console.log(divider());

    const formatQuality = (label: string, quality: any) => {
      const gradeColor = quality.grade === 'A' ? c.healthy :
                         quality.grade === 'B' ? c.healthy :
                         quality.grade === 'C' ? c.warning :
                         quality.grade === 'D' ? c.moderate :
                         c.critical;
      const severityLabel = quality.severity === 'healthy' ? 'Excellent' :
                           quality.severity === 'minor' ? 'Good' :
                           quality.severity === 'moderate' ? 'Needs Attention' :
                           'Critical';

      console.log(`${c.subheader(label)}: ${c.count(quality.score)}/100 (Grade: ${gradeColor(quality.grade)}) - ${severityLabel}`);
      if (quality.warnings.totalWarnings > 0) {
        let warningMsg = `  ${quality.warnings.totalWarnings} warning(s): ` +
          `${quality.warnings.criticalCount} critical, ` +
          `${quality.warnings.moderateCount} moderate, ` +
          `${quality.warnings.minorCount} minor`;
        if (quality.warnings.filteredCount) {
          warningMsg += c.dim(` [${quality.warnings.filteredCount} filtered]`);
        }
        console.log(c.dim(warningMsg));
      }
    };

    formatQuality('Source Database', healthMetrics!.sourceQuality);
    formatQuality('\nTarget Database', healthMetrics!.targetQuality);
  } else if (dumpOnlyMode) {
    console.log(`\n${divider()}`);
    console.log(c.header("SCHEMA DUMP COMPLETE"));
    console.log(divider());
    console.log(c.dim(`Dumped schema from: `) + c.path(maskConnectionString(sourceUrl)));
    console.log(c.dim(`Tables: `) + c.count(sourceMetadata.tables.size));
    console.log(c.dim(`Enums: `) + c.count(sourceMetadata.enums.length));
    console.log(c.dim(`Functions: `) + c.count(sourceMetadata.functions.length));
    console.log(c.dim(`Extensions: `) + c.count(sourceMetadata.extensions.length));
  }
}

// Run main
main().catch((error) => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
