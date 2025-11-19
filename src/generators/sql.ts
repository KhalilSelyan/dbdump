import type { SchemaDiff, SchemaMetadata, TableInfo, SplitMigrationFiles } from './types';
import { formatColumnDefinition } from '../utils';

/**
 * Transaction scope options
 */
export type TransactionScope = 'per-file' | 'single' | 'none';

/**
 * Wrap SQL content in a transaction block
 */
export function wrapInTransaction(sql: string, label: string, scope: TransactionScope, fileNumber: number, totalFiles: number): string {
  if (scope === 'none') {
    return sql;
  }

  if (scope === 'per-file') {
    return `-- ============================================================
-- Transaction: ${label}
-- ============================================================
BEGIN;

${sql}

COMMIT;

-- If any error occurs, all changes in this transaction will be rolled back
`;
  }

  // Single transaction mode
  if (fileNumber === 1) {
    // Start transaction in first file
    return `-- ============================================================
-- BEGIN SINGLE TRANSACTION
-- All migration files must be executed in the same session
-- ============================================================
BEGIN;

${sql}`;
  } else if (fileNumber === totalFiles) {
    // End transaction in last file
    return `${sql}

-- ============================================================
-- COMMIT SINGLE TRANSACTION
-- ============================================================
COMMIT;

-- Transaction complete - all changes committed atomically
`;
  } else {
    // Middle files - no transaction boundaries
    return sql;
  }
}

// ============================================================
// DEPENDENCY GRAPH AND TOPOLOGICAL SORTING
// ============================================================

/**
 * Build a dependency graph from foreign key relationships
 * Returns a map where each table maps to a set of tables it depends on
 */
function buildDependencyGraph(
  tables: Array<{ schema: string; table: string }>,
  metadata: SchemaMetadata
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const tableSet = new Set(tables.map(t => `${t.schema}.${t.table}`));

  for (const tableRef of tables) {
    const tableKey = `${tableRef.schema}.${tableRef.table}`;
    const tableInfo = metadata.tables.get(tableKey);

    if (!tableInfo) continue;

    // Initialize node
    if (!graph.has(tableKey)) {
      graph.set(tableKey, new Set<string>());
    }

    // Add edges for each foreign key
    for (const fk of tableInfo.foreignKeys) {
      const referencedTable = `${fk.foreign_table_schema}.${fk.foreign_table_name}`;

      // Only add dependency if referenced table is in our set of tables to create
      // This avoids dependencies on external tables that already exist
      if (tableSet.has(referencedTable) && referencedTable !== tableKey) {
        graph.get(tableKey)!.add(referencedTable);
      }
    }
  }

  return graph;
}

/**
 * Topological sort using Kahn's algorithm
 * Returns sorted tables and detects circular dependencies
 */
function topologicalSort(graph: Map<string, Set<string>>): {
  sorted: string[];
  hasCycles: boolean;
  remaining: Set<string>;
} {
  const inDegree = new Map<string, number>();
  const sorted: string[] = [];
  const queue: string[] = [];

  // Initialize all nodes
  for (const node of graph.keys()) {
    inDegree.set(node, 0);
  }

  // Calculate in-degrees
  for (const [node, deps] of graph) {
    for (const dep of deps) {
      if (!inDegree.has(dep)) {
        inDegree.set(dep, 0);
      }
      inDegree.set(dep, inDegree.get(dep)! + 1);
    }
  }

  // Find nodes with zero in-degree
  for (const [node, degree] of inDegree) {
    if (degree === 0) {
      queue.push(node);
    }
  }

  // Process queue
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    // Reduce in-degree for dependent nodes
    for (const neighbor of graph.get(node) || []) {
      const newDegree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Check for cycles
  const hasCycles = sorted.length !== graph.size;
  const remaining = new Set<string>();

  if (hasCycles) {
    // Find nodes that weren't sorted (part of cycles)
    for (const node of graph.keys()) {
      if (!sorted.includes(node)) {
        remaining.add(node);
      }
    }
  }

  return { sorted, hasCycles, remaining };
}

/**
 * Find strongly connected components (cycles) in the dependency graph
 * Returns groups of tables that have circular dependencies
 */
function findStronglyConnectedComponents(
  graph: Map<string, Set<string>>
): string[][] {
  const visited = new Set<string>();
  const stack: string[] = [];
  const inStack = new Set<string>();
  const components: string[][] = [];

  function dfs(node: string, component: string[]): void {
    visited.add(node);
    inStack.add(node);
    component.push(node);

    const neighbors = graph.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, component);
      } else if (inStack.has(neighbor)) {
        // Found a cycle - this component has circular dependency
        component.push(neighbor);
      }
    }

    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      const component: string[] = [];
      dfs(node, component);

      // Only include components with more than 1 node or self-references
      if (component.length > 1) {
        // Check if there's actual circular dependency
        const hasCircular = component.some(n => {
          const deps = graph.get(n) || new Set();
          return component.some(other => other !== n && deps.has(other));
        });

        if (hasCircular) {
          components.push([...new Set(component)]); // Remove duplicates
        }
      } else if (component.length === 1) {
        // Check for self-reference
        const node = component[0];
        const deps = graph.get(node) || new Set();
        if (deps.has(node)) {
          components.push(component);
        }
      }
    }
  }

  return components;
}

/**
 * Generate SQL for tables with circular dependencies
 * Creates tables in two phases: tables without FKs, then add FKs with DEFERRABLE
 */
function generateCircularDependencySQL(
  circularTables: Set<string>,
  metadata: SchemaMetadata,
  cycles: string[][]
): string {
  let sql = `-- ============================================================\n`;
  sql += `-- CIRCULAR DEPENDENCY HANDLING\n`;
  sql += `-- Tables with circular foreign key dependencies\n`;
  sql += `-- ============================================================\n\n`;

  sql += `-- ⚠️  WARNING: Circular dependencies detected!\n`;
  sql += `-- The following dependency cycles were found:\n`;
  for (let i = 0; i < cycles.length; i++) {
    sql += `--   Cycle ${i + 1}: ${cycles[i].join(' → ')} → ${cycles[i][0]}\n`;
  }
  sql += `--\n`;
  sql += `-- These tables will be created in two phases:\n`;
  sql += `--   1. Create table structures (without foreign keys)\n`;
  sql += `--   2. Add foreign keys with DEFERRABLE INITIALLY DEFERRED\n\n`;

  // Phase 1: Create tables without foreign keys
  sql += `-- ============================================================\n`;
  sql += `-- PHASE 1: Create table structures (without foreign keys)\n`;
  sql += `-- ============================================================\n\n`;

  for (const tableKey of circularTables) {
    const tableInfo = metadata.tables.get(tableKey);
    if (!tableInfo) continue;

    const [schema, table] = tableKey.split('.');
    sql += `-- Table: ${schema}.${table} (part of circular dependency)\n`;
    sql += `CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (\n`;

    const columnDefs: string[] = [];
    for (const col of tableInfo.columns) {
      columnDefs.push(`  ${formatColumnDefinition(col)}`);
    }

    sql += columnDefs.join(',\n');
    sql += `\n);\n\n`;

    // Set sequence ownership
    if (tableInfo.sequences.length > 0) {
      for (const seq of tableInfo.sequences) {
        for (const col of tableInfo.columns) {
          if (col.column_default?.includes(seq.sequence_name)) {
            sql += `ALTER SEQUENCE "${seq.sequence_schema}"."${seq.sequence_name}" OWNED BY "${schema}"."${table}"."${col.column_name}";\n\n`;
            break;
          }
        }
      }
    }
  }

  // Phase 2: Add foreign keys with DEFERRABLE
  sql += `-- ============================================================\n`;
  sql += `-- PHASE 2: Add foreign keys with DEFERRABLE constraints\n`;
  sql += `-- ============================================================\n\n`;

  sql += `-- ℹ️  DEFERRABLE INITIALLY DEFERRED constraints are checked at\n`;
  sql += `-- transaction COMMIT time, allowing circular references to work.\n\n`;

  for (const tableKey of circularTables) {
    const tableInfo = metadata.tables.get(tableKey);
    if (!tableInfo || tableInfo.foreignKeys.length === 0) continue;

    const [schema, table] = tableKey.split('.');

    sql += `-- Foreign keys for: ${schema}.${table}\n`;
    for (const fk of tableInfo.foreignKeys) {
      sql += `ALTER TABLE "${schema}"."${table}" ADD CONSTRAINT "${fk.constraint_name}" `;
      sql += `FOREIGN KEY ("${fk.column_name}") `;
      sql += `REFERENCES "${fk.foreign_table_schema}"."${fk.foreign_table_name}"("${fk.foreign_column_name}") `;
      sql += `ON DELETE ${fk.on_delete} ON UPDATE ${fk.on_update} `;
      sql += `DEFERRABLE INITIALLY DEFERRED;\n`;
    }
    sql += `\n`;
  }

  return sql;
}

function formatColumnDefinition(col: ColumnInfo, includeDefault: boolean = true): string {
  let colDef = `"${col.column_name}" `;

  // Normalize data type (remove precision from integer types)
  let dataType = col.data_type;

  // Integer types should not have precision/scale
  const integerTypes = ['smallint', 'integer', 'bigint', 'int2', 'int4', 'int8', 'smallserial', 'serial', 'bigserial'];
  const isIntegerType = integerTypes.includes(dataType.toLowerCase());

  // Add data type
  colDef += dataType;

  // Add length/precision only for non-integer types
  if (!isIntegerType) {
    if (col.character_maximum_length) {
      colDef += `(${col.character_maximum_length})`;
    } else if (col.numeric_precision && col.numeric_scale !== null && col.numeric_scale > 0) {
      colDef += `(${col.numeric_precision}, ${col.numeric_scale})`;
    } else if (col.numeric_precision && col.data_type.toLowerCase().includes('numeric')) {
      colDef += `(${col.numeric_precision})`;
    }
  }

  // Add NOT NULL
  if (col.is_nullable === 'NO') {
    colDef += ' NOT NULL';
  }

  // Add DEFAULT
  if (includeDefault && col.column_default) {
    colDef += ` DEFAULT ${col.column_default}`;
  }

  return colDef;
}

