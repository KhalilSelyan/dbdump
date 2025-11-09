import type { AnalysisResult, HealthMetrics, SyncDirections, SchemaMetadata, TableInfo, SchemaWarning } from '../types';
import { maskConnectionString } from '../utils';

async function writeMarkdown(
  data: AnalysisResult,
  outputPrefix: string,
  outputDir: string,
  syncDirections: SyncDirections,
  healthMetrics: HealthMetrics,
  sourceSchema: Map<string, TableInfo>,
  targetSchema: Map<string, TableInfo>
) {
  const outputPath = `${outputDir}/${outputPrefix}.md`;
  process.stdout.write(`Writing Markdown report...`);

  let md = `# Database Schema Comparison Report\n\n`;
  md += `**Generated:** ${new Date(data.timestamp).toLocaleString()}\n\n`;
  md += `**Source:** \`${maskConnectionString(data.sourceDb)}\`\n\n`;
  md += `**Target:** \`${maskConnectionString(data.targetDb)}\`\n\n`;

  md += `---\n\n`;

  // Health Score Section
  const severityEmoji = {
    healthy: "✅",
    minor: "⚠️",
    moderate: "🔶",
    critical: "❌",
  };

  md += `## 🏥 Schema Health Score\n\n`;
  md += `**Score:** ${healthMetrics.score}/100 ${
    severityEmoji[healthMetrics.severity]
  }\n\n`;
  md += `**Status:** ${
    healthMetrics.severity.charAt(0).toUpperCase() +
    healthMetrics.severity.slice(1)
  }\n\n`;

  if (healthMetrics.issues.length > 0) {
    md += `**Issues Detected:**\n\n`;
    for (const issue of healthMetrics.issues) {
      md += `- ${issue}\n`;
    }
    md += `\n`;
  }

  md += `---\n\n`;

  // Bidirectional Sync Analysis
  md += `## 🔄 Sync Requirements\n\n`;
  md += `### Source → Target\n\n`;
  if (
    syncDirections.sourceToTarget.tablesToCreate === 0 &&
    syncDirections.sourceToTarget.columnsToAdd === 0 &&
    syncDirections.sourceToTarget.columnsToModify === 0
  ) {
    md += `✅ Target is up to date with source\n\n`;
  } else {
    md += `To sync target with source:\n\n`;
    if (syncDirections.sourceToTarget.tablesToCreate > 0) {
      md += `- Create **${syncDirections.sourceToTarget.tablesToCreate}** table(s)\n`;
    }
    if (syncDirections.sourceToTarget.columnsToAdd > 0) {
      md += `- Add **${syncDirections.sourceToTarget.columnsToAdd}** column(s)\n`;
    }
    if (syncDirections.sourceToTarget.columnsToModify > 0) {
      md += `- Modify **${syncDirections.sourceToTarget.columnsToModify}** column(s)\n`;
    }
    md += `\n`;
  }

  md += `### Target → Source\n\n`;
  if (
    syncDirections.targetToSource.tablesToCreate === 0 &&
    syncDirections.targetToSource.columnsToAdd === 0 &&
    syncDirections.targetToSource.columnsToModify === 0
  ) {
    md += `✅ Source is up to date with target\n\n`;
  } else {
    md += `To sync source with target:\n\n`;
    if (syncDirections.targetToSource.tablesToCreate > 0) {
      md += `- Create **${syncDirections.targetToSource.tablesToCreate}** table(s)\n`;
    }
    if (syncDirections.targetToSource.columnsToAdd > 0) {
      md += `- Add **${syncDirections.targetToSource.columnsToAdd}** column(s)\n`;
    }
    if (syncDirections.targetToSource.columnsToModify > 0) {
      md += `- Modify **${syncDirections.targetToSource.columnsToModify}** column(s)\n`;
    }
    md += `\n`;
  }

  md += `---\n\n`;

  md += `## 📊 Detailed Summary\n\n`;
  md += `| Metric | Count |\n`;
  md += `|--------|-------|\n`;
  md += `| Tables only in source | ${data.summary.tablesOnlyInSource} |\n`;
  md += `| Tables only in target | ${data.summary.tablesOnlyInTarget} |\n`;
  md += `| Tables with differences | ${data.summary.tablesWithDifferences} |\n`;
  md += `| Total column differences | ${data.summary.totalColumnDifferences} |\n\n`;

  if (
    data.summary.tablesOnlyInSource === 0 &&
    data.summary.tablesOnlyInTarget === 0 &&
    data.summary.tablesWithDifferences === 0
  ) {
    md += `### ✅ No differences found!\n\nSchemas are identical.\n`;
    await Bun.write(outputPath, md);
    console.log(` ✓ ${outputPath}`);
    return;
  }

  // Tables only in source
  if (data.diff.tablesOnlyInSource.length > 0) {
    md += `---\n\n`;
    md += `## 📋 Tables Only in Source\n\n`;
    md += `These tables exist in the source database but are missing in the target:\n\n`;

    const groupedBySchema = new Map<string, TableReference[]>();
    for (const tableRef of data.diff.tablesOnlyInSource) {
      if (!groupedBySchema.has(tableRef.schema)) {
        groupedBySchema.set(tableRef.schema, []);
      }
      groupedBySchema.get(tableRef.schema)!.push(tableRef);
    }

    for (const [schema, tableRefs] of groupedBySchema) {
      md += `### Schema: \`${schema}\`\n\n`;
      for (const tableRef of tableRefs) {
        md += `#### \`${tableRef.table}\`\n\n`;

        // Get table info from sourceSchema
        const tableKey = `${tableRef.schema}.${tableRef.table}`;
        const tableInfo = sourceSchema.get(tableKey);

        if (tableInfo && tableInfo.columns.length > 0) {
          md += `| Column | Type | Nullable | Default |\n`;
          md += `|--------|------|----------|----------|\n`;
          for (const col of tableInfo.columns) {
            md += `| \`${col.column_name}\` | \`${col.data_type}\` | ${
              col.is_nullable
            } | ${col.column_default || "none"} |\n`;
          }
          md += `\n`;
        }
      }
    }
  }

  // Tables only in target
  if (data.diff.tablesOnlyInTarget.length > 0) {
    md += `---\n\n`;
    md += `## 📋 Tables Only in Target\n\n`;
    md += `These tables exist in the target database but are missing in the source:\n\n`;

    const groupedBySchema = new Map<string, TableReference[]>();
    for (const tableRef of data.diff.tablesOnlyInTarget) {
      if (!groupedBySchema.has(tableRef.schema)) {
        groupedBySchema.set(tableRef.schema, []);
      }
      groupedBySchema.get(tableRef.schema)!.push(tableRef);
    }

    for (const [schema, tableRefs] of groupedBySchema) {
      md += `### Schema: \`${schema}\`\n\n`;
      for (const tableRef of tableRefs) {
        md += `#### \`${tableRef.table}\`\n\n`;

        // Get table info from targetSchema
        const tableKey = `${tableRef.schema}.${tableRef.table}`;
        const tableInfo = targetSchema.get(tableKey);

        if (tableInfo && tableInfo.columns.length > 0) {
          md += `| Column | Type | Nullable | Default |\n`;
          md += `|--------|------|----------|----------|\n`;
          for (const col of tableInfo.columns) {
            md += `| \`${col.column_name}\` | \`${col.data_type}\` | ${
              col.is_nullable
            } | ${col.column_default || "none"} |\n`;
          }
          md += `\n`;
        }
      }
    }
  }

  // Tables with differences
  if (data.diff.tablesInBoth.length > 0) {
    md += `---\n\n`;
    md += `## 🔄 Tables with Column Differences\n\n`;

    // Group by schema
    const tablesBySchema = new Map<string, TableDiff[]>();
    for (const table of data.diff.tablesInBoth) {
      if (!tablesBySchema.has(table.table_schema)) {
        tablesBySchema.set(table.table_schema, []);
      }
      tablesBySchema.get(table.table_schema)!.push(table);
    }

    for (const [schema, tables] of tablesBySchema) {
      md += `### Schema: \`${schema}\`\n\n`;

      for (const table of tables) {
        md += `#### \`${table.table_name}\`\n\n`;

        // Columns only in source
        if (table.columnsOnlyInSource.length > 0) {
          md += `**Columns only in source:**\n\n`;
          md += `| Column | Type | Nullable | Default |\n`;
          md += `|--------|------|----------|----------|\n`;
          for (const col of table.columnsOnlyInSource) {
            md += `| \`${col.column_name}\` | \`${col.data_type}\` | ${
              col.is_nullable
            } | ${col.column_default || "none"} |\n`;
          }
          md += `\n`;
        }

        // Columns only in target
        if (table.columnsOnlyInTarget.length > 0) {
          md += `**Columns only in target:**\n\n`;
          md += `| Column | Type | Nullable | Default |\n`;
          md += `|--------|------|----------|----------|\n`;
          for (const col of table.columnsOnlyInTarget) {
            md += `| \`${col.column_name}\` | \`${col.data_type}\` | ${
              col.is_nullable
            } | ${col.column_default || "none"} |\n`;
          }
          md += `\n`;
        }

        // Columns with differences
        if (table.columnsWithDifferences.length > 0) {
          md += `**Columns with differences:**\n\n`;
          md += `| Column | Property | Source | Target | ⚠️ |\n`;
          md += `|--------|----------|--------|--------|----|\n`;
          for (const colDiff of table.columnsWithDifferences) {
            for (const diff of colDiff.differences) {
              const [property, values] = diff.split(": ");
              const [sourceVal, targetVal] = values.split(" vs ");
              const criticalIndicator = colDiff.isCritical ? "🔴" : "";
              md += `| \`${colDiff.column_name}\` | ${property} | \`${sourceVal}\` | \`${targetVal}\` | ${criticalIndicator} |\n`;
            }
          }
          md += `\n`;
          md += `_🔴 = Breaking change_\n\n`;
        }

        // Indexes only in source
        if (table.indexesOnlyInSource.length > 0) {
          md += `**Indexes only in source:**\n\n`;
          md += `| Index | Type | Columns | Unique | Primary |\n`;
          md += `|-------|------|---------|--------|----------|\n`;
          for (const idx of table.indexesOnlyInSource) {
            md += `| \`${idx.index_name}\` | \`${idx.index_type}\` | \`${idx.columns.join(', ')}\` | ${idx.is_unique ? '✓' : ''} | ${idx.is_primary ? '✓' : ''} |\n`;
          }
          md += `\n`;
        }

        // Indexes only in target
        if (table.indexesOnlyInTarget.length > 0) {
          md += `**Indexes only in target:**\n\n`;
          md += `| Index | Type | Columns | Unique | Primary |\n`;
          md += `|-------|------|---------|--------|----------|\n`;
          for (const idx of table.indexesOnlyInTarget) {
            md += `| \`${idx.index_name}\` | \`${idx.index_type}\` | \`${idx.columns.join(', ')}\` | ${idx.is_unique ? '✓' : ''} | ${idx.is_primary ? '✓' : ''} |\n`;
          }
          md += `\n`;
        }

        // Foreign keys only in source
        if (table.foreignKeysOnlyInSource.length > 0) {
          md += `**Foreign keys only in source:**\n\n`;
          md += `| Constraint | Column | References | On Delete | On Update |\n`;
          md += `|------------|--------|------------|-----------|------------|\n`;
          for (const fk of table.foreignKeysOnlyInSource) {
            md += `| \`${fk.constraint_name}\` | \`${fk.column_name}\` | \`${fk.foreign_table_schema}.${fk.foreign_table_name}(${fk.foreign_column_name})\` | \`${fk.on_delete}\` | \`${fk.on_update}\` |\n`;
          }
          md += `\n`;
        }

        // Foreign keys only in target
        if (table.foreignKeysOnlyInTarget.length > 0) {
          md += `**Foreign keys only in target:**\n\n`;
          md += `| Constraint | Column | References | On Delete | On Update |\n`;
          md += `|------------|--------|------------|-----------|------------|\n`;
          for (const fk of table.foreignKeysOnlyInTarget) {
            md += `| \`${fk.constraint_name}\` | \`${fk.column_name}\` | \`${fk.foreign_table_schema}.${fk.foreign_table_name}(${fk.foreign_column_name})\` | \`${fk.on_delete}\` | \`${fk.on_update}\` |\n`;
          }
          md += `\n`;
        }

        // Constraints only in source
        if (table.constraintsOnlyInSource.length > 0) {
          md += `**Constraints only in source:**\n\n`;
          md += `| Constraint | Type | Definition | Columns |\n`;
          md += `|------------|------|-------------|----------|\n`;
          for (const constraint of table.constraintsOnlyInSource) {
            const definition = constraint.constraint_type === 'CHECK'
              ? (constraint.check_clause || 'N/A')
              : (constraint.columns && Array.isArray(constraint.columns) && constraint.columns.length > 0 ? constraint.columns.join(', ') : 'N/A');
            const columns = constraint.constraint_type === 'UNIQUE' && constraint.columns && Array.isArray(constraint.columns)
              ? `\`${constraint.columns.join(', ')}\``
              : '-';
            md += `| \`${constraint.constraint_name}\` | \`${constraint.constraint_type}\` | \`${definition}\` | ${columns} |\n`;
          }
          md += `\n`;
        }

        // Constraints only in target
        if (table.constraintsOnlyInTarget.length > 0) {
          md += `**Constraints only in target:**\n\n`;
          md += `| Constraint | Type | Definition | Columns |\n`;
          md += `|------------|------|-------------|----------|\n`;
          for (const constraint of table.constraintsOnlyInTarget) {
            const definition = constraint.constraint_type === 'CHECK'
              ? (constraint.check_clause || 'N/A')
              : (constraint.columns && Array.isArray(constraint.columns) && constraint.columns.length > 0 ? constraint.columns.join(', ') : 'N/A');
            const columns = constraint.constraint_type === 'UNIQUE' && constraint.columns && Array.isArray(constraint.columns)
              ? `\`${constraint.columns.join(', ')}\``
              : '-';
            md += `| \`${constraint.constraint_name}\` | \`${constraint.constraint_type}\` | \`${definition}\` | ${columns} |\n`;
          }
          md += `\n`;
        }
      }
    }
  }

  await Bun.write(outputPath, md);
  console.log(` ✓ ${outputPath}`);
}

