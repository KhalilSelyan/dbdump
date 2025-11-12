import { Client } from 'pg';
import type { SchemaMetadata, TableInfo, EnumInfo, ExtensionInfo, FunctionInfo } from './types';
import { parsePostgresArray } from './utils';

// Helper function for exponential backoff retry logic
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Retry wrapper for database operations
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = 3
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      // Don't retry on authentication errors or syntax errors
      const noRetryErrors = ['28P01', '42601', '42501', '3D000'];
      if (noRetryErrors.includes(error.code)) {
        throw enhanceError(error);
      }

      if (attempt < maxRetries) {
        const backoffMs = 1000 * attempt; // 1s, 2s, 3s
        console.error(`\n  ⚠️  ${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${backoffMs}ms...`);
        console.error(`  Error: ${error.message}`);
        await sleep(backoffMs);
      }
    }
  }

  throw enhanceError(lastError);
}

// Enhance error messages for better debugging
function enhanceError(error: any): Error {
  if (!error.code) return error;

  const errorMessages: Record<string, string> = {
    'ECONNREFUSED': 'Database connection refused. Is PostgreSQL running? Check host and port.',
    'ENOTFOUND': 'Database host not found. Check the hostname in your connection string.',
    'ETIMEDOUT': 'Database connection timed out. Check network connectivity and firewall settings.',
    '28P01': 'Authentication failed. Check username and password.',
    '3D000': 'Database does not exist. Check the database name in your connection string.',
    '42501': 'Permission denied. Check user privileges for accessing schema information.',
    '08006': 'Connection failure. Database might be shutting down or network issue occurred.',
    '57P03': 'Database is starting up. Please wait and try again.',
  };

  const enhancedMessage = errorMessages[error.code];
  if (enhancedMessage) {
    error.message = `${enhancedMessage}\n  Original error: ${error.message}`;
  }

  return error;
}

async function fetchSchemas(connectionUrl: string): Promise<string[]> {
  return withRetry(async () => {
    const client = new Client({ connectionString: connectionUrl });

    try {
      await client.connect();

      const query = `
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1')
          AND schema_name NOT LIKE 'pg_temp_%'
          AND schema_name NOT LIKE 'pg_toast_temp_%'
        ORDER BY schema_name;
      `;

      const result = await client.query(query);
      return result.rows.map((row) => row.schema_name);
    } finally {
      await client.end();
    }
  }, 'Fetch schemas');
}