// Helper: Generate Extensions and ENUMs SQL (no functions - they go in file 8)
function generateExtensionsEnumsSQL(
  sourceMetadata: SchemaMetadata,
  targetMetadata: SchemaMetadata
): string {
  let sql = `-- ============================================================\n`;
  sql += `-- EXTENSIONS AND ENUMS\n`;
  sql += `-- Foundation types (no table dependencies)\n`;
  sql += `-- ============================================================\n\n`;

  // Schemas - Extract all non-default schemas used in the database
  const schemas = new Set<string>();

  // Add schemas from tables
  for (const table of sourceMetadata.tables.values()) {
    if (table.table_schema && table.table_schema !== 'public') {
      schemas.add(table.table_schema);
    }
  }

  // Add schemas from enums
  for (const enumInfo of sourceMetadata.enums) {
    if (enumInfo.schema && enumInfo.schema !== 'public') {
      schemas.add(enumInfo.schema);
    }
  }

  // Add schemas from functions
  for (const funcInfo of sourceMetadata.functions) {
    if (funcInfo.schema && funcInfo.schema !== 'public') {
      schemas.add(funcInfo.schema);
    }
  }

  // Filter out system schemas
  const systemSchemas = ['pg_catalog', 'information_schema', 'pg_toast'];
  const userSchemas = Array.from(schemas).filter(s => !systemSchemas.includes(s)).sort();

  if (userSchemas.length > 0) {
    sql += `-- Schemas\n`;
    sql += `-- Create non-default schemas before creating objects in them\n`;
    for (const schema of userSchemas) {
      sql += `CREATE SCHEMA IF NOT EXISTS "${schema}";\n`;
    }
    sql += `\n`;
  }

  // Extensions
  const sourceExtensions = new Map(sourceMetadata.extensions.map(e => [e.name, e]));
  const targetExtensions = new Map(targetMetadata.extensions.map(e => [e.name, e]));
  const missingExtensions = Array.from(sourceExtensions.values()).filter(ext => !targetExtensions.has(ext.name));

  if (missingExtensions.length > 0) {
    sql += `-- Extensions\n`;
    for (const ext of missingExtensions) {
      sql += `CREATE EXTENSION IF NOT EXISTS "${ext.name}" WITH SCHEMA "${ext.schema}";\n`;
    }
    sql += `\n`;
  }

  // ENUM types
  const sourceEnums = new Map(sourceMetadata.enums.map(e => [`${e.schema}.${e.name}`, e]));
  const targetEnums = new Map(targetMetadata.enums.map(e => [`${e.schema}.${e.name}`, e]));
  const missingEnums: EnumTypeInfo[] = [];

  for (const [key, enumInfo] of sourceEnums) {
    if (!targetEnums.has(key)) {
      missingEnums.push(enumInfo);
    }
  }

  if (missingEnums.length > 0) {
    sql += `-- ENUM Types\n`;
    for (const enumInfo of missingEnums) {
      if (!enumInfo.values || !Array.isArray(enumInfo.values) || enumInfo.values.length === 0) {
        sql += `-- WARNING: ENUM type ${enumInfo.schema}.${enumInfo.name} has no values, skipping\n\n`;
        continue;
      }

      sql += `DO $$ BEGIN\n`;
      sql += `  CREATE TYPE "${enumInfo.schema}"."${enumInfo.name}" AS ENUM (\n`;
      sql += enumInfo.values.map(v => `    '${v.replace(/'/g, "''")}'`).join(',\n');
      sql += `\n  );\n`;
      sql += `EXCEPTION\n`;
      sql += `  WHEN duplicate_object THEN null;\n`;
      sql += `END $$;\n\n`;
    }
  }

  return sql || `-- No extensions or enums to create\n\n`;
}

// Helper: Generate Functions SQL (separate file after tables)
function generateFunctionsSQL(
  sourceMetadata: SchemaMetadata,
  targetMetadata: SchemaMetadata
): string {
  let sql = `-- ============================================================\n`;
  sql += `-- FUNCTIONS\n`;
  sql += `-- Functions that may reference tables (created after tables)\n`;
  sql += `-- ============================================================\n\n`;

  const sourceFunctions = new Map(sourceMetadata.functions.map(f => [`${f.schema}.${f.name}`, f]));
  const targetFunctions = new Map(targetMetadata.functions.map(f => [`${f.schema}.${f.name}`, f]));
  const missingFunctions: FunctionInfo[] = [];

  for (const [key, funcInfo] of sourceFunctions) {
    if (!targetFunctions.has(key)) {
      missingFunctions.push(funcInfo);
    }
  }

  if (missingFunctions.length > 0) {
    sql += `-- Functions\n`;
    for (const funcInfo of missingFunctions) {
      sql += `${funcInfo.definition};\n\n`;
    }
  }

  return sql || `-- No functions to create\n\n`;
}

// Helper: Generate Sequences SQL
function generateSequencesSQL(
  diff: SchemaDiff,
  sourceMetadata: SchemaMetadata
): string {
  let sql = `-- ============================================================\n`;
  sql += `-- SEQUENCES\n`;
  sql += `-- Sequences needed by table columns\n`;
  sql += `-- ============================================================\n\n`;

  const schemaMap = sourceMetadata.tables;
  let hasSequences = false;

  // Sequences from tables that don't exist in target
  for (const tableRef of diff.tablesOnlyInSource) {
    const tableKey = `${tableRef.schema}.${tableRef.table}`;
    const tableInfo = schemaMap.get(tableKey);
    if (!tableInfo || tableInfo.sequences.length === 0) continue;

    hasSequences = true;
    sql += `-- Sequences for table: ${tableRef.schema}.${tableRef.table}\n`;
    for (const seq of tableInfo.sequences) {
      sql += `CREATE SEQUENCE IF NOT EXISTS "${seq.sequence_schema}"."${seq.sequence_name}"\n`;
      sql += `  AS ${seq.data_type}\n`;
      sql += `  INCREMENT BY ${seq.increment}\n`;
      sql += `  START WITH ${seq.start_value}\n`;
      sql += `  MINVALUE ${seq.min_value}\n`;
      sql += `  MAXVALUE ${seq.max_value}\n`;
      sql += `  ${seq.cycle ? 'CYCLE' : 'NO CYCLE'};\n\n`;
    }
  }

  return hasSequences ? sql : `-- No sequences to create\n\n`;
}

// Helper: Generate Tables SQL (columns only, no constraints/indexes/triggers)
function generateTablesSQL(
  diff: SchemaDiff,
  sourceMetadata: SchemaMetadata,
  sortByDependencies: boolean = true,
  handleCircularDeps: boolean = true,
  isSourceToTarget: boolean = true
): string {
  let sql = `-- ============================================================\n`;
  sql += `-- TABLES\n`;
  sql += `-- Table structures with columns only\n`;
  sql += `-- ============================================================\n\n`;

  const schemaMap = sourceMetadata.tables;
  let hasTables = false;

  // Determine table creation order
  let tablesToCreate = diff.tablesOnlyInSource;
  let circularDepSQL = '';

  if (sortByDependencies && tablesToCreate.length > 0) {
    // Build dependency graph
    const graph = buildDependencyGraph(tablesToCreate, sourceMetadata);

    // Topologically sort
    const { sorted, hasCycles, remaining } = topologicalSort(graph);

    if (hasCycles && handleCircularDeps) {
      // Find specific cycles
      const cycles = findStronglyConnectedComponents(graph);
      const circularTables = new Set(remaining);

      // Generate special handling for circular dependencies
      circularDepSQL = generateCircularDependencySQL(circularTables, sourceMetadata, cycles);

      // Remove circular tables from normal creation
      const sortedTables: Array<{ schema: string; table: string }> = [];
      for (const tableKey of sorted) {
        if (!circularTables.has(tableKey)) {
          const [schema, table] = tableKey.split('.');
          sortedTables.push({ schema, table });
        }
      }

      tablesToCreate = sortedTables;

      if (sorted.length > 0) {
        sql += `-- ℹ️  Tables ordered by foreign key dependencies\n`;
        sql += `-- Tables with no dependencies are created first\n`;
        sql += `-- (Circular dependency tables are handled separately at the end)\n\n`;
      }
    } else if (hasCycles && !handleCircularDeps) {
      // Just warn but create normally
      sql += `-- ⚠️  WARNING: Circular dependencies detected!\n`;
      sql += `-- The following tables have circular foreign key relationships:\n`;
      for (const tableKey of remaining) {
        sql += `--   - ${tableKey}\n`;
      }
      sql += `-- Consider using --handleCircularDeps to automatically handle these.\n\n`;

      // Convert all tables
      const sortedTables: Array<{ schema: string; table: string }> = [];
      const remainingTables: Array<{ schema: string; table: string }> = [];

      for (const tableKey of sorted) {
        const [schema, table] = tableKey.split('.');
        sortedTables.push({ schema, table });
      }

      for (const tableKey of remaining) {
        const [schema, table] = tableKey.split('.');
        remainingTables.push({ schema, table });
      }

      tablesToCreate = [...sortedTables, ...remainingTables];

      if (sorted.length > 0) {
        sql += `-- ℹ️  Tables ordered by foreign key dependencies\n`;
        sql += `-- Tables with no dependencies are created first\n\n`;
      }
    } else {
      // No cycles, proceed normally
      const sortedTables: Array<{ schema: string; table: string }> = [];
      for (const tableKey of sorted) {
        const [schema, table] = tableKey.split('.');
        sortedTables.push({ schema, table });
      }

      tablesToCreate = sortedTables;

      if (sorted.length > 0) {
        sql += `-- ℹ️  Tables ordered by foreign key dependencies\n`;
        sql += `-- Tables with no dependencies are created first\n\n`;
      }
    }
  }

  // Create tables in order
  for (const tableRef of tablesToCreate) {
    const tableKey = `${tableRef.schema}.${tableRef.table}`;
    const tableInfo = schemaMap.get(tableKey);
    if (!tableInfo) continue;

    hasTables = true;
    sql += `-- Table: ${tableRef.schema}.${tableRef.table}\n`;
    sql += `CREATE TABLE IF NOT EXISTS "${tableRef.schema}"."${tableRef.table}" (\n`;

    const columnDefs: string[] = [];
    for (const col of tableInfo.columns) {
      columnDefs.push(`  ${formatColumnDefinition(col)}`);
    }

    sql += columnDefs.join(',\n');
    sql += `\n);\n\n`;

    // Set sequence ownership
    if (tableInfo.sequences.length > 0) {
      for (const seq of tableInfo.sequences) {
        for (const col of tableInfo.columns) {
          if (col.column_default?.includes(seq.sequence_name)) {
            sql += `ALTER SEQUENCE "${seq.sequence_schema}"."${seq.sequence_name}" OWNED BY "${tableRef.schema}"."${tableRef.table}"."${col.column_name}";\n\n`;
            break;
          }
        }
      }
    }
  }

  // Add missing columns to existing tables
  // For source-to-target: add columns that exist in source but not in target
  // For target-to-source: add columns that exist in target but not in source
  for (const table of diff.tablesInBoth) {
    const columnsToAdd = isSourceToTarget ? table.columnsOnlyInSource : table.columnsOnlyInTarget;

    if (columnsToAdd.length > 0) {
      hasTables = true;
      sql += `-- Add columns to existing table: ${table.table_schema}.${table.table_name}\n`;
      for (const col of columnsToAdd) {
        sql += `ALTER TABLE "${table.table_schema}"."${table.table_name}" ADD COLUMN IF NOT EXISTS ${formatColumnDefinition(col)};\n`;
      }
      sql += `\n`;
    }
  }

  // Append circular dependency handling if any
  if (circularDepSQL) {
    sql += circularDepSQL;
    hasTables = true;
  }

  return hasTables ? sql : `-- No tables to create or modify\n\n`;
}

