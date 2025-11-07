import type { SchemaMetadata, SchemaDiff, TableDiff, ColumnDifference, FilterOptions } from './types';
import { normalizeCheckClause, areColumnArraysEqual, findEquivalentUniqueIndex, findEquivalentUniqueConstraint } from './utils';

function compareColumns(
  source: ColumnInfo,
  target: ColumnInfo
): { differences: string[]; isCritical: boolean } | null {
  const differences: string[] = [];
  let isCritical = false;

  if (source.data_type !== target.data_type) {
    differences.push(`type: ${source.data_type} vs ${target.data_type}`);
    isCritical = true; // Type changes are breaking
  }

  if (source.is_nullable !== target.is_nullable) {
    differences.push(
      `nullable: ${source.is_nullable} vs ${target.is_nullable}`
    );
    // Making column NOT NULL is breaking
    if (source.is_nullable === "YES" && target.is_nullable === "NO") {
      isCritical = true;
    }
  }

  if (source.column_default !== target.column_default) {
    differences.push(
      `default: ${source.column_default || "none"} vs ${
        target.column_default || "none"
      }`
    );
  }

  if (source.character_maximum_length !== target.character_maximum_length) {
    differences.push(
      `max_length: ${source.character_maximum_length || "none"} vs ${
        target.character_maximum_length || "none"
      }`
    );
    // Reducing max length is potentially breaking
    if (
      source.character_maximum_length &&
      target.character_maximum_length &&
      source.character_maximum_length > target.character_maximum_length
    ) {
      isCritical = true;
    }
  }

  if (source.numeric_precision !== target.numeric_precision) {
    differences.push(
      `precision: ${source.numeric_precision || "none"} vs ${
        target.numeric_precision || "none"
      }`
    );
  }

  if (source.numeric_scale !== target.numeric_scale) {
    differences.push(
      `scale: ${source.numeric_scale || "none"} vs ${
        target.numeric_scale || "none"
      }`
    );
  }

  return differences.length > 0 ? { differences, isCritical } : null;
}

