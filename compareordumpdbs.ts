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
  generateMigrationReadme
} from './src/generators/sql';
import { writeMarkdown, printSummary, writeWarningReports } from './src/generators/markdown';
import { calculateHealthMetrics, calculateSyncDirections } from './src/health';
import { parseArguments, printHelp, loadConfig } from './src/config';
import { maskConnectionString } from './src/utils';
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

  console.log(`\n${"=".repeat(70)}`);
  if (dumpOnlyMode) {
    console.log(`DATABASE SCHEMA DUMP (Source Only)`);
  } else {
    console.log(`DATABASE SCHEMA COMPARISON`);
  }
  console.log(`${"=".repeat(70)}\n`);

  // Fetch all available schemas from both databases
  console.log(`[1/${dumpOnlyMode ? 3 : 5}] Discovering schemas...`);
  process.stdout.write(`  Fetching schemas from source...`);
  const sourceSchemas = await fetchSchemas(sourceUrl);
  console.log(` ✓ (${sourceSchemas.length} schemas)`);

  let targetSchemas: string[] = [];
  if (!dumpOnlyMode) {
    process.stdout.write(`  Fetching schemas from target...`);
    targetSchemas = await fetchSchemas(targetUrl!);
    console.log(` ✓ (${targetSchemas.length} schemas)`);
  }

  // Merge schema lists (compare all schemas that exist in either DB)
  let allSchemas = Array.from(new Set([...sourceSchemas, ...targetSchemas]));

  // Filter out skipped schemas
  if (skipSchemas.length > 0) {
    const beforeCount = allSchemas.length;
    allSchemas = allSchemas.filter((schema) => !skipSchemas.includes(schema));
    console.log(
      `  Skipping ${
        beforeCount - allSchemas.length
      } schemas: ${skipSchemas.join(", ")}`
    );
  }

  console.log(
    `  Comparing across ${allSchemas.length} schemas: ${allSchemas.join(", ")}`
  );

  if (excludeTables.length > 0) {
    console.log(`  Excluding tables: ${excludeTables.join(", ")}`);
  }

  console.log(`\n[2/${dumpOnlyMode ? 3 : 5}] Fetching source database schema...`);
  const sourceMetadata = await fetchAllSchemas(
    sourceUrl,
    allSchemas,
    excludeTables,
    "source"
  );
  console.log(`  Found ${sourceMetadata.tables.size} tables, ${sourceMetadata.enums.length} enums, ${sourceMetadata.functions.length} functions, ${sourceMetadata.extensions.length} extensions`);

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
    console.log(`\n[3/5] Fetching target database schema...`);
    targetMetadata = await fetchAllSchemas(
      targetUrl!,
      allSchemas,
      excludeTables,
      "target"
    );
    console.log(`  Found ${targetMetadata.tables.size} tables, ${targetMetadata.enums.length} enums, ${targetMetadata.functions.length} functions, ${targetMetadata.extensions.length} extensions`);

    console.log(`\n[4/5] Comparing schemas...`);
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
      console.log(`  Applying filters...`);
      if (filters.onlyMissingTables)
        console.log(`    - Only showing missing tables`);
      if (filters.onlyColumnDiffs)
        console.log(`    - Only showing column differences`);
      if (filters.criticalOnly)
        console.log(`    - Only showing critical/breaking changes`);
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
    console.log(`  Calculating health metrics...`);
    healthMetrics = calculateHealthMetrics(diff, sourceMetadata, targetMetadata);
    syncDirections = calculateSyncDirections(diff);

    // Save history if requested
    if (args.saveHistory) {
      const timestamp = new Date().toISOString().split("T")[0];
      const historyPath = `${outputDir}/${outputPrefix}-${timestamp}.json`;
      await Bun.write(historyPath, JSON.stringify(result, null, 2));
      console.log(`  Saved snapshot: ${historyPath}`);
    }

    // Write outputs
    console.log(`\n[5/5] Writing output...`);
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

    // Generate split SQL migration files
    console.log(`\nGenerating split SQL migration files...`);

    const splitSourceToTarget = generateSplitMigrationSQL(diff, sourceMetadata, targetMetadata, "source-to-target");
    const splitTargetToSource = generateSplitMigrationSQL(diff, sourceMetadata, targetMetadata, "target-to-source");

    // Create subdirectories for organized output
    const diffSourceTargetDir = `${outputDir}/diff-source-to-target`;
    const diffTargetSourceDir = `${outputDir}/diff-target-to-source`;

    // Write source-to-target files
    console.log(`\n  Source → Target migrations:`);
    await Bun.write(`${diffSourceTargetDir}/.gitkeep`, "");
    for (const [key, sql] of Object.entries(splitSourceToTarget)) {
      const filename = `${diffSourceTargetDir}/${key}.sql`;
      await Bun.write(filename, sql);
      console.log(`    ✓ ${filename}`);
    }

    // Write target-to-source files
    console.log(`\n  Target → Source migrations:`);
    await Bun.write(`${diffTargetSourceDir}/.gitkeep`, "");
    for (const [key, sql] of Object.entries(splitTargetToSource)) {
      const filename = `${diffTargetSourceDir}/${key}.sql`;
      await Bun.write(filename, sql);
      console.log(`    ✓ ${filename}`);
    }
  } else {
    console.log(`\n[3/3] Skipping comparison (dump-only mode)...`);
  }

  // Generate README (only in comparison mode)
  if (!dumpOnlyMode) {
    const readme = generateMigrationReadme(outputPrefix);
    const readmePath = `${outputDir}/${outputPrefix}-MIGRATION-README.md`;
    await Bun.write(readmePath, readme);
    console.log(`\n  Migration guide:`);
    console.log(`    ✓ ${readmePath}`);
  }

  // Generate full database migrations if requested
  if (args.generateFullMigrations) {
    console.log(`\nGenerating full database schema dumps...`);

    const fullSourceDir = `${outputDir}/full-source`;

    // Generate source database full dump
    console.log(`\n  Source database full schema:`);
    await Bun.write(`${fullSourceDir}/.gitkeep`, "");
    const fullSourceDump = generateFullDatabaseSQL(sourceMetadata, "source");
    for (const [key, sql] of Object.entries(fullSourceDump)) {
      const filename = `${fullSourceDir}/${key}.sql`;
      await Bun.write(filename, sql);
      console.log(`    ✓ ${filename}`);
    }

    // Generate target database full dump (only if not in dump-only mode)
    if (!dumpOnlyMode) {
      const fullTargetDir = `${outputDir}/full-target`;
      console.log(`\n  Target database full schema:`);
      await Bun.write(`${fullTargetDir}/.gitkeep`, "");
      const fullTargetDump = generateFullDatabaseSQL(targetMetadata, "target");
      for (const [key, sql] of Object.entries(fullTargetDump)) {
        const filename = `${fullTargetDir}/${key}.sql`;
        await Bun.write(filename, sql);
        console.log(`    ✓ ${filename}`);
      }
    }

    console.log(`\n  💡 To recreate a database locally, execute the files in order (1-7)`);
  }

  // Print summary (only in comparison mode)
  if (!dumpOnlyMode && result) {
    printSummary(result);

    // Print health summary to console
    console.log(`\n${"=".repeat(70)}`);
    console.log(`SCHEMA HEALTH`);
    console.log("=".repeat(70));
    console.log(`Score: ${healthMetrics!.score}/100 (${healthMetrics!.severity})`);
    if (healthMetrics!.issues.length > 0) {
      console.log(`\nIssues:`);
      healthMetrics!.issues.forEach((issue) => console.log(`  - ${issue}`));
    }
  } else if (dumpOnlyMode) {
    console.log(`\n${"=".repeat(70)}`);
    console.log("SCHEMA DUMP COMPLETE");
    console.log("=".repeat(70));
    console.log(`Dumped schema from: ${maskConnectionString(sourceUrl)}`);
    console.log(`Tables: ${sourceMetadata.tables.size}`);
    console.log(`Enums: ${sourceMetadata.enums.length}`);
    console.log(`Functions: ${sourceMetadata.functions.length}`);
    console.log(`Extensions: ${sourceMetadata.extensions.length}`);
  }
}

// Run main
main().catch((error) => {
  console.error('\nFatal error:', error);
  process.exit(1);
});