// Print detailed summary
function printSummary(result: AnalysisResult) {
  console.log(`\n${"=".repeat(70)}`);
  console.log("DATABASE SCHEMA COMPARISON SUMMARY");
  console.log("=".repeat(70));

  console.log(`\nSource DB: ${maskConnectionString(result.sourceDb)}`);
  console.log(`Target DB: ${maskConnectionString(result.targetDb)}`);
  console.log(`Analysis Time: ${new Date(result.timestamp).toLocaleString()}`);

  console.log(`\n--- Overview ---`);
  console.log(`Tables only in source: ${result.summary.tablesOnlyInSource}`);
  console.log(`Tables only in target: ${result.summary.tablesOnlyInTarget}`);
  console.log(
    `Tables with differences: ${result.summary.tablesWithDifferences}`
  );
  console.log(
    `Total column differences: ${result.summary.totalColumnDifferences}`
  );

  if (result.diff.tablesOnlyInSource.length > 0) {
    console.log(`\n--- Tables Only in Source ---`);
    result.diff.tablesOnlyInSource.forEach((tableRef) => {
      console.log(`  • ${tableRef.schema}.${tableRef.table}`);
    });
  }

  if (result.diff.tablesOnlyInTarget.length > 0) {
    console.log(`\n--- Tables Only in Target ---`);
    result.diff.tablesOnlyInTarget.forEach((tableRef) => {
      console.log(`  • ${tableRef.schema}.${tableRef.table}`);
    });
  }

  if (result.diff.tablesInBoth.length > 0) {
    console.log(`\n--- Tables with Column Differences ---`);
    for (const table of result.diff.tablesInBoth) {
      console.log(`\n  ${table.table_schema}.${table.table_name}:`);

      if (table.columnsOnlyInSource.length > 0) {
        console.log(`    Columns only in source:`);
        table.columnsOnlyInSource.forEach((col) => {
          console.log(`      - ${col.column_name} (${col.data_type})`);
        });
      }

      if (table.columnsOnlyInTarget.length > 0) {
        console.log(`    Columns only in target:`);
        table.columnsOnlyInTarget.forEach((col) => {
          console.log(`      - ${col.column_name} (${col.data_type})`);
        });
      }

      if (table.columnsWithDifferences.length > 0) {
        console.log(`    Columns with differences:`);
        table.columnsWithDifferences.forEach((colDiff) => {
          console.log(`      - ${colDiff.column_name}:`);
          colDiff.differences.forEach((diff) => {
            console.log(`          ${diff}`);
          });
        });
      }
    }
  }

  if (
    result.summary.tablesOnlyInSource === 0 &&
    result.summary.tablesOnlyInTarget === 0 &&
    result.summary.tablesWithDifferences === 0
  ) {
    console.log(`\n✓ No differences found! Schemas are identical.`);
  }
}