// Compare schemas and find differences
function compareSchemas(
  sourceMetadata: SchemaMetadata,
  targetMetadata: SchemaMetadata
): SchemaDiff {
  const sourceSchema = sourceMetadata.tables;
  const targetSchema = targetMetadata.tables;
  const diff: SchemaDiff = {
    tablesOnlyInSource: [],
    tablesOnlyInTarget: [],
    tablesInBoth: [],
  };

  process.stdout.write(`  Identifying table differences...`);

  // Find tables only in source
  for (const [tableKey, tableInfo] of sourceSchema) {
    if (!targetSchema.has(tableKey)) {
      diff.tablesOnlyInSource.push({
        schema: tableInfo.table_schema,
        table: tableInfo.table_name,
      });
    }
  }

  // Find tables only in target
  for (const [tableKey, tableInfo] of targetSchema) {
    if (!sourceSchema.has(tableKey)) {
      diff.tablesOnlyInTarget.push({
        schema: tableInfo.table_schema,
        table: tableInfo.table_name,
      });
    }
  }
  console.log(" ✓");

  // Compare tables that exist in both
  const commonTables = Array.from(sourceSchema.keys()).filter((key) =>
    targetSchema.has(key)
  );

  if (commonTables.length > 0) {
    process.stdout.write(`  Comparing ${commonTables.length} common tables...`);
  }

  let processedTables = 0;
  for (const tableKey of sourceSchema.keys()) {
    if (!targetSchema.has(tableKey)) continue;

    const sourceTable = sourceSchema.get(tableKey)!;
    const targetTable = targetSchema.get(tableKey)!;

    processedTables++;
    if (commonTables.length > 0 && processedTables % 10 === 0) {
      process.stdout.write(
        `\r  Comparing ${commonTables.length} common tables... (${processedTables}/${commonTables.length})`
      );
    }

    const tableDiff: TableDiff = {
      table_name: sourceTable.table_name,
      table_schema: sourceTable.table_schema,
      columnsOnlyInSource: [],
      columnsOnlyInTarget: [],
      columnsWithDifferences: [],
      indexesOnlyInSource: [],
      indexesOnlyInTarget: [],
      foreignKeysOnlyInSource: [],
      foreignKeysOnlyInTarget: [],
      constraintsOnlyInSource: [],
      constraintsOnlyInTarget: [],
    };

    // Create column maps for easier lookup
    const sourceColumns = new Map(
      sourceTable.columns.map((col) => [col.column_name, col])
    );
    const targetColumns = new Map(
      targetTable.columns.map((col) => [col.column_name, col])
    );

    // Find columns only in source
    for (const [colName, colInfo] of sourceColumns) {
      if (!targetColumns.has(colName)) {
        tableDiff.columnsOnlyInSource.push(colInfo);
      }
    }

    // Find columns only in target
    for (const [colName, colInfo] of targetColumns) {
      if (!sourceColumns.has(colName)) {
        tableDiff.columnsOnlyInTarget.push(colInfo);
      }
    }

    // Compare columns that exist in both
    for (const [colName, sourceCol] of sourceColumns) {
      if (!targetColumns.has(colName)) continue;

      const targetCol = targetColumns.get(colName)!;
      const result = compareColumns(sourceCol, targetCol);

      if (result) {
        tableDiff.columnsWithDifferences.push({
          column_name: colName,
          source: sourceCol,
          target: targetCol,
          differences: result.differences,
          isCritical: result.isCritical,
        });
      }
    }

    // Compare indexes
    const sourceIndexes = new Map(
      sourceTable.indexes.map((idx) => [idx.index_name, idx])
    );
    const targetIndexes = new Map(
      targetTable.indexes.map((idx) => [idx.index_name, idx])
    );

    for (const [idxName, idxInfo] of sourceIndexes) {
      if (!targetIndexes.has(idxName)) {
        // For unique indexes, check if an equivalent UNIQUE constraint exists in target
        if (idxInfo.is_unique && !idxInfo.is_primary && idxInfo.columns) {
          const equivalentConstraint = findEquivalentUniqueConstraint(idxInfo.columns, targetTable.constraints);
          if (!equivalentConstraint) {
            tableDiff.indexesOnlyInSource.push(idxInfo);
          }
        } else {
          tableDiff.indexesOnlyInSource.push(idxInfo);
        }
      }
    }

    for (const [idxName, idxInfo] of targetIndexes) {
      if (!sourceIndexes.has(idxName)) {
        // For unique indexes, check if an equivalent UNIQUE constraint exists in source
        if (idxInfo.is_unique && !idxInfo.is_primary && idxInfo.columns) {
          const equivalentConstraint = findEquivalentUniqueConstraint(idxInfo.columns, sourceTable.constraints);
          if (!equivalentConstraint) {
            tableDiff.indexesOnlyInTarget.push(idxInfo);
          }
        } else {
          tableDiff.indexesOnlyInTarget.push(idxInfo);
        }
      }
    }

    // Compare foreign keys
    const sourceFKs = new Map(
      sourceTable.foreignKeys.map((fk) => [fk.constraint_name, fk])
    );
    const targetFKs = new Map(
      targetTable.foreignKeys.map((fk) => [fk.constraint_name, fk])
    );

    for (const [fkName, fkInfo] of sourceFKs) {
      if (!targetFKs.has(fkName)) {
        tableDiff.foreignKeysOnlyInSource.push(fkInfo);
      }
    }

    for (const [fkName, fkInfo] of targetFKs) {
      if (!sourceFKs.has(fkName)) {
        tableDiff.foreignKeysOnlyInTarget.push(fkInfo);
      }
    }

    // Compare constraints (by logic, not name)
    const sourceConstraints = new Map(
      sourceTable.constraints.map((c) => [c.constraint_name, c])
    );
    const targetConstraints = new Map(
      targetTable.constraints.map((c) => [c.constraint_name, c])
    );

    // Helper to normalize constraint check clause for comparison
    const normalizeCheckClause = (clause: string | undefined): string => {
      if (!clause) return '';
      // Remove extra whitespace, normalize spacing around operators, remove outer parens
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
    };

    // Find constraints in source that don't exist in target (by logic)
    for (const [cName, cInfo] of sourceConstraints) {
      // If constraint exists by name, skip
      if (targetConstraints.has(cName)) continue;

      // For CHECK constraints, check if an equivalent one exists with different name
      if (cInfo.constraint_type === 'CHECK' && cInfo.check_clause) {
        const normalizedSourceClause = normalizeCheckClause(cInfo.check_clause);
        let foundEquivalent = false;

        for (const targetConstraint of targetConstraints.values()) {
          if (targetConstraint.constraint_type === 'CHECK' && targetConstraint.check_clause) {
            const normalizedTargetClause = normalizeCheckClause(targetConstraint.check_clause);
            if (normalizedSourceClause === normalizedTargetClause) {
              foundEquivalent = true;
              break;
            }
          }
        }

        // Only add if no equivalent found
        if (!foundEquivalent) {
          tableDiff.constraintsOnlyInSource.push(cInfo);
        }
      } else if (cInfo.constraint_type === 'UNIQUE' && cInfo.columns && Array.isArray(cInfo.columns) && cInfo.columns.length > 0) {
        // For UNIQUE constraints, check if an equivalent one exists with different name but same columns
        const sourceColumns = [...cInfo.columns].sort().join(',');
        let foundEquivalent = false;

        // Check for equivalent UNIQUE constraint
        for (const targetConstraint of targetConstraints.values()) {
          if (targetConstraint.constraint_type === 'UNIQUE' && targetConstraint.columns && Array.isArray(targetConstraint.columns) && targetConstraint.columns.length > 0) {
            const targetColumns = [...targetConstraint.columns].sort().join(',');
            if (sourceColumns === targetColumns) {
              foundEquivalent = true;
              break;
            }
          }
        }

        // Also check if an equivalent unique index exists in target
        if (!foundEquivalent) {
          const equivalentIndex = findEquivalentUniqueIndex(cInfo.columns, targetTable.indexes);
          if (equivalentIndex) {
            foundEquivalent = true;
          }
        }

        // Only add if no equivalent found
        if (!foundEquivalent) {
          tableDiff.constraintsOnlyInSource.push(cInfo);
        }
      } else {
        // For other constraint types, use name-based comparison
        tableDiff.constraintsOnlyInSource.push(cInfo);
      }
    }

    // Find constraints in target that don't exist in source (by logic)
    for (const [cName, cInfo] of targetConstraints) {
      // If constraint exists by name, skip
      if (sourceConstraints.has(cName)) continue;

      // For CHECK constraints, check if an equivalent one exists with different name
      if (cInfo.constraint_type === 'CHECK' && cInfo.check_clause) {
        const normalizedTargetClause = normalizeCheckClause(cInfo.check_clause);
        let foundEquivalent = false;

        for (const sourceConstraint of sourceConstraints.values()) {
          if (sourceConstraint.constraint_type === 'CHECK' && sourceConstraint.check_clause) {
            const normalizedSourceClause = normalizeCheckClause(sourceConstraint.check_clause);
            if (normalizedTargetClause === normalizedSourceClause) {
              foundEquivalent = true;
              break;
            }
          }
        }

        // Only add if no equivalent found
        if (!foundEquivalent) {
          tableDiff.constraintsOnlyInTarget.push(cInfo);
        }
      } else if (cInfo.constraint_type === 'UNIQUE' && cInfo.columns && Array.isArray(cInfo.columns) && cInfo.columns.length > 0) {
        // For UNIQUE constraints, check if an equivalent one exists with different name but same columns
        const targetColumns = [...cInfo.columns].sort().join(',');
        let foundEquivalent = false;

        // Check for equivalent UNIQUE constraint
        for (const sourceConstraint of sourceConstraints.values()) {
          if (sourceConstraint.constraint_type === 'UNIQUE' && sourceConstraint.columns && Array.isArray(sourceConstraint.columns) && sourceConstraint.columns.length > 0) {
            const sourceColumns = [...sourceConstraint.columns].sort().join(',');
            if (targetColumns === sourceColumns) {
              foundEquivalent = true;
              break;
            }
          }
        }

        // Also check if an equivalent unique index exists in source
        if (!foundEquivalent) {
          const equivalentIndex = findEquivalentUniqueIndex(cInfo.columns, sourceTable.indexes);
          if (equivalentIndex) {
            foundEquivalent = true;
          }
        }

        // Only add if no equivalent found
        if (!foundEquivalent) {
          tableDiff.constraintsOnlyInTarget.push(cInfo);
        }
      } else {
        // For other constraint types, use name-based comparison
        tableDiff.constraintsOnlyInTarget.push(cInfo);
      }
    }

    // Only include table if there are differences
    if (
      tableDiff.columnsOnlyInSource.length > 0 ||
      tableDiff.columnsOnlyInTarget.length > 0 ||
      tableDiff.columnsWithDifferences.length > 0 ||
      tableDiff.indexesOnlyInSource.length > 0 ||
      tableDiff.indexesOnlyInTarget.length > 0 ||
      tableDiff.foreignKeysOnlyInSource.length > 0 ||
      tableDiff.foreignKeysOnlyInTarget.length > 0 ||
      tableDiff.constraintsOnlyInSource.length > 0 ||
      tableDiff.constraintsOnlyInTarget.length > 0
    ) {
      diff.tablesInBoth.push(tableDiff);
    }
  }

  if (commonTables.length > 0) {
    console.log(" ✓");
  }

  return diff;
}