/**
 * Format index column/expression for SQL
 * Don't quote functional expressions (contain parens or type casts)
 * Quote regular column names
 */
function formatIndexColumn(col: string): string {
  // If it's a functional expression (contains parens or type cast), don't quote
  if (col.includes('(') || col.includes('::') || col.includes(' ')) {
    return col;
  }
  // Regular column name - quote it
  return `"${col}"`;
}

// Helper: Generate Indexes SQL
function generateIndexesSQL(
  diff: SchemaDiff,
  sourceMetadata: SchemaMetadata
): string {
  let sql = `-- ============================================================\n`;
  sql += `-- INDEXES\n`;
  sql += `-- Primary keys and indexes (requires tables to exist)\n`;
  sql += `-- ============================================================\n\n`;

  const schemaMap = sourceMetadata.tables;
  let hasIndexes = false;

  // Indexes from new tables
  for (const tableRef of diff.tablesOnlyInSource) {
    const tableKey = `${tableRef.schema}.${tableRef.table}`;
    const tableInfo = schemaMap.get(tableKey);
    if (!tableInfo || tableInfo.indexes.length === 0) continue;

    hasIndexes = true;
    sql += `-- Indexes for table: ${tableRef.schema}.${tableRef.table}\n`;
    for (const idx of tableInfo.indexes) {
      if (idx.is_primary) {
        sql += `ALTER TABLE "${tableRef.schema}"."${tableRef.table}" ADD PRIMARY KEY (${idx.columns.map(c => formatIndexColumn(c)).join(', ')});\n`;
      } else {
        const uniqueStr = idx.is_unique ? 'UNIQUE ' : '';
        sql += `CREATE ${uniqueStr}INDEX IF NOT EXISTS "${idx.index_name}" ON "${tableRef.schema}"."${tableRef.table}" USING ${idx.index_type} (${idx.columns.map(c => formatIndexColumn(c)).join(', ')});\n`;
      }
    }
    sql += `\n`;
  }

  // Indexes for existing tables
  for (const table of diff.tablesInBoth) {
    if (table.indexesOnlyInSource.length > 0) {
      hasIndexes = true;
      sql += `-- Add indexes to existing table: ${table.table_schema}.${table.table_name}\n`;
      for (const idx of table.indexesOnlyInSource) {
        if (idx.is_primary) {
          sql += `ALTER TABLE "${table.table_schema}"."${table.table_name}" ADD PRIMARY KEY (${idx.columns.map(c => formatIndexColumn(c)).join(', ')});\n`;
        } else {
          const uniqueStr = idx.is_unique ? 'UNIQUE ' : '';
          sql += `CREATE ${uniqueStr}INDEX IF NOT EXISTS "${idx.index_name}" ON "${table.table_schema}"."${table.table_name}" USING ${idx.index_type} (${idx.columns.map(c => formatIndexColumn(c)).join(', ')});\n`;
        }
      }
      sql += `\n`;
    }
  }

  return hasIndexes ? sql : `-- No indexes to create\n\n`;
}

// Helper: Generate Constraints and Foreign Keys SQL
function generateConstraintsForeignKeysSQL(
  diff: SchemaDiff,
  sourceMetadata: SchemaMetadata,
  isSourceToTarget: boolean = true
): string {
  let sql = `-- ============================================================\n`;
  sql += `-- CONSTRAINTS AND FOREIGN KEYS\n`;
  sql += `-- CHECK constraints and foreign keys (requires tables to exist)\n`;
  sql += `-- ============================================================\n\n`;

  const schemaMap = sourceMetadata.tables;
  let hasConstraints = false;

  // Constraints from new tables
  for (const tableRef of diff.tablesOnlyInSource) {
    const tableKey = `${tableRef.schema}.${tableRef.table}`;
    const tableInfo = schemaMap.get(tableKey);
    if (!tableInfo) continue;

    const hasFKs = tableInfo.foreignKeys.length > 0;
    const hasChecks = tableInfo.constraints.length > 0;

    if (!hasFKs && !hasChecks) continue;

    hasConstraints = true;
    sql += `-- Constraints for table: ${tableRef.schema}.${tableRef.table}\n`;

    // Foreign keys
    for (const fk of tableInfo.foreignKeys) {
      sql += `ALTER TABLE "${tableRef.schema}"."${tableRef.table}" ADD CONSTRAINT "${fk.constraint_name}" `;
      sql += `FOREIGN KEY ("${fk.column_name}") REFERENCES "${fk.foreign_table_schema}"."${fk.foreign_table_name}"("${fk.foreign_column_name}")`;
      sql += ` ON DELETE ${fk.on_delete} ON UPDATE ${fk.on_update};\n`;
    }

    // Constraints (CHECK and UNIQUE)
    // Note: UNIQUE constraints are often implemented as indexes, so we skip them here
    // to avoid duplication with the indexes created in generateIndexesSQL()
    for (const constraint of tableInfo.constraints) {
      if (constraint.constraint_type === 'CHECK' && constraint.check_clause) {
        const checkClause = constraint.check_clause.trim().startsWith('(')
          ? constraint.check_clause
          : `(${constraint.check_clause})`;
        sql += `ALTER TABLE "${tableRef.schema}"."${tableRef.table}" ADD CONSTRAINT "${constraint.constraint_name}" CHECK ${checkClause};\n`;
      } else if (constraint.constraint_type === 'UNIQUE' && constraint.columns && Array.isArray(constraint.columns) && constraint.columns.length > 0) {
        // Check if this UNIQUE constraint already exists as a UNIQUE INDEX
        const hasMatchingIndex = tableInfo.indexes.some(idx =>
          idx.is_unique &&
          idx.index_name === constraint.constraint_name
        );

        // Skip if already created as an index (indexes are preferred for unique constraints)
        if (!hasMatchingIndex) {
          const columnList = constraint.columns.map(c => `"${c}"`).join(', ');
          sql += `ALTER TABLE "${tableRef.schema}"."${tableRef.table}" ADD CONSTRAINT "${constraint.constraint_name}" UNIQUE (${columnList});\n`;
        }
      }
    }
    sql += `\n`;
  }

  // Constraints for existing tables
  for (const table of diff.tablesInBoth) {
    const fksToAdd = isSourceToTarget ? table.foreignKeysOnlyInSource : table.foreignKeysOnlyInTarget;
    const constraintsToAdd = isSourceToTarget ? table.constraintsOnlyInSource : table.constraintsOnlyInTarget;

    const hasFKs = fksToAdd.length > 0;
    const hasChecks = constraintsToAdd.length > 0;

    if (!hasFKs && !hasChecks) continue;

    hasConstraints = true;
    sql += `-- Add constraints to existing table: ${table.table_schema}.${table.table_name}\n`;

    // Foreign keys
    for (const fk of fksToAdd) {
      sql += `ALTER TABLE "${table.table_schema}"."${table.table_name}" ADD CONSTRAINT "${fk.constraint_name}" `;
      sql += `FOREIGN KEY ("${fk.column_name}") REFERENCES "${fk.foreign_table_schema}"."${fk.foreign_table_name}"("${fk.foreign_column_name}")`;
      sql += ` ON DELETE ${fk.on_delete} ON UPDATE ${fk.on_update};\n`;
    }

    // Constraints (CHECK and UNIQUE)
    for (const constraint of constraintsToAdd) {
      if (constraint.constraint_type === 'CHECK' && constraint.check_clause) {
        const checkClause = constraint.check_clause.trim().startsWith('(')
          ? constraint.check_clause
          : `(${constraint.check_clause})`;
        sql += `ALTER TABLE "${table.table_schema}"."${table.table_name}" ADD CONSTRAINT "${constraint.constraint_name}" CHECK ${checkClause};\n`;
      } else if (constraint.constraint_type === 'UNIQUE' && constraint.columns && Array.isArray(constraint.columns) && constraint.columns.length > 0) {
        // Check if this UNIQUE constraint already exists as a UNIQUE INDEX
        const tableKey = `${table.table_schema}.${table.table_name}`;
        const tableInfo = schemaMap.get(tableKey);
        const hasMatchingIndex = tableInfo?.indexes.some(idx =>
          idx.is_unique &&
          idx.index_name === constraint.constraint_name
        );

        // Skip if already created as an index (indexes are preferred for unique constraints)
        if (!hasMatchingIndex) {
          const columnList = constraint.columns.map(c => `"${c}"`).join(', ');
          sql += `ALTER TABLE "${table.table_schema}"."${table.table_name}" ADD CONSTRAINT "${constraint.constraint_name}" UNIQUE (${columnList});\n`;
        }
      }
    }
    sql += `\n`;
  }

  return hasConstraints ? sql : `-- No constraints or foreign keys to create\n\n`;
}