/**
 * Format warnings for markdown output
 */
function formatWarnings(warnings: SchemaWarning[]): string {
  let md = '';

  // Group by table
  const warningsByTable = new Map<string, SchemaWarning[]>();
  for (const warning of warnings) {
    if (!warningsByTable.has(warning.table)) {
      warningsByTable.set(warning.table, []);
    }
    warningsByTable.get(warning.table)!.push(warning);
  }

  // Format each table's warnings
  for (const [table, tableWarnings] of warningsByTable) {
    md += `#### \`${table}\`\n\n`;

    for (const warning of tableWarnings) {
      const severityEmoji = {
        minor: '🟡',
        moderate: '🟠',
        critical: '🔴'
      };

      md += `**${warning.type.replace(/_/g, ' ')}** ${severityEmoji[warning.severity]} (${warning.severity})\n`;
      md += `- ${warning.message}\n`;

      if (warning.details) {
        if (Array.isArray(warning.details)) {
          md += `- Affected items: \`${warning.details.join('`, `')}\`\n`;
        } else if (typeof warning.details === 'object') {
          md += `- Details: ${JSON.stringify(warning.details, null, 2)}\n`;
        }
      }

      md += `- *Recommendation: ${warning.recommendation}*\n\n`;
    }
  }

  return md;
}

