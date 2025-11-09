import type { SchemaDiff, SchemaMetadata, WarningsReport } from '../types';

/**
 * Generate cleanup SQL to remove duplicate indexes and extra objects
 */
export function generateCleanupSQL(
  diff: SchemaDiff,
  metadata: SchemaMetadata,
  warnings: WarningsReport['sourceWarnings'] | WarningsReport['targetWarnings'],
  direction: 'source' | 'target',
  dryRun: boolean = true
): string {
  const timestamp = new Date().toLocaleString();
  let sql = `-- Cleanup Script${dryRun ? ' - DRY RUN MODE' : ''}\n`;
  sql += `-- Generated: ${timestamp}\n`;
  sql += `-- WARNING: Review carefully before executing!\n\n`;

  if (dryRun) {
    sql += `BEGIN;\n\n`;
  }

  sql += `-- ============================================================\n`;
  sql += `-- CLEANUP OPERATIONS\n`;
  sql += `-- ============================================================\n\n`;

  let hasOperations = false;

  // Section 1: Drop duplicate indexes from warnings
  const duplicateIndexWarnings = warnings.filter(w => w.type === 'DUPLICATE_INDEX');
  if (duplicateIndexWarnings.length > 0) {
    sql += `-- ============================================================\n`;
    sql += `-- DROP DUPLICATE INDEXES\n`;
    sql += `-- ============================================================\n\n`;

    for (const warning of duplicateIndexWarnings) {
      const [schema, tableName] = warning.table.split('.');

      // warning.details is an array of index names
      // We keep the first one and drop the rest
      if (Array.isArray(warning.details) && warning.details.length > 1) {
        const indexesToDrop = warning.details.slice(1);

        sql += `-- Table: ${warning.table}\n`;
        sql += `-- Reason: ${warning.message}\n`;
        sql += `-- Keeping: ${warning.details[0]}\n`;

        for (const indexName of indexesToDrop) {
          sql += `DROP INDEX IF EXISTS "${schema}"."${indexName}";\n`;
          hasOperations = true;
        }

        sql += `\n`;
      }
    }
  }

  // Section 2: Drop duplicate primary keys (critical issue)
  const duplicatePKWarnings = warnings.filter(w => w.type === 'DUPLICATE_PRIMARY_KEY');
  if (duplicatePKWarnings.length > 0) {
    sql += `-- ============================================================\n`;
    sql += `-- DROP DUPLICATE PRIMARY KEY CONSTRAINTS\n`;
    sql += `-- WARNING: This is a critical data integrity issue!\n`;
    sql += `-- ============================================================\n\n`;

    for (const warning of duplicatePKWarnings) {
      const [schema, tableName] = warning.table.split('.');

      // warning.details is an array of {name, columns} objects
      if (Array.isArray(warning.details) && warning.details.length > 1) {
        const pksToRetain = warning.details.slice(0, 1);
        const pksToDrop = warning.details.slice(1);

        sql += `-- Table: ${warning.table}\n`;
        sql += `-- Keeping: ${pksToRetain.map((pk: any) => pk.name).join(', ')}\n`;

        for (const pk of pksToDrop) {
          sql += `ALTER TABLE "${schema}"."${tableName}" DROP CONSTRAINT IF EXISTS "${pk.name}";\n`;
          hasOperations = true;
        }

        sql += `\n`;
      }
    }
  }

  // Add note about other warnings
  const missingPKCount = warnings.filter(w => w.type === 'MISSING_PRIMARY_KEY').length;
  const unindexedFKCount = warnings.filter(w => w.type === 'UNINDEXED_FOREIGN_KEY').length;

  if (missingPKCount > 0 || unindexedFKCount > 0) {
    sql += `-- ============================================================\n`;
    sql += `-- OTHER WARNINGS (require manual intervention)\n`;
    sql += `-- ============================================================\n\n`;

    if (missingPKCount > 0) {
      sql += `-- ${missingPKCount} table(s) missing PRIMARY KEY\n`;
      sql += `-- These require manual review to determine appropriate primary key.\n`;
      sql += `-- See db-schema-warnings-${direction}.md for details.\n\n`;
    }

    if (unindexedFKCount > 0) {
      sql += `-- ${unindexedFKCount} foreign key(s) without supporting index\n`;
      sql += `-- These can impact JOIN performance.\n`;
      sql += `-- See db-schema-warnings-${direction}.md for CREATE INDEX recommendations.\n\n`;
    }
  }

  if (!hasOperations) {
    sql += `-- No cleanup operations needed!\n`;
    sql += `-- All duplicate indexes and constraints are already clean.\n\n`;
  }

  if (dryRun) {
    sql += `ROLLBACK; -- Remove this line and change to COMMIT to execute\n`;
  } else {
    sql += `-- Execute this script to apply cleanup operations.\n`;
  }

  return sql;
}

/**
 * Generate cleanup scripts for both source and target databases
 */
export function generateCleanupScripts(
  diff: SchemaDiff,
  sourceMetadata: SchemaMetadata,
  targetMetadata: SchemaMetadata,
  sourceWarnings: WarningsReport['sourceWarnings'],
  targetWarnings: WarningsReport['targetWarnings'],
  dryRun: boolean = true
): { source: string; target: string } {
  return {
    source: generateCleanupSQL(diff, sourceMetadata, sourceWarnings, 'source', dryRun),
    target: generateCleanupSQL(diff, targetMetadata, targetWarnings, 'target', dryRun)
  };
}