// Helper: Generate Triggers SQL
function generateTriggersSQL(
  diff: SchemaDiff,
  sourceMetadata: SchemaMetadata,
  targetMetadata: SchemaMetadata
): string {
  let sql = `-- ============================================================\n`;
  sql += `-- TRIGGERS\n`;
  sql += `-- Triggers (requires tables and functions to exist)\n`;
  sql += `-- ============================================================\n\n`;

  const schemaMap = sourceMetadata.tables;
  let hasTriggers = false;

  // Triggers from new tables
  for (const tableRef of diff.tablesOnlyInSource) {
    const tableKey = `${tableRef.schema}.${tableRef.table}`;
    const tableInfo = schemaMap.get(tableKey);
    if (!tableInfo || tableInfo.triggers.length === 0) continue;

    hasTriggers = true;
    sql += `-- Triggers for table: ${tableRef.schema}.${tableRef.table}\n`;
    for (const trigger of tableInfo.triggers) {
      sql += `CREATE TRIGGER "${trigger.trigger_name}"\n`;
      sql += `  ${trigger.action_timing} ${trigger.event_manipulation}\n`;
      sql += `  ON "${tableRef.schema}"."${tableRef.table}"\n`;
      sql += `  ${trigger.action_statement};\n\n`;
    }
  }

  // Triggers for existing tables
  for (const table of diff.tablesInBoth) {
    const tableKey = `${table.table_schema}.${table.table_name}`;
    const sourceTableInfo = sourceMetadata.tables.get(tableKey);
    const targetTableInfo = targetMetadata.tables.get(tableKey);

    if (!sourceTableInfo || !targetTableInfo) continue;

    const targetTriggers = new Set(targetTableInfo.triggers.map(t => t.trigger_name));
    const missingTriggers = sourceTableInfo.triggers.filter(t => !targetTriggers.has(t.trigger_name));

    if (missingTriggers.length === 0) continue;

    hasTriggers = true;
    sql += `-- Add triggers to existing table: ${table.table_schema}.${table.table_name}\n`;
    for (const trigger of missingTriggers) {
      sql += `CREATE TRIGGER "${trigger.trigger_name}"\n`;
      sql += `  ${trigger.action_timing} ${trigger.event_manipulation}\n`;
      sql += `  ON "${table.table_schema}"."${table.table_name}"\n`;
      sql += `  ${trigger.action_statement};\n\n`;
    }
  }

  return hasTriggers ? sql : `-- No triggers to create\n\n`;
}

// Helper: Generate RLS Policies SQL
function generatePoliciesSQL(
  diff: SchemaDiff,
  sourceMetadata: SchemaMetadata,
  targetMetadata: SchemaMetadata
): string {
  let sql = `-- ============================================================\n`;
  sql += `-- RLS POLICIES\n`;
  sql += `-- Row Level Security policies (requires tables to exist)\n`;
  sql += `-- ============================================================\n\n`;

  const schemaMap = sourceMetadata.tables;
  let hasPolicies = false;

  // Policies from new tables
  for (const tableRef of diff.tablesOnlyInSource) {
    const tableKey = `${tableRef.schema}.${tableRef.table}`;
    const tableInfo = schemaMap.get(tableKey);
    if (!tableInfo || tableInfo.policies.length === 0) continue;

    hasPolicies = true;
    sql += `-- RLS policies for table: ${tableRef.schema}.${tableRef.table}\n`;
    sql += `ALTER TABLE "${tableRef.schema}"."${tableRef.table}" ENABLE ROW LEVEL SECURITY;\n\n`;

    for (const policy of tableInfo.policies) {
      const roles = Array.isArray(policy.roles) && policy.roles.length > 0 ? policy.roles : ['public'];
      const rolesStr = roles.join(', ');

      sql += `CREATE POLICY "${policy.policy_name}"\n`;
      sql += `  ON "${tableRef.schema}"."${tableRef.table}"\n`;
      sql += `  AS ${policy.permissive}\n`;
      sql += `  FOR ${policy.cmd}\n`;
      sql += `  TO ${rolesStr}\n`;
      if (policy.qual) {
        sql += `  USING (${policy.qual})\n`;
      }
      if (policy.with_check) {
        sql += `  WITH CHECK (${policy.with_check})\n`;
      }
      sql += `;\n\n`;
    }
  }

  // Policies for existing tables
  for (const table of diff.tablesInBoth) {
    const tableKey = `${table.table_schema}.${table.table_name}`;
    const sourceTableInfo = sourceMetadata.tables.get(tableKey);
    const targetTableInfo = targetMetadata.tables.get(tableKey);

    if (!sourceTableInfo || !targetTableInfo) continue;

    const targetPolicies = new Set(targetTableInfo.policies.map(p => p.policy_name));
    const missingPolicies = sourceTableInfo.policies.filter(p => !targetPolicies.has(p.policy_name));

    if (missingPolicies.length === 0) continue;

    hasPolicies = true;
    sql += `-- Add RLS policies to existing table: ${table.table_schema}.${table.table_name}\n`;
    sql += `ALTER TABLE "${table.table_schema}"."${table.table_name}" ENABLE ROW LEVEL SECURITY;\n\n`;

    for (const policy of missingPolicies) {
      const roles = Array.isArray(policy.roles) && policy.roles.length > 0 ? policy.roles : ['public'];
      const rolesStr = roles.join(', ');

      sql += `CREATE POLICY "${policy.policy_name}"\n`;
      sql += `  ON "${table.table_schema}"."${table.table_name}"\n`;
      sql += `  AS ${policy.permissive}\n`;
      sql += `  FOR ${policy.cmd}\n`;
      sql += `  TO ${rolesStr}\n`;
      if (policy.qual) {
        sql += `  USING (${policy.qual})\n`;
      }
      if (policy.with_check) {
        sql += `  WITH CHECK (${policy.with_check})\n`;
      }
      sql += `;\n\n`;
    }
  }

  return hasPolicies ? sql : `-- No RLS policies to create\n\n`;
}

// Generate full database schema SQL (for cloning entire database)
function generateFullDatabaseSQL(
  metadata: SchemaMetadata,
  dbLabel: string,
  transactionScope: TransactionScope = 'none',
  sortByDependencies: boolean = true,
  handleCircularDeps: boolean = true
): SplitMigrationFiles {
  const header = `-- Full Schema Dump: ${dbLabel}\n-- Generated: ${new Date().toLocaleString()}\n-- This file contains the complete schema for recreating the database\n\n`;

  // For full dump, we need to create ALL tables, not just differences
  // So we construct a fake "diff" that includes everything
  const allTables: TableReference[] = Array.from(metadata.tables.values()).map(t => ({
    schema: t.table_schema,
    table: t.table_name
  }));

  const fullDiff: SchemaDiff = {
    tablesOnlyInSource: allTables,
    tablesOnlyInTarget: [],
    tablesInBoth: []
  };

  // Empty target metadata since we're dumping everything from source
  const emptyMetadata: SchemaMetadata = {
    tables: new Map(),
    enums: [],
    extensions: [],
    functions: []
  };

  const totalFiles = 8;

  // Generate SQL for each file
  const files: Record<string, string> = {
    '1-extensions-enums': header + generateExtensionsEnumsSQL(metadata, emptyMetadata),
    '2-sequences': header + generateSequencesSQL(fullDiff, metadata),
    '3-tables': header + generateTablesSQL(fullDiff, metadata, sortByDependencies, handleCircularDeps, true),
    '4-indexes': header + generateIndexesSQL(fullDiff, metadata),
    '5-constraints-foreign-keys': header + generateConstraintsForeignKeysSQL(fullDiff, metadata, true),
    '6-functions': header + generateFunctionsSQL(metadata, emptyMetadata),
    '7-triggers': header + generateTriggersSQL(fullDiff, metadata, emptyMetadata),
    '8-policies': header + generatePoliciesSQL(fullDiff, metadata, emptyMetadata),
  };

  // Apply transaction wrapping if enabled
  if (transactionScope !== 'none') {
    const labels = [
      'Extensions and ENUMs',
      'Sequences',
      'Tables',
      'Indexes',
      'Constraints and Foreign Keys',
      'Functions',
      'Triggers',
      'RLS Policies'
    ];

    let fileIndex = 0;
    for (const [key, sql] of Object.entries(files)) {
      fileIndex++;
      files[key] = wrapInTransaction(sql, labels[fileIndex - 1], transactionScope, fileIndex, totalFiles);
    }
  }

  return files as SplitMigrationFiles;
}