/**
 * Write separate warning files for source and target databases
 */
async function writeWarningReports(
  sourceDb: string,
  targetDb: string,
  healthMetrics: HealthMetrics,
  outputDir: string
) {
  if (!healthMetrics.warnings || healthMetrics.warnings.totalWarnings === 0) {
    return;
  }

  // Source warnings
  if (healthMetrics.warnings.sourceWarnings.length > 0) {
    const sourcePath = `${outputDir}/db-schema-warnings-source.md`;
    process.stdout.write(`Writing source warnings...`);

    let md = `# Database Schema Warnings - Source\n\n`;
    md += `**Database:** \`${maskConnectionString(sourceDb)}\`\n\n`;
    md += `**Generated:** ${new Date().toLocaleString()}\n\n`;
    md += `---\n\n`;
    md += `## Summary\n\n`;

    const sourceWarnings = healthMetrics.warnings.sourceWarnings;
    const criticalCount = sourceWarnings.filter(w => w.severity === 'critical').length;
    const moderateCount = sourceWarnings.filter(w => w.severity === 'moderate').length;
    const minorCount = sourceWarnings.filter(w => w.severity === 'minor').length;

    md += `**Total Warnings:** ${sourceWarnings.length}\n\n`;
    md += `| Severity | Count |\n`;
    md += `|----------|-------|\n`;
    md += `| 🔴 Critical | ${criticalCount} |\n`;
    md += `| 🟠 Moderate | ${moderateCount} |\n`;
    md += `| 🟡 Minor | ${minorCount} |\n\n`;
    md += `---\n\n`;
    md += `## Warnings by Table\n\n`;
    md += formatWarnings(sourceWarnings);

    await Bun.write(sourcePath, md);
    console.log(` ✓ ${sourcePath}`);
  }

  // Target warnings
  if (healthMetrics.warnings.targetWarnings.length > 0) {
    const targetPath = `${outputDir}/db-schema-warnings-target.md`;
    process.stdout.write(`Writing target warnings...`);

    let md = `# Database Schema Warnings - Target\n\n`;
    md += `**Database:** \`${maskConnectionString(targetDb)}\`\n\n`;
    md += `**Generated:** ${new Date().toLocaleString()}\n\n`;
    md += `---\n\n`;
    md += `## Summary\n\n`;

    const targetWarnings = healthMetrics.warnings.targetWarnings;
    const criticalCount = targetWarnings.filter(w => w.severity === 'critical').length;
    const moderateCount = targetWarnings.filter(w => w.severity === 'moderate').length;
    const minorCount = targetWarnings.filter(w => w.severity === 'minor').length;

    md += `**Total Warnings:** ${targetWarnings.length}\n\n`;
    md += `| Severity | Count |\n`;
    md += `|----------|-------|\n`;
    md += `| 🔴 Critical | ${criticalCount} |\n`;
    md += `| 🟠 Moderate | ${moderateCount} |\n`;
    md += `| 🟡 Minor | ${minorCount} |\n\n`;
    md += `---\n\n`;
    md += `## Warnings by Table\n\n`;
    md += formatWarnings(targetWarnings);

    await Bun.write(targetPath, md);
    console.log(` ✓ ${targetPath}`);
  }
}

// Main function


export { writeMarkdown, printSummary, writeWarningReports };