// Apply filters to diff results
function applyFilters(diff: SchemaDiff, filters: FilterOptions): SchemaDiff {
  const filtered: SchemaDiff = {
    tablesOnlyInSource: diff.tablesOnlyInSource,
    tablesOnlyInTarget: diff.tablesOnlyInTarget,
    tablesInBoth: diff.tablesInBoth,
  };

  // Apply onlyMissingTables filter
  if (filters.onlyMissingTables) {
    // Keep only missing tables, clear column diffs
    filtered.tablesInBoth = [];
  }

  // Apply onlyColumnDiffs filter
  if (filters.onlyColumnDiffs) {
    // Keep only column diffs, clear missing tables
    filtered.tablesOnlyInSource = [];
    filtered.tablesOnlyInTarget = [];
  }

  // Apply criticalOnly filter
  if (filters.criticalOnly) {
    // Filter to only critical column differences
    filtered.tablesInBoth = filtered.tablesInBoth
      .map((table) => ({
        ...table,
        columnsOnlyInSource: table.columnsOnlyInSource, // Missing columns are critical
        columnsOnlyInTarget: table.columnsOnlyInTarget,
        columnsWithDifferences: table.columnsWithDifferences.filter(
          (col) => col.isCritical
        ),
      }))
      .filter(
        (table) =>
          table.columnsOnlyInSource.length > 0 ||
          table.columnsOnlyInTarget.length > 0 ||
          table.columnsWithDifferences.length > 0
      );
  }

  return filtered;
}