// Generate split migration SQL files (7 files per direction)
interface SplitMigrationFiles {
  '1-extensions-enums-functions': string;
  '2-sequences': string;
  '3-tables': string;
  '4-indexes': string;
  '5-constraints-foreign-keys': string;
  '6-triggers': string;
  '7-policies': string;
}

function generateSplitMigrationSQL(
  diff: SchemaDiff,
  sourceMetadata: SchemaMetadata,
  targetMetadata: SchemaMetadata,
  direction: "source-to-target" | "target-to-source",
  transactionScope: TransactionScope = 'none',
  sortByDependencies: boolean = true,
  handleCircularDeps: boolean = true
): SplitMigrationFiles {
  const isSourceToTarget = direction === "source-to-target";
  const sourceMetadataToUse = isSourceToTarget ? sourceMetadata : targetMetadata;
  const targetMetadataToUse = isSourceToTarget ? targetMetadata : sourceMetadata;

  const header = `-- Migration: ${direction}\n-- Generated: ${new Date().toLocaleString()}\n-- WARNING: Review carefully before executing!\n\n`;

  const totalFiles = 8;

  // Generate SQL for each file
  const files: Record<string, string> = {
    '1-extensions-enums': header + generateExtensionsEnumsSQL(sourceMetadataToUse, targetMetadataToUse),
    '2-sequences': header + generateSequencesSQL(diff, sourceMetadataToUse),
    '3-tables': header + generateTablesSQL(diff, sourceMetadataToUse, sortByDependencies, handleCircularDeps, isSourceToTarget),
    '4-indexes': header + generateIndexesSQL(diff, sourceMetadataToUse),
    '5-constraints-foreign-keys': header + generateConstraintsForeignKeysSQL(diff, sourceMetadataToUse, isSourceToTarget),
    '6-functions': header + generateFunctionsSQL(sourceMetadataToUse, targetMetadataToUse),
    '7-triggers': header + generateTriggersSQL(diff, sourceMetadataToUse, targetMetadataToUse),
    '8-policies': header + generatePoliciesSQL(diff, sourceMetadataToUse, targetMetadataToUse),
  };

  // Apply transaction wrapping if enabled
  if (transactionScope !== 'none') {
    const labels = [
      'Extensions and ENUMs',
      'Sequences',
      'Tables',
      'Indexes',
      'Constraints and Foreign Keys',
      'Functions',
      'Triggers',
      'RLS Policies'
    ];

    let fileIndex = 0;
    for (const [key, sql] of Object.entries(files)) {
      fileIndex++;
      files[key] = wrapInTransaction(sql, labels[fileIndex - 1], transactionScope, fileIndex, totalFiles);
    }
  }

  return files as SplitMigrationFiles;
}

// Generate migration README with instructions
function generateMigrationReadme(outputPrefix: string): string {
  const timestamp = new Date().toLocaleString();

  return `# Database Migration Guide

**Generated:** ${timestamp}

This directory contains database migration scripts organized into subdirectories by type. Each script is numbered to indicate the sequence in which they should be executed.

## Directory Structure

\`\`\`
.
├── diff-source-to-target/          # Migrations to sync target with source
│   ├── 1-extensions-enums.sql
│   ├── 2-sequences.sql
│   ├── 3-tables.sql
│   ├── 4-indexes.sql
│   ├── 5-constraints-foreign-keys.sql
│   ├── 6-functions.sql
│   ├── 7-triggers.sql
│   └── 8-policies.sql
├── diff-target-to-source/          # Migrations to sync source with target
│   └── (same structure as above)
├── full-source/                    # Complete source DB schema (if generated)
│   └── (same structure as above)
├── full-target/                    # Complete target DB schema (if generated)
│   └── (same structure as above)
└── ${outputPrefix}-MIGRATION-README.md
\`\`\`

## File Overview

### diff-source-to-target/
These scripts migrate changes FROM the source database TO the target database:

1. \`1-extensions-enums.sql\`
   - Creates PostgreSQL extensions (uuid-ossp, postgis, etc.)
   - Creates ENUM types
   - **Dependencies:** None

2. \`2-sequences.sql\`
   - Creates sequences for auto-incrementing columns
   - **Dependencies:** None (but logically before tables)

3. \`3-tables.sql\`
   - Creates table structures with columns
   - Adds missing columns to existing tables
   - Sets sequence ownership
   - **Dependencies:** Extensions, ENUMs, Sequences

4. \`4-indexes.sql\`
   - Creates primary keys
   - Creates indexes (unique and regular)
   - **Dependencies:** Tables

5. \`5-constraints-foreign-keys.sql\`
   - Creates CHECK constraints
   - Creates foreign key constraints
   - **Dependencies:** Tables, possibly other tables (for FKs)

6. \`6-functions.sql\`
   - Creates database functions
   - **Dependencies:** Tables (functions often reference tables)

7. \`7-triggers.sql\`
   - Creates triggers on tables
   - **Dependencies:** Tables, Functions (triggers call functions)

8. \`8-policies.sql\`
   - Enables Row Level Security (RLS)
   - Creates RLS policies
   - **Dependencies:** Tables, Functions (policies may use functions in USING clauses)

### diff-target-to-source/
These scripts migrate changes FROM the target database TO the source database (reverse direction):

- Same structure as above

### full-source/ and full-target/
If you used \`--generateFullMigrations\`, these directories contain complete schema dumps:

- \`full-source/\`: Complete schema dump of the source database
  - Use these to recreate the source database from scratch locally

- \`full-target/\`: Complete schema dump of the target database
  - Use these to recreate the target database from scratch locally

## How to Run Migrations

### Option 1: Run All At Once (Recommended for first-time sync)

\`\`\`bash
# For source → target
for file in diff-source-to-target/*.sql; do
  echo "Executing $file..."
  psql $TARGET_DB_URL -f "$file"
done

# For target → source
for file in diff-target-to-source/*.sql; do
  echo "Executing $file..."
  psql $SOURCE_DB_URL -f "$file"
done
\`\`\`

### Option 2: Run Individually (Recommended for troubleshooting)

Execute files in numbered order:

\`\`\`bash
# Example: Migrating source → target
cd diff-source-to-target
psql $TARGET_DB_URL -f 1-extensions-enums.sql
psql $TARGET_DB_URL -f 2-sequences.sql
psql $TARGET_DB_URL -f 3-tables.sql
psql $TARGET_DB_URL -f 4-indexes.sql
psql $TARGET_DB_URL -f 5-constraints-foreign-keys.sql
psql $TARGET_DB_URL -f 6-functions.sql
psql $TARGET_DB_URL -f 7-triggers.sql
psql $TARGET_DB_URL -f 8-policies.sql
\`\`\`

### Option 3: Selective Migration

You can run only specific categories if needed:

\`\`\`bash
# Example: Only sync missing tables and columns
psql $TARGET_DB_URL -f diff-source-to-target/3-tables.sql

# Example: Only sync indexes
psql $TARGET_DB_URL -f diff-source-to-target/4-indexes.sql
\`\`\`

### Option 4: Clone Database Locally from Full Schema Dump

If you generated full migrations with \`--generateFullMigrations\`:

\`\`\`bash
# Create a new local database
createdb my_local_db

# Run all source schema files in order
cd full-source
for file in *.sql; do
  psql my_local_db -f "$file"
done

# Or for target database
createdb my_local_target_db
cd ../full-target
for file in *.sql; do
  psql my_local_target_db -f "$file"
done
\`\`\`

## Important Notes

### Before Running Migrations

1. **Backup your database** before running any migrations
2. **Review each SQL file** to understand what changes will be made
3. **Test in a non-production environment** first
4. Ensure you have the correct database connection strings

### Dependencies

- Files MUST be executed in numbered order (1 → 7)
- Some files may be empty if there are no changes in that category
- Foreign key constraints (file 5) may fail if referenced tables don't exist

### Common Issues

**Foreign Key Failures:**
- If a foreign key references a table that doesn't exist in the target, the migration will fail
- You may need to create the referenced table first or temporarily disable the foreign key

**Duplicate Object Errors:**
- Extensions and ENUMs are wrapped in error-handling to skip if they already exist
- Other objects use \`IF NOT EXISTS\` where possible

**Permission Errors:**
- Ensure your database user has permission to:
  - Create extensions (requires superuser for some extensions)
  - Create types, functions, tables, indexes
  - Alter tables
  - Create triggers and policies

### Rollback

To rollback changes:
1. Restore from your backup (recommended)
2. Or manually run \`DROP\` statements for created objects in reverse order (7 → 1)

### Using with Supabase

For Supabase projects:
1. Use the SQL Editor in the Supabase Dashboard
2. Copy and paste the content of each file
3. Execute in numbered order
4. Or use the Supabase CLI: \`supabase db execute -f <filename>\`

## File Contents Summary

Each file contains:
- Header with migration direction and timestamp
- Section header explaining what's included
- SQL statements with comments
- Empty files will contain a comment indicating no changes

## Need Help?

- Review the main comparison report: \`${outputPrefix}.md\`
- Check the schema health score for severity of changes
- Consult PostgreSQL documentation for specific SQL syntax

---

**Generated by:** Database Schema Comparison Tool
**Date:** ${timestamp}
`;
}