// Fetch schema information from database (all schemas)
async function fetchAllSchemas(
  connectionUrl: string,
  schemas: string[],
  excludeTables: string[],
  dbLabel: string
): Promise<SchemaMetadata> {
  const client = new Client({ connectionString: connectionUrl });

  try {
    process.stdout.write(`  Connecting to ${dbLabel}...`);
    await withRetry(async () => {
      await client.connect();
    }, `Connect to ${dbLabel}`);
    console.log(" ✓");

    // Query to get all tables and their columns across all schemas
    const query = `
      SELECT
        c.table_schema,
        c.table_name,
        c.column_name,
        CASE
          WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name
          ELSE c.data_type
        END as data_type,
        c.is_nullable,
        c.column_default,
        c.character_maximum_length,
        c.numeric_precision,
        c.numeric_scale
      FROM information_schema.columns c
      INNER JOIN information_schema.tables t
        ON c.table_name = t.table_name
        AND c.table_schema = t.table_schema
      WHERE c.table_schema = ANY($1)
        AND t.table_type = 'BASE TABLE'
        ${
          excludeTables.length > 0
            ? `AND c.table_name NOT IN (${excludeTables
                .map((_, i) => `$${i + 2}`)
                .join(", ")})`
            : ""
        }
      ORDER BY c.table_schema, c.table_name, c.ordinal_position;
    `;

    const params = [schemas, ...excludeTables];
    process.stdout.write(`  Querying schema information...`);
    const result = await client.query(query, params);
    console.log(" ✓");

    // Organize results by table
    process.stdout.write(
      `  Processing ${result.rows.length} column definitions...`
    );
    const tables = new Map<string, TableInfo>();

    for (const row of result.rows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;

      if (!tables.has(tableKey)) {
        tables.set(tableKey, {
          table_name: row.table_name,
          table_schema: row.table_schema,
          columns: [],
          indexes: [],
          foreignKeys: [],
          constraints: [],
          sequences: [],
          triggers: [],
          policies: [],
        });
      }

      tables.get(tableKey)!.columns.push({
        column_name: row.column_name,
        data_type: row.data_type,
        is_nullable: row.is_nullable,
        column_default: row.column_default,
        character_maximum_length: row.character_maximum_length,
        numeric_precision: row.numeric_precision,
        numeric_scale: row.numeric_scale,
      });
    }
    console.log(" ✓");

    // Fetch indexes
    process.stdout.write(`  Fetching indexes...`);
    const indexQuery = `
      SELECT
        schemaname as table_schema,
        tablename as table_name,
        indexname as index_name,
        indexdef
      FROM pg_indexes
      WHERE schemaname = ANY($1)
        ${excludeTables.length > 0 ? `AND tablename NOT IN (${excludeTables.map((_, i) => `$${i + 2}`).join(", ")})` : ""}
      ORDER BY schemaname, tablename, indexname;
    `;

    const indexResult = await client.query(indexQuery, params);

    for (const row of indexResult.rows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      const table = tables.get(tableKey);
      if (!table) continue;

      // Parse index definition to determine type and columns
      const isPrimary = row.indexdef.includes("PRIMARY KEY");
      const isUnique = row.indexdef.includes("UNIQUE") || isPrimary;

      // Extract columns from index definition
      const columnsMatch = row.indexdef.match(/\(([^)]+)\)/);
      const columns = columnsMatch ? columnsMatch[1].split(',').map((c: string) => c.trim()) : [];

      // Determine index type (btree, hash, gin, gist, etc.)
      const typeMatch = row.indexdef.match(/USING (\w+)/);
      const indexType = typeMatch ? typeMatch[1] : 'btree';

      table.indexes.push({
        index_name: row.index_name,
        is_unique: isUnique,
        is_primary: isPrimary,
        columns,
        index_type: indexType,
      });
    }
    console.log(" ✓");

    // Fetch foreign keys
    process.stdout.write(`  Fetching foreign keys...`);
    const fkQuery = `
      SELECT
        tc.table_schema,
        tc.table_name,
        tc.constraint_name,
        kcu.column_name,
        ccu.table_schema AS foreign_table_schema,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        rc.delete_rule as on_delete,
        rc.update_rule as on_update
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON tc.constraint_name = rc.constraint_name
        AND tc.table_schema = rc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = ANY($1)
        ${excludeTables.length > 0 ? `AND tc.table_name NOT IN (${excludeTables.map((_, i) => `$${i + 2}`).join(", ")})` : ""}
      ORDER BY tc.table_schema, tc.table_name, tc.constraint_name;
    `;

    const fkResult = await client.query(fkQuery, params);

    for (const row of fkResult.rows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      const table = tables.get(tableKey);
      if (!table) continue;

      table.foreignKeys.push({
        constraint_name: row.constraint_name,
        column_name: row.column_name,
        foreign_table_schema: row.foreign_table_schema,
        foreign_table_name: row.foreign_table_name,
        foreign_column_name: row.foreign_column_name,
        on_delete: row.on_delete,
        on_update: row.on_update,
      });
    }
    console.log(" ✓");

    // Fetch check constraints
    process.stdout.write(`  Fetching constraints...`);
    const constraintQuery = `
      SELECT
        tc.table_schema,
        tc.table_name,
        tc.constraint_name,
        tc.constraint_type,
        cc.check_clause,
        ARRAY_AGG(kcu.column_name ORDER BY kcu.ordinal_position) FILTER (WHERE kcu.column_name IS NOT NULL) as columns
      FROM information_schema.table_constraints AS tc
      LEFT JOIN information_schema.check_constraints AS cc
        ON tc.constraint_name = cc.constraint_name
        AND tc.table_schema = cc.constraint_schema
      LEFT JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
      WHERE tc.constraint_type IN ('CHECK', 'UNIQUE')
        AND tc.table_schema = ANY($1)
        ${excludeTables.length > 0 ? `AND tc.table_name NOT IN (${excludeTables.map((_, i) => `$${i + 2}`).join(", ")})` : ""}
      GROUP BY tc.table_schema, tc.table_name, tc.constraint_name, tc.constraint_type, cc.check_clause
      ORDER BY tc.table_schema, tc.table_name, tc.constraint_name;
    `;

    const constraintResult = await client.query(constraintQuery, params);

    for (const row of constraintResult.rows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      const table = tables.get(tableKey);
      if (!table) continue;

      // Parse PostgreSQL array format: {col1,col2} or {"col1","col2"}
      let columns: string[] = [];
      if (row.columns) {
        if (Array.isArray(row.columns)) {
          columns = row.columns;
        } else if (typeof row.columns === 'string') {
          // PostgreSQL returns arrays as strings like "{col1,col2}" or {"col1","col2"}
          const trimmed = row.columns.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            // Remove outer braces and split by comma
            const inner = trimmed.slice(1, -1);
            if (inner) {
              columns = inner.split(',').map((c: string) => {
                // Remove quotes and whitespace
                return c.trim().replace(/^"/, '').replace(/"$/, '');
              });
            }
          } else {
            console.warn(`\nWarning: Unexpected array format for ${row.table_schema}.${row.table_name}.${row.constraint_name}:`, row.columns);
            columns = [trimmed];
          }
        } else {
          console.warn(`\nWarning: Unexpected columns type for ${row.table_schema}.${row.table_name}.${row.constraint_name}: ${typeof row.columns}`, row.columns);
        }
      }

      table.constraints.push({
        constraint_name: row.constraint_name,
        constraint_type: row.constraint_type,
        check_clause: row.check_clause,
        columns: columns,
      });
    }
    console.log(" ✓");

    // Fetch sequences used by tables
    process.stdout.write(`  Fetching sequences...`);
    const sequenceQuery = `
      SELECT DISTINCT
        s.sequence_schema,
        s.sequence_name,
        s.data_type,
        s.start_value,
        s.increment,
        s.maximum_value as max_value,
        s.minimum_value as min_value,
        s.cycle_option as cycle,
        tn.nspname as table_schema,
        t.relname as table_name
      FROM information_schema.sequences s
      JOIN pg_class seq ON seq.relname = s.sequence_name AND seq.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = s.sequence_schema)
      JOIN pg_depend d ON d.objid = seq.oid AND d.deptype = 'a'
      JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE s.sequence_schema = ANY($1)
        ${excludeTables.length > 0 ? `AND t.relname NOT IN (${excludeTables.map((_, i) => `$${i + 2}`).join(", ")})` : ""}
      ORDER BY s.sequence_schema, s.sequence_name;
    `;

    const sequenceResult = await client.query(sequenceQuery, params);

    for (const row of sequenceResult.rows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      const table = tables.get(tableKey);
      if (!table) continue;

      // Check if this sequence is not already added
      if (!table.sequences.some(seq => seq.sequence_name === row.sequence_name)) {
        table.sequences.push({
          sequence_schema: row.sequence_schema,
          sequence_name: row.sequence_name,
          data_type: row.data_type,
          start_value: row.start_value,
          increment: row.increment,
          max_value: row.max_value,
          min_value: row.min_value,
          cycle: row.cycle === 'YES',
        });
      }
    }
    console.log(" ✓");

    // Fetch triggers
    process.stdout.write(`  Fetching triggers...`);
    const triggerQuery = `
      SELECT
        t.trigger_schema as table_schema,
        t.event_object_table as table_name,
        t.trigger_name,
        t.event_manipulation,
        t.action_timing,
        t.action_statement
      FROM information_schema.triggers t
      WHERE t.trigger_schema = ANY($1)
        ${excludeTables.length > 0 ? `AND t.event_object_table NOT IN (${excludeTables.map((_, i) => `$${i + 2}`).join(", ")})` : ""}
      ORDER BY t.trigger_schema, t.event_object_table, t.trigger_name;
    `;

    const triggerResult = await client.query(triggerQuery, params);

    for (const row of triggerResult.rows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      const table = tables.get(tableKey);
      if (!table) continue;

      table.triggers.push({
        trigger_name: row.trigger_name,
        event_manipulation: row.event_manipulation,
        action_timing: row.action_timing,
        action_statement: row.action_statement,
      });
    }
    console.log(" ✓");

    // Fetch RLS policies
    process.stdout.write(`  Fetching RLS policies...`);
    const policyQuery = `
      SELECT
        schemaname as table_schema,
        tablename as table_name,
        policyname as policy_name,
        permissive,
        CASE
          WHEN roles IS NULL THEN ARRAY[]::text[]
          ELSE roles
        END as roles,
        cmd,
        qual,
        with_check
      FROM pg_policies
      WHERE schemaname = ANY($1)
        ${excludeTables.length > 0 ? `AND tablename NOT IN (${excludeTables.map((_, i) => `$${i + 2}`).join(", ")})` : ""}
      ORDER BY schemaname, tablename, policyname;
    `;

    const policyResult = await client.query(policyQuery, params);

    for (const row of policyResult.rows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      const table = tables.get(tableKey);
      if (!table) continue;

      table.policies.push({
        policy_name: row.policy_name,
        permissive: row.permissive,
        roles: Array.isArray(row.roles) ? row.roles : (row.roles ? [row.roles] : []),
        cmd: row.cmd,
        qual: row.qual,
        with_check: row.with_check,
      });
    }
    console.log(" ✓");

    // Fetch ENUM types used by these schemas
    process.stdout.write(`  Fetching ENUM types...`);
    const enumQuery = `
      SELECT
        n.nspname as schema,
        t.typname as name,
        e.enumlabel as label,
        e.enumsortorder as sort_order
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = ANY($1)
      ORDER BY n.nspname, t.typname, e.enumsortorder;
    `;

    const enumResult = await client.query(enumQuery, [schemas]);

    // Group enum values by schema and name
    const enumMap = new Map<string, EnumTypeInfo>();
    for (const row of enumResult.rows) {
      const key = `${row.schema}.${row.name}`;
      if (!enumMap.has(key)) {
        enumMap.set(key, {
          schema: row.schema,
          name: row.name,
          values: [],
        });
      }
      enumMap.get(key)!.values.push(row.label);
    }
    const enums: EnumTypeInfo[] = Array.from(enumMap.values());
    console.log(" ✓");

    // Fetch installed extensions
    process.stdout.write(`  Fetching extensions...`);
    const extensionQuery = `
      SELECT extname
      FROM pg_extension
      WHERE extname NOT IN ('plpgsql')
      ORDER BY extname;
    `;

    const extensionResult = await client.query(extensionQuery);
    const extensions: string[] = extensionResult.rows.map(row => row.extname);
    console.log(" ✓");

    // Fetch functions
    process.stdout.write(`  Fetching functions...`);
    const functionQuery = `
      SELECT
        n.nspname as schema,
        p.proname as name,
        l.lanname as language,
        pg_get_functiondef(p.oid) as definition,
        pg_get_function_result(p.oid) as return_type,
        pg_get_function_arguments(p.oid) as argument_types
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = ANY($1)
        AND p.prokind IN ('f', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY n.nspname, p.proname;
    `;

    const functionResult = await client.query(functionQuery, [schemas]);
    const functions: FunctionInfo[] = functionResult.rows.map(row => ({
      schema: row.schema,
      name: row.name,
      language: row.language,
      definition: row.definition,
      return_type: row.return_type,
      argument_types: row.argument_types,
    }));
    console.log(" ✓");

    return { tables, enums, extensions, functions };
  } finally {
    await client.end();
  }
}

// Compare two column definitions


export { fetchSchemas, fetchAllSchemas };
