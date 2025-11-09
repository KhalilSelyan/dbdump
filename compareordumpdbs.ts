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
  type TransactionScope
} from './src/generators/sql';
import { writeMarkdown, printSummary, writeWarningReports } from './src/generators/markdown';
import { generateCleanupScripts } from './src/generators/cleanup';
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

  // Generate cleanup scripts if requested
  if (args.generateCleanupSQL && !dumpOnlyMode && healthMetrics?.warnings) {
    console.log(`\n${c.subheader(`Generating cleanup scripts...`)}`);

    const dryRun = args.cleanupDryRun !== false; // default to true
    const cleanupScripts = generateCleanupScripts(
      diff,
      sourceMetadata,
      targetMetadata,
      healthMetrics.warnings.sourceWarnings,
      healthMetrics.warnings.targetWarnings,
      dryRun
    );

    const cleanupSourcePath = `${outputDir}/cleanup-source.sql`;
    const cleanupTargetPath = `${outputDir}/cleanup-target.sql`;

    await Bun.write(cleanupSourcePath, cleanupScripts.source);
    console.log(`  ${c.checkmark()} ${c.path(cleanupSourcePath)}${dryRun ? c.warning(' (DRY RUN)') : ''}`);

    await Bun.write(cleanupTargetPath, cleanupScripts.target);
    console.log(`  ${c.checkmark()} ${c.path(cleanupTargetPath)}${dryRun ? c.warning(' (DRY RUN)') : ''}`);
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
    console.log(c.header(`SCHEMA HEALTH`));
    console.log(divider());

    const severityColor = healthMetrics!.severity === 'critical' ? c.critical :
                          healthMetrics!.severity === 'moderate' ? c.moderate :
                          healthMetrics!.severity === 'minor' ? c.minor : c.healthy;

    console.log(`Score: ${c.count(healthMetrics!.score)}/100 (${severityColor(healthMetrics!.severity.toUpperCase())})`);
    if (healthMetrics!.issues.length > 0) {
      console.log(`\n${c.warning(`Issues:`)}`);
      healthMetrics!.issues.forEach((issue) => console.log(c.dim(`  - ${issue}`)));
    }
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