// Generate SQL migration scripts (LEGACY - kept for backward compatibility)
function generateMigrationSQL(
  diff: SchemaDiff,
  sourceMetadata: SchemaMetadata,
  targetMetadata: SchemaMetadata,
  direction: "source-to-target" | "target-to-source"
): string {
  let sql = `-- Migration Script: ${direction}\n`;
  sql += `-- Generated: ${new Date().toLocaleString()}\n`;
  sql += `-- WARNING: Review carefully before executing!\n\n`;

  const isSourceToTarget = direction === "source-to-target";

  const sourceMetadataToUse = isSourceToTarget ? sourceMetadata : targetMetadata;
  const targetMetadataToUse = isSourceToTarget ? targetMetadata : sourceMetadata;

  // Create extensions first
  const sourceExtensions = new Set(sourceMetadataToUse.extensions);
  const targetExtensions = new Set(targetMetadataToUse.extensions);
  const missingExtensions = Array.from(sourceExtensions).filter(ext => !targetExtensions.has(ext));

  if (missingExtensions.length > 0) {
    sql += `-- ============================================================\n`;
    sql += `-- CREATE MISSING EXTENSIONS\n`;
    sql += `-- ============================================================\n\n`;

    for (const ext of missingExtensions) {
      sql += `CREATE EXTENSION IF NOT EXISTS "${ext}";\n`;
    }
    sql += `\n`;
  }

  // Create ENUM types next
  const sourceEnums = new Map(sourceMetadataToUse.enums.map(e => [`${e.schema}.${e.name}`, e]));
  const targetEnums = new Map(targetMetadataToUse.enums.map(e => [`${e.schema}.${e.name}`, e]));
  const missingEnums: EnumTypeInfo[] = [];

  for (const [key, enumInfo] of sourceEnums) {
    if (!targetEnums.has(key)) {
      missingEnums.push(enumInfo);
    }
  }

  if (missingEnums.length > 0) {
    sql += `-- ============================================================\n`;
    sql += `-- CREATE MISSING ENUM TYPES\n`;
    sql += `-- ============================================================\n\n`;

    for (const enumInfo of missingEnums) {
      // Skip if values array is empty or invalid
      if (!enumInfo.values || !Array.isArray(enumInfo.values) || enumInfo.values.length === 0) {
        sql += `-- WARNING: ENUM type ${enumInfo.schema}.${enumInfo.name} has no values, skipping\n\n`;
        continue;
      }

      sql += `-- Create ENUM type: ${enumInfo.schema}.${enumInfo.name}\n`;
      sql += `DO $$ BEGIN\n`;
      sql += `  CREATE TYPE "${enumInfo.schema}"."${enumInfo.name}" AS ENUM (\n`;
      sql += enumInfo.values.map(v => `    '${v.replace(/'/g, "''")}'`).join(',\n');
      sql += `\n  );\n`;
      sql += `EXCEPTION\n`;
      sql += `  WHEN duplicate_object THEN null;\n`;
      sql += `END $$;\n\n`;
    }
  }

  // Create functions next (needed by triggers)
  const sourceFunctions = new Map(sourceMetadataToUse.functions.map(f => [`${f.schema}.${f.name}`, f]));
  const targetFunctions = new Map(targetMetadataToUse.functions.map(f => [`${f.schema}.${f.name}`, f]));
  const missingFunctions: FunctionInfo[] = [];

  for (const [key, funcInfo] of sourceFunctions) {
    if (!targetFunctions.has(key)) {
      missingFunctions.push(funcInfo);
    }
  }

  if (missingFunctions.length > 0) {
    sql += `-- ============================================================\n`;
    sql += `-- CREATE MISSING FUNCTIONS\n`;
    sql += `-- ============================================================\n\n`;

    for (const funcInfo of missingFunctions) {
      sql += `-- Function: ${funcInfo.schema}.${funcInfo.name}\n`;
      sql += `${funcInfo.definition};\n\n`;
    }
  }

  // Tables to create
  const tablesToCreate = isSourceToTarget ? diff.tablesOnlyInSource : diff.tablesOnlyInTarget;
  const schemaMap = sourceMetadataToUse.tables;

  if (tablesToCreate.length > 0) {
    sql += `-- ============================================================\n`;
    sql += `-- CREATE MISSING TABLES\n`;
    sql += `-- ============================================================\n\n`;

    for (const tableRef of tablesToCreate) {
      const tableKey = `${tableRef.schema}.${tableRef.table}`;
      const tableInfo = schemaMap.get(tableKey);
      if (!tableInfo) continue;

      // Create sequences first if the table uses any
      if (tableInfo.sequences.length > 0) {
        sql += `-- Create sequences for table: ${tableRef.schema}.${tableRef.table}\n`;
        for (const seq of tableInfo.sequences) {
          sql += `CREATE SEQUENCE IF NOT EXISTS "${seq.sequence_schema}"."${seq.sequence_name}"\n`;
          sql += `  AS ${seq.data_type}\n`;
          sql += `  INCREMENT BY ${seq.increment}\n`;
          sql += `  START WITH ${seq.start_value}\n`;
          sql += `  MINVALUE ${seq.min_value}\n`;
          sql += `  MAXVALUE ${seq.max_value}\n`;
          sql += `  ${seq.cycle ? 'CYCLE' : 'NO CYCLE'};\n\n`;
        }
      }

      sql += `-- Create table: ${tableRef.schema}.${tableRef.table}\n`;
      sql += `CREATE TABLE IF NOT EXISTS "${tableRef.schema}"."${tableRef.table}" (\n`;

      const columnDefs: string[] = [];
      for (const col of tableInfo.columns) {
        columnDefs.push(`  ${formatColumnDefinition(col)}`);
      }

      sql += columnDefs.join(',\n');
      sql += `\n);\n\n`;

      // Set sequence ownership for auto-owned sequences
      if (tableInfo.sequences.length > 0) {
        for (const seq of tableInfo.sequences) {
          // Find which column uses this sequence
          for (const col of tableInfo.columns) {
            if (col.column_default?.includes(seq.sequence_name)) {
              sql += `ALTER SEQUENCE "${seq.sequence_schema}"."${seq.sequence_name}" OWNED BY "${tableRef.schema}"."${tableRef.table}"."${col.column_name}";\n\n`;
              break;
            }
          }
        }
      }

      // Add indexes
      for (const idx of tableInfo.indexes) {
        if (idx.is_primary) {
          sql += `ALTER TABLE "${tableRef.schema}"."${tableRef.table}" ADD PRIMARY KEY (${idx.columns.map(c => `"${c}"`).join(', ')});\n\n`;
        } else {
          const uniqueStr = idx.is_unique ? 'UNIQUE ' : '';
          sql += `CREATE ${uniqueStr}INDEX IF NOT EXISTS "${idx.index_name}" ON "${tableRef.schema}"."${tableRef.table}" USING ${idx.index_type} (${idx.columns.map(c => `"${c}"`).join(', ')});\n\n`;
        }
      }

      // Add foreign keys
      for (const fk of tableInfo.foreignKeys) {
        sql += `ALTER TABLE "${tableRef.schema}"."${tableRef.table}" ADD CONSTRAINT "${fk.constraint_name}" `;
        sql += `FOREIGN KEY ("${fk.column_name}") REFERENCES "${fk.foreign_table_schema}"."${fk.foreign_table_name}"("${fk.foreign_column_name}")`;
        sql += ` ON DELETE ${fk.on_delete} ON UPDATE ${fk.on_update};\n\n`;
      }

      // Add constraints
      for (const constraint of tableInfo.constraints) {
        if (constraint.constraint_type === 'CHECK' && constraint.check_clause) {
          // Ensure check_clause has proper parentheses
          const checkClause = constraint.check_clause.trim().startsWith('(')
            ? constraint.check_clause
            : `(${constraint.check_clause})`;
          sql += `ALTER TABLE "${tableRef.schema}"."${tableRef.table}" ADD CONSTRAINT "${constraint.constraint_name}" CHECK ${checkClause};\n\n`;
        }
      }

      // Add triggers
      for (const trigger of tableInfo.triggers) {
        sql += `-- Trigger: ${trigger.trigger_name}\n`;
        sql += `CREATE TRIGGER "${trigger.trigger_name}"\n`;
        sql += `  ${trigger.action_timing} ${trigger.event_manipulation}\n`;
        sql += `  ON "${tableRef.schema}"."${tableRef.table}"\n`;
        sql += `  ${trigger.action_statement};\n\n`;
      }

      // Add RLS policies
      if (tableInfo.policies.length > 0) {
        sql += `-- Enable RLS\n`;
        sql += `ALTER TABLE "${tableRef.schema}"."${tableRef.table}" ENABLE ROW LEVEL SECURITY;\n\n`;

        for (const policy of tableInfo.policies) {
          const roles = Array.isArray(policy.roles) && policy.roles.length > 0 ? policy.roles : ['public'];
          const rolesStr = roles.join(', ');

          sql += `-- Policy: ${policy.policy_name}\n`;
          sql += `CREATE POLICY "${policy.policy_name}"\n`;
          sql += `  ON "${tableRef.schema}"."${tableRef.table}"\n`;
          sql += `  AS ${policy.permissive}\n`;
          sql += `  FOR ${policy.cmd}\n`;
          sql += `  TO ${rolesStr}\n`;
          if (policy.qual) {
            sql += `  USING (${policy.qual})\n`;
          }
          if (policy.with_check) {
            sql += `  WITH CHECK (${policy.with_check})\n`;
          }
          sql += `;\n\n`;
        }
      }
    }
  }

  // Column and constraint modifications for existing tables
  if (diff.tablesInBoth.length > 0) {
    sql += `-- ============================================================\n`;
    sql += `-- MODIFY EXISTING TABLES\n`;
    sql += `-- ============================================================\n\n`;

    for (const table of diff.tablesInBoth) {
      // Get the full table info to access triggers and policies
      const tableKey = `${table.table_schema}.${table.table_name}`;
      const sourceTableInfo = sourceMetadataToUse.tables.get(tableKey);
      const targetTableInfo = targetMetadataToUse.tables.get(tableKey);

      const hasColumnChanges =
        (isSourceToTarget && table.columnsOnlyInSource.length > 0) ||
        (!isSourceToTarget && table.columnsOnlyInTarget.length > 0);

      const hasIndexChanges =
        (isSourceToTarget && table.indexesOnlyInSource.length > 0) ||
        (!isSourceToTarget && table.indexesOnlyInTarget.length > 0);

      const hasFKChanges =
        (isSourceToTarget && table.foreignKeysOnlyInSource.length > 0) ||
        (!isSourceToTarget && table.foreignKeysOnlyInTarget.length > 0);

      const hasConstraintChanges =
        (isSourceToTarget && table.constraintsOnlyInSource.length > 0) ||
        (!isSourceToTarget && table.constraintsOnlyInTarget.length > 0);

      // Check for trigger differences
      const sourceTriggers = new Set(sourceTableInfo?.triggers.map(t => t.trigger_name) || []);
      const targetTriggers = new Set(targetTableInfo?.triggers.map(t => t.trigger_name) || []);
      const missingTriggers = sourceTableInfo?.triggers.filter(t => !targetTriggers.has(t.trigger_name)) || [];
      const hasTriggerChanges = missingTriggers.length > 0;

      // Check for policy differences
      const sourcePolicies = new Set(sourceTableInfo?.policies.map(p => p.policy_name) || []);
      const targetPolicies = new Set(targetTableInfo?.policies.map(p => p.policy_name) || []);
      const missingPolicies = sourceTableInfo?.policies.filter(p => !targetPolicies.has(p.policy_name)) || [];
      const hasPolicyChanges = missingPolicies.length > 0;

      if (!hasColumnChanges && !hasIndexChanges && !hasFKChanges && !hasConstraintChanges && !hasTriggerChanges && !hasPolicyChanges) {
        continue;
      }

      sql += `-- Table: ${table.table_schema}.${table.table_name}\n`;

      // Add missing columns
      const columnsToAdd = isSourceToTarget ? table.columnsOnlyInSource : table.columnsOnlyInTarget;
      if (columnsToAdd.length > 0) {
        sql += `\n-- Add missing columns\n`;
        for (const col of columnsToAdd) {
          sql += `ALTER TABLE "${table.table_schema}"."${table.table_name}" ADD COLUMN IF NOT EXISTS ${formatColumnDefinition(col)};\n`;
        }
      }

      // Add missing indexes
      const indexesToAdd = isSourceToTarget ? table.indexesOnlyInSource : table.indexesOnlyInTarget;
      if (indexesToAdd.length > 0) {
        sql += `\n-- Add missing indexes\n`;
        for (const idx of indexesToAdd) {
          if (idx.is_primary) {
            sql += `ALTER TABLE "${table.table_schema}"."${table.table_name}" ADD PRIMARY KEY (${idx.columns.map(c => `"${c}"`).join(', ')});\n`;
          } else {
            const uniqueStr = idx.is_unique ? 'UNIQUE ' : '';
            sql += `CREATE ${uniqueStr}INDEX IF NOT EXISTS "${idx.index_name}" ON "${table.table_schema}"."${table.table_name}" USING ${idx.index_type} (${idx.columns.map(c => `"${c}"`).join(', ')});\n`;
          }
        }
      }

      // Add missing foreign keys
      const fksToAdd = isSourceToTarget ? table.foreignKeysOnlyInSource : table.foreignKeysOnlyInTarget;
      if (fksToAdd.length > 0) {
        sql += `\n-- Add missing foreign keys\n`;
        for (const fk of fksToAdd) {
          sql += `ALTER TABLE "${table.table_schema}"."${table.table_name}" ADD CONSTRAINT "${fk.constraint_name}" `;
          sql += `FOREIGN KEY ("${fk.column_name}") REFERENCES "${fk.foreign_table_schema}"."${fk.foreign_table_name}"("${fk.foreign_column_name}")`;
          sql += ` ON DELETE ${fk.on_delete} ON UPDATE ${fk.on_update};\n`;
        }
      }

      // Add missing constraints
      const constraintsToAdd = isSourceToTarget ? table.constraintsOnlyInSource : table.constraintsOnlyInTarget;
      if (constraintsToAdd.length > 0) {
        sql += `\n-- Add missing constraints\n`;
        for (const constraint of constraintsToAdd) {
          if (constraint.constraint_type === 'CHECK' && constraint.check_clause) {
            // Ensure check_clause has proper parentheses
            const checkClause = constraint.check_clause.trim().startsWith('(')
              ? constraint.check_clause
              : `(${constraint.check_clause})`;
            sql += `ALTER TABLE "${table.table_schema}"."${table.table_name}" ADD CONSTRAINT "${constraint.constraint_name}" CHECK ${checkClause};\n`;
          }
        }
      }

      // Add missing triggers
      if (hasTriggerChanges && missingTriggers.length > 0) {
        sql += `\n-- Add missing triggers\n`;
        for (const trigger of missingTriggers) {
          sql += `CREATE TRIGGER "${trigger.trigger_name}"\n`;
          sql += `  ${trigger.action_timing} ${trigger.event_manipulation}\n`;
          sql += `  ON "${table.table_schema}"."${table.table_name}"\n`;
          sql += `  ${trigger.action_statement};\n`;
        }
      }

      // Add missing RLS policies
      if (hasPolicyChanges && missingPolicies.length > 0) {
        sql += `\n-- Add missing RLS policies\n`;
        // Enable RLS if there are policies to add
        sql += `ALTER TABLE "${table.table_schema}"."${table.table_name}" ENABLE ROW LEVEL SECURITY;\n\n`;

        for (const policy of missingPolicies) {
          const roles = Array.isArray(policy.roles) && policy.roles.length > 0 ? policy.roles : ['public'];
          const rolesStr = roles.join(', ');

          sql += `CREATE POLICY "${policy.policy_name}"\n`;
          sql += `  ON "${table.table_schema}"."${table.table_name}"\n`;
          sql += `  AS ${policy.permissive}\n`;
          sql += `  FOR ${policy.cmd}\n`;
          sql += `  TO ${rolesStr}\n`;
          if (policy.qual) {
            sql += `  USING (${policy.qual})\n`;
          }
          if (policy.with_check) {
            sql += `  WITH CHECK (${policy.with_check})\n`;
          }
          sql += `;\n`;
        }
      }

      sql += `\n`;
    }
  }

  sql += `-- Migration script complete.\n`;
  return sql;
}