// Calculate bidirectional sync requirements
function calculateSyncDirections(diff: SchemaDiff): SyncDirections {
  let sourceToTargetTables = 0;
  let sourceToTargetColumns = 0;
  let sourceToTargetModify = 0;

  let targetToSourceTables = 0;
  let targetToSourceColumns = 0;
  let targetToSourceModify = 0;

  // Tables only in source need to be created in target
  sourceToTargetTables = diff.tablesOnlyInSource.length;

  // Tables only in target need to be created in source
  targetToSourceTables = diff.tablesOnlyInTarget.length;

  // For common tables, count column changes
  for (const table of diff.tablesInBoth) {
    sourceToTargetColumns += table.columnsOnlyInSource.length;
    sourceToTargetModify += table.columnsWithDifferences.length;

    targetToSourceColumns += table.columnsOnlyInTarget.length;
    // Modifications are counted in both directions
    targetToSourceModify += table.columnsWithDifferences.length;
  }

  return {
    sourceToTarget: {
      tablesToCreate: sourceToTargetTables,
      columnsToAdd: sourceToTargetColumns,
      columnsToModify: sourceToTargetModify,
    },
    targetToSource: {
      tablesToCreate: targetToSourceTables,
      columnsToAdd: targetToSourceColumns,
      columnsToModify: targetToSourceModify,
    },
  };
}

// Helper function to format column definition for SQL


export { compareColumns, compareSchemas, applyFilters };
