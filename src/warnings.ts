import type { SchemaMetadata, TableInfo, SchemaWarning, WarningsReport, WarningConfig, IgnoreRule, WarningSeverity } from './types';
import { areColumnArraysEqual } from './utils';
import { shouldIgnoreWarning } from './config-loader';

/**
 * Detect duplicate indexes (same columns, possibly different names)
 */
export function detectDuplicateIndexes(table: TableInfo): SchemaWarning[] {
  const warnings: SchemaWarning[] = [];
  const indexMap = new Map<string, typeof table.indexes>();

  // Group indexes by their columns (order-independent)
  for (const idx of table.indexes) {
    // Skip primary key indexes as they're supposed to be unique
    if (idx.is_primary) continue;

    const key = [...idx.columns].sort().join(',');
    if (!indexMap.has(key)) {
      indexMap.set(key, []);
    }
    indexMap.get(key)!.push(idx);
  }

  // Find duplicates
  for (const [columnKey, indexes] of indexMap) {
    if (indexes.length > 1) {
      // Check if they're the same type
      const types = indexes.map(i => i.index_type);
      const allSameType = types.every(t => t === types[0]);

      warnings.push({
        type: 'DUPLICATE_INDEX',
        severity: 'minor',
        table: `${table.table_schema}.${table.table_name}`,
        message: allSameType
          ? `${indexes.length} ${types[0]} indexes on same columns: ${columnKey}`
          : `${indexes.length} indexes on same columns: ${columnKey} (types: ${types.join(', ')})`,
        details: indexes.map(i => i.index_name),
        recommendation: `Keep one index, drop others: ${indexes.slice(1).map(i => `DROP INDEX ${table.table_schema}.${i.index_name}`).join('; ')}`
      });
    }
  }

  return warnings;
}

/**
 * Detect tables with multiple PRIMARY KEY constraints
 */
export function detectDuplicatePrimaryKeys(table: TableInfo): SchemaWarning[] {
  const primaryKeys = table.indexes.filter(idx => idx.is_primary);

  if (primaryKeys.length > 1) {
    return [{
      type: 'DUPLICATE_PRIMARY_KEY',
      severity: 'critical',
      table: `${table.table_schema}.${table.table_name}`,
      message: `Table has ${primaryKeys.length} PRIMARY KEY constraints`,
      details: primaryKeys.map(pk => ({
        name: pk.index_name,
        columns: pk.columns.join(', ')
      })),
      recommendation: `This is a data integrity error. Drop duplicate PRIMARY KEYs: ${primaryKeys.slice(1).map(pk => `ALTER TABLE ${table.table_schema}.${table.table_name} DROP CONSTRAINT ${pk.index_name}`).join('; ')}`
    }];
  }

  return [];
}

/**
 * Detect tables without PRIMARY KEY
 */
export function detectMissingPrimaryKeys(table: TableInfo): SchemaWarning[] {
  const hasPrimaryKey = table.indexes.some(idx => idx.is_primary);

  if (!hasPrimaryKey) {
    return [{
      type: 'MISSING_PRIMARY_KEY',
      severity: 'moderate',
      table: `${table.table_schema}.${table.table_name}`,
      message: 'Table has no PRIMARY KEY',
      details: null,
      recommendation: 'Consider adding a PRIMARY KEY for better performance and data integrity. Example: ALTER TABLE ... ADD PRIMARY KEY (id);'
    }];
  }

  return [];
}

/**
 * Detect foreign keys without supporting indexes
 */
export function detectUnindexedForeignKeys(table: TableInfo): SchemaWarning[] {
  const warnings: SchemaWarning[] = [];

  for (const fk of table.foreignKeys) {
    const fkColumns = [fk.column_name];

    // Check if any index covers this FK
    // An index covers a FK if the FK columns are a prefix of the index columns
    const hasCoveringIndex = table.indexes.some(idx => {
      if (fkColumns.length > idx.columns.length) return false;

      // FK columns must match index prefix in exact order
      for (let i = 0; i < fkColumns.length; i++) {
        if (idx.columns[i] !== fkColumns[i]) return false;
      }

      return true;
    });

    if (!hasCoveringIndex) {
      warnings.push({
        type: 'UNINDEXED_FOREIGN_KEY',
        severity: 'moderate',
        table: `${table.table_schema}.${table.table_name}`,
        message: `Foreign key on "${fk.column_name}" lacks supporting index`,
        details: {
          constraint: fk.constraint_name,
          column: fk.column_name,
          references: `${fk.foreign_table_schema}.${fk.foreign_table_name}(${fk.foreign_column_name})`
        },
        recommendation: `CREATE INDEX ON "${table.table_schema}"."${table.table_name}" ("${fk.column_name}");`
      });
    }
  }

  return warnings;
}

/**
 * Run all warning detectors on a single table
 */
export function analyzeTable(table: TableInfo): SchemaWarning[] {
  return [
    ...detectDuplicateIndexes(table),
    ...detectDuplicatePrimaryKeys(table),
    ...detectMissingPrimaryKeys(table),
    ...detectUnindexedForeignKeys(table),
  ];
}

/**
 * Analyze all tables in a schema metadata
 */
export function analyzeSchema(metadata: SchemaMetadata): SchemaWarning[] {
  const warnings: SchemaWarning[] = [];

  for (const [tableKey, tableInfo] of metadata.tables) {
    warnings.push(...analyzeTable(tableInfo));
  }

  return warnings;
}

/**
 * Apply warning configuration (severity overrides and filtering)
 */
export function applyWarningConfig(
  warnings: SchemaWarning[],
  config: WarningConfig,
  ignoreRules: IgnoreRule[]
): { filtered: SchemaWarning[]; filteredCount: number } {
  let filteredCount = 0;

  const filtered = warnings
    .filter(warning => {
      // Check if warning should be ignored
      if (shouldIgnoreWarning(warning.type, warning.table, ignoreRules)) {
        filteredCount++;
        return false;
      }
      return true;
    })
    .map(warning => {
      // Apply severity overrides
      const customSeverity = config.severity[warning.type];
      if (customSeverity) {
        return { ...warning, severity: customSeverity };
      }
      return warning;
    });

  return { filtered, filteredCount };
}

/**
 * Generate a warnings report for both source and target
 */
export function generateWarningsReport(
  sourceMetadata: SchemaMetadata,
  targetMetadata: SchemaMetadata,
  config: WarningConfig = { severity: {}, ignore: [] },
  ignoreRules: IgnoreRule[] = []
): WarningsReport {
  const rawSourceWarnings = analyzeSchema(sourceMetadata);
  const rawTargetWarnings = analyzeSchema(targetMetadata);

  // Apply configuration
  const { filtered: sourceWarnings, filteredCount: sourceFiltered } = applyWarningConfig(
    rawSourceWarnings,
    config,
    ignoreRules
  );
  const { filtered: targetWarnings, filteredCount: targetFiltered } = applyWarningConfig(
    rawTargetWarnings,
    config,
    ignoreRules
  );

  const allWarnings = [...sourceWarnings, ...targetWarnings];
  const totalFiltered = sourceFiltered + targetFiltered;

  return {
    sourceWarnings,
    targetWarnings,
    totalWarnings: allWarnings.length,
    criticalCount: allWarnings.filter(w => w.severity === 'critical').length,
    moderateCount: allWarnings.filter(w => w.severity === 'moderate').length,
    minorCount: allWarnings.filter(w => w.severity === 'minor').length,
    filteredCount: totalFiltered > 0 ? totalFiltered : undefined,
  };
}