// Calculate health metrics
function calculateHealthMetrics(diff: SchemaDiff): HealthMetrics {
  const issues: string[] = [];
  let score = 100;

  const missingTableCount =
    diff.tablesOnlyInSource.length + diff.tablesOnlyInTarget.length;
  const tablesWithDiffs = diff.tablesInBoth.length;

  // Deduct points for missing tables (more severe)
  score -= missingTableCount * 10;
  if (missingTableCount > 0) {
    issues.push(`${missingTableCount} table(s) exist in only one database`);
  }

  // Count critical column differences
  let criticalDiffs = 0;
  let nonCriticalDiffs = 0;
  let missingColumns = 0;

  for (const table of diff.tablesInBoth) {
    missingColumns +=
      table.columnsOnlyInSource.length + table.columnsOnlyInTarget.length;

    for (const colDiff of table.columnsWithDifferences) {
      if (colDiff.isCritical) {
        criticalDiffs++;
      } else {
        nonCriticalDiffs++;
      }
    }
  }

  // Deduct points for column differences
  score -= criticalDiffs * 8;
  score -= nonCriticalDiffs * 3;
  score -= missingColumns * 5;

  if (criticalDiffs > 0) {
    issues.push(
      `${criticalDiffs} critical column difference(s) detected (type changes, nullability changes)`
    );
  }

  if (missingColumns > 0) {
    issues.push(`${missingColumns} column(s) missing in one database`);
  }

  if (nonCriticalDiffs > 0) {
    issues.push(
      `${nonCriticalDiffs} non-critical column difference(s) (defaults, lengths, etc.)`
    );
  }

  // Ensure score doesn't go below 0
  score = Math.max(0, score);

  // Determine severity
  let severity: "healthy" | "minor" | "moderate" | "critical";
  if (score >= 90) {
    severity = "healthy";
  } else if (score >= 70) {
    severity = "minor";
  } else if (score >= 40) {
    severity = "moderate";
  } else {
    severity = "critical";
  }

  return { score, issues, severity };
}

/**
 * Generate rollback/cleanup SQL to reverse a migration
 * Creates scripts numbered in reverse (7→1) to undo changes in proper order
 */
function generateRollbackSQL(
  diff: SchemaDiff,
  sourceMetadata: SchemaMetadata,
  targetMetadata: SchemaMetadata,
  direction: "source-to-target" | "target-to-source",
  dryRun: boolean = true
): SplitMigrationFiles {
  const isSourceToTarget = direction === "source-to-target";
  const metadataToRollback = isSourceToTarget ? sourceMetadata : targetMetadata;

  const header = `-- ============================================================
-- ROLLBACK/CLEANUP SQL: ${direction}
-- Generated: ${new Date().toLocaleString()}
-- ============================================================
--
-- ⚠️  WARNING: DESTRUCTIVE OPERATIONS
-- This script will REMOVE schema elements that were added by the migration.
-- ${dryRun ? 'Currently in DRY-RUN mode - statements are commented out.' : 'DRY-RUN DISABLED - Statements will execute!'}
--
-- Data Loss Risk:
--   - Dropping tables will DELETE ALL DATA in those tables
--   - Dropping columns will DELETE ALL DATA in those columns
--   - These operations are IRREVERSIBLE
--
-- Before running:
--   1. BACKUP your database
--   2. Review each statement carefully
--   3. Consider running in a transaction (BEGIN; ... ROLLBACK;)
--   4. Verify row counts before dropping tables
--
-- To enable actual execution, run with: --cleanupDryRun=false
--
-- Execute files in THIS ORDER (reverse of migration):
--   8-policies.sql → 7-triggers.sql → 6-functions.sql → 5-constraints-foreign-keys.sql
--   → 4-indexes.sql → 3-tables.sql → 2-sequences.sql → 1-extensions-enums.sql
--
-- ============================================================\n\n`;

  const commentPrefix = dryRun ? '-- [DRY-RUN] ' : '';

  // Generate rollback SQL for each category (in reverse order of creation)

  // 7. Policies (disable RLS and drop policies)
  let policiesSQL = '';
  for (const tableDiff of diff.tablesInBoth) {
    const tableKey = `${tableDiff.table_schema}.${tableDiff.table_name}`;
    const tableInfo = metadataToRollback.tables.get(tableKey);

    if (tableInfo && tableInfo.policies.length > 0) {
      policiesSQL += `-- Rollback policies for: ${tableKey}\n`;

      for (const policy of tableInfo.policies) {
        policiesSQL += `${commentPrefix}DROP POLICY IF EXISTS "${policy.policy_name}" ON "${tableDiff.table_schema}"."${tableDiff.table_name}";\n`;
      }

      policiesSQL += `${commentPrefix}ALTER TABLE "${tableDiff.table_schema}"."${tableDiff.table_name}" DISABLE ROW LEVEL SECURITY;\n\n`;
    }
  }

  // 6. Triggers
  let triggersSQL = '';
  for (const tableDiff of diff.tablesInBoth) {
    const tableKey = `${tableDiff.table_schema}.${tableDiff.table_name}`;
    const tableInfo = metadataToRollback.tables.get(tableKey);

    if (tableInfo && tableInfo.triggers.length > 0) {
      triggersSQL += `-- Rollback triggers for: ${tableKey}\n`;

      for (const trigger of tableInfo.triggers) {
        triggersSQL += `${commentPrefix}DROP TRIGGER IF EXISTS "${trigger.trigger_name}" ON "${tableDiff.table_schema}"."${tableDiff.table_name}";\n`;
      }
      triggersSQL += '\n';
    }
  }

  // 5. Constraints and Foreign Keys
  let constraintsSQL = '';
  for (const tableDiff of diff.tablesInBoth) {
    const tableKey = `${tableDiff.table_schema}.${tableDiff.table_name}`;
    const tableInfo = metadataToRollback.tables.get(tableKey);

    if (tableInfo) {
      let hasConstraints = false;

      if (tableInfo.foreignKeys.length > 0) {
        if (!hasConstraints) {
          constraintsSQL += `-- Rollback constraints for: ${tableKey}\n`;
          hasConstraints = true;
        }

        for (const fk of tableInfo.foreignKeys) {
          constraintsSQL += `${commentPrefix}ALTER TABLE "${tableDiff.table_schema}"."${tableDiff.table_name}" DROP CONSTRAINT IF EXISTS "${fk.constraint_name}";\n`;
        }
      }

      if (tableInfo.constraints.length > 0) {
        if (!hasConstraints) {
          constraintsSQL += `-- Rollback constraints for: ${tableKey}\n`;
          hasConstraints = true;
        }

        for (const constraint of tableInfo.constraints) {
          if (constraint.constraint_type !== 'PRIMARY KEY') {
            constraintsSQL += `${commentPrefix}ALTER TABLE "${tableDiff.table_schema}"."${tableDiff.table_name}" DROP CONSTRAINT IF EXISTS "${constraint.constraint_name}";\n`;
          }
        }
      }

      if (hasConstraints) {
        constraintsSQL += '\n';
      }
    }
  }

  // 4. Indexes
  let indexesSQL = '';
  for (const tableDiff of diff.tablesInBoth) {
    const tableKey = `${tableDiff.table_schema}.${tableDiff.table_name}`;
    const tableInfo = metadataToRollback.tables.get(tableKey);

    if (tableInfo && tableInfo.indexes.length > 0) {
      indexesSQL += `-- Rollback indexes for: ${tableKey}\n`;

      for (const index of tableInfo.indexes) {
        if (!index.is_primary) {
          indexesSQL += `${commentPrefix}DROP INDEX IF EXISTS "${tableDiff.table_schema}"."${index.index_name}";\n`;
        }
      }
      indexesSQL += '\n';
    }
  }

  // 3. Tables (most dangerous - includes row count check)
  let tablesSQL = '';
  const tablesToDrop = isSourceToTarget ? diff.tablesOnlyInSource : diff.tablesOnlyInTarget;

  if (tablesToDrop.length > 0) {
    tablesSQL += `-- ============================================================\n`;
    tablesSQL += `-- DROP TABLES\n`;
    tablesSQL += `-- ⚠️  CRITICAL: These operations will DELETE ALL DATA\n`;
    tablesSQL += `-- ============================================================\n\n`;

    for (const table of tablesToDrop) {
      const tableKey = `${table.schema}.${table.table}`;

      tablesSQL += `-- Table: ${tableKey}\n`;
      tablesSQL += `-- Check row count before dropping:\n`;
      tablesSQL += `-- SELECT COUNT(*) FROM "${table.schema}"."${table.table}";\n`;
      tablesSQL += `${commentPrefix}DROP TABLE IF EXISTS "${table.schema}"."${table.table}" CASCADE;\n\n`;
    }
  }

  // Also drop columns that were added
  for (const tableDiff of diff.tablesInBoth) {
    if (tableDiff.columnsOnlyInSource.length > 0) {
      tablesSQL += `-- Drop columns added to: ${tableDiff.table_schema}.${tableDiff.table_name}\n`;

      for (const col of tableDiff.columnsOnlyInSource) {
        tablesSQL += `-- ⚠️  Dropping column will delete all data in that column\n`;
        tablesSQL += `${commentPrefix}ALTER TABLE "${tableDiff.table_schema}"."${tableDiff.table_name}" DROP COLUMN IF EXISTS "${col.column_name}" CASCADE;\n`;
      }
      tablesSQL += '\n';
    }
  }

  // 2. Sequences
  let sequencesSQL = '';
  for (const tableDiff of diff.tablesInBoth) {
    const tableKey = `${tableDiff.table_schema}.${tableDiff.table_name}`;
    const tableInfo = metadataToRollback.tables.get(tableKey);

    if (tableInfo && tableInfo.sequences.length > 0) {
      sequencesSQL += `-- Rollback sequences for: ${tableKey}\n`;

      for (const seq of tableInfo.sequences) {
        sequencesSQL += `${commentPrefix}DROP SEQUENCE IF EXISTS "${seq.sequence_schema}"."${seq.sequence_name}" CASCADE;\n`;
      }
      sequencesSQL += '\n';
    }
  }

  // Determine which metadata to check against (opposite of rollback metadata)
  const comparisonMetadata = isSourceToTarget ? targetMetadata : sourceMetadata;

  // 6. Functions (drop functions that reference tables, must be dropped after triggers/policies)
  let functionsSQL = '';

  // Drop functions
  for (const func of metadataToRollback.functions) {
    const existsInComparison = comparisonMetadata?.functions.some(
      f => f.schema === func.schema && f.name === func.name
    );

    if (!existsInComparison) {
      functionsSQL += `${commentPrefix}DROP FUNCTION IF EXISTS "${func.schema}"."${func.name}"(${func.argument_types}) CASCADE;\n`;
    }
  }

  if (metadataToRollback.functions.length > 0) {
    functionsSQL += '\n';
  }

  // 1. Extensions and ENUMs
  let extensionsSQL = '';

  // Drop ENUMs
  for (const enumType of metadataToRollback.enums) {
    const existsInComparison = comparisonMetadata?.enums.some(
      e => e.schema === enumType.schema && e.name === enumType.name
    );

    if (!existsInComparison) {
      extensionsSQL += `${commentPrefix}DROP TYPE IF EXISTS "${enumType.schema}"."${enumType.name}" CASCADE;\n`;
    }
  }

  if (metadataToRollback.enums.length > 0) {
    extensionsSQL += '\n';
  }

  // Note about extensions (usually shouldn't drop)
  if (metadataToRollback.extensions.length > 0) {
    extensionsSQL += `-- ℹ️  Extensions are typically NOT dropped in rollback\n`;
    extensionsSQL += `-- They may be used by other databases or schemas\n`;
    extensionsSQL += `-- Uncomment only if you're certain:\n`;

    for (const ext of metadataToRollback.extensions) {
      extensionsSQL += `-- ${commentPrefix}DROP EXTENSION IF EXISTS "${ext.name}" CASCADE;\n`;
    }
    extensionsSQL += '\n';
  }

  // Build files matching migration order (same numbers, but DROP instead of CREATE)
  const files = {
    '8-policies': header + (policiesSQL || '-- No policies to rollback\n'),
    '7-triggers': header + (triggersSQL || '-- No triggers to rollback\n'),
    '6-functions': header + (functionsSQL || '-- No functions to rollback\n'),
    '5-constraints-foreign-keys': header + (constraintsSQL || '-- No constraints to rollback\n'),
    '4-indexes': header + (indexesSQL || '-- No indexes to rollback\n'),
    '3-tables': header + (tablesSQL || '-- No tables or columns to rollback\n'),
    '2-sequences': header + (sequencesSQL || '-- No sequences to rollback\n'),
    '1-extensions-enums': header + (extensionsSQL || '-- No extensions/enums to rollback\n'),
  };

  return files as SplitMigrationFiles;
}

// Write Markdown output


export {
  generateSequencesSQL,
  generateTablesSQL,
  generateIndexesSQL,
  generateConstraintsForeignKeysSQL,
  generateTriggersSQL,
  generatePoliciesSQL,
  generateExtensionsEnumsFunctionsSQL,
  generateFullDatabaseSQL,
  generateSplitMigrationSQL,
  generateMigrationReadme,
  generateRollbackSQL
};
