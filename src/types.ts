// ============================================================
// COLUMN TYPES
// ============================================================

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string; // "YES" | "NO"
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

export interface ColumnDifference {
  column_name: string;
  source: ColumnInfo;
  target: ColumnInfo;
  differences: string[];
  isCritical: boolean;
}

// ============================================================
// INDEX TYPES
// ============================================================

export interface IndexInfo {
  index_name: string;
  is_unique: boolean;
  is_primary: boolean;
  columns: string[];
  index_type: string; // "btree" | "hash" | "gin" | "gist" | "brin"
}

// ============================================================
// CONSTRAINT TYPES
// ============================================================

export interface ConstraintInfo {
  constraint_name: string;
  constraint_type: string; // "CHECK" | "UNIQUE" | "PRIMARY KEY"
  check_clause?: string;
  columns?: string[];
}

// ============================================================
// FOREIGN KEY TYPES
// ============================================================

export interface ForeignKeyInfo {
  constraint_name: string;
  column_name: string;
  foreign_table_schema: string;
  foreign_table_name: string;
  foreign_column_name: string;
  on_delete: string;
  on_update: string;
}

// ============================================================
// OTHER SCHEMA ELEMENTS
// ============================================================

export interface SequenceInfo {
  sequence_schema: string;
  sequence_name: string;
  data_type: string;
  start_value: string;
  increment: string;
  max_value: string;
  min_value: string;
  cycle: boolean;
}

export interface TriggerInfo {
  trigger_name: string;
  event_manipulation: string;
  action_timing: string;
  action_statement: string;
}

export interface PolicyInfo {
  policy_name: string;
  permissive: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

export interface EnumTypeInfo {
  schema: string;
  name: string;
  values: string[];
}

export interface ExtensionInfo {
  name: string;
  schema: string;
}

export interface FunctionInfo {
  schema: string;
  name: string;
  language: string;
  definition: string;
  return_type: string;
  argument_types: string;
}

// ============================================================
// TABLE AND SCHEMA TYPES
// ============================================================

export interface TableInfo {
  table_name: string;
  table_schema: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  constraints: ConstraintInfo[];
  sequences: SequenceInfo[];
  triggers: TriggerInfo[];
  policies: PolicyInfo[];
}

export interface SchemaMetadata {
  tables: Map<string, TableInfo>;
  enums: EnumTypeInfo[];
  extensions: ExtensionInfo[];
  functions: FunctionInfo[];
}

export interface TableReference {
  schema: string;
  table: string;
}

export interface TableDiff {
  table_name: string;
  table_schema: string;
  columnsOnlyInSource: ColumnInfo[];
  columnsOnlyInTarget: ColumnInfo[];
  columnsWithDifferences: ColumnDifference[];
  indexesOnlyInSource: IndexInfo[];
  indexesOnlyInTarget: IndexInfo[];
  foreignKeysOnlyInSource: ForeignKeyInfo[];
  foreignKeysOnlyInTarget: ForeignKeyInfo[];
  constraintsOnlyInSource: ConstraintInfo[];
  constraintsOnlyInTarget: ConstraintInfo[];
}

export interface SchemaDiff {
  tablesOnlyInSource: TableReference[];
  tablesOnlyInTarget: TableReference[];
  tablesInBoth: TableDiff[];
}

// ============================================================
// WARNING TYPES
// ============================================================

export type WarningType =
  | 'DUPLICATE_INDEX'
  | 'DUPLICATE_PRIMARY_KEY'
  | 'MISSING_PRIMARY_KEY'
  | 'UNINDEXED_FOREIGN_KEY';

export type WarningSeverity = 'minor' | 'moderate' | 'critical';

export interface SchemaWarning {
  type: WarningType;
  severity: WarningSeverity;
  table: string; // Format: "schema.table"
  message: string;
  details: any; // Flexible for different warning types
  recommendation: string;
}

export interface WarningsReport {
  sourceWarnings: SchemaWarning[];
  targetWarnings: SchemaWarning[];
  totalWarnings: number;
  criticalCount: number;
  moderateCount: number;
  minorCount: number;
  filteredCount?: number; // Number of warnings filtered out by config
}

// ============================================================
// WARNING CONFIGURATION TYPES
// ============================================================

export interface IgnoreRule {
  type: WarningType;
  table?: string; // For config.json format
  pattern?: string; // For .dbdumpignore format
  reason?: string;
}

export interface WarningConfig {
  severity: Partial<Record<WarningType, WarningSeverity>>;
  ignore: IgnoreRule[];
}

// ============================================================
// HEALTH AND SYNC TYPES
// ============================================================

export interface CategoryScore {
  score: number;
  maxScore: number;
  label: string;
  issues: string[];
}

export interface SyncHealth {
  overall: CategoryScore;
  categories: {
    tables: CategoryScore;
    columns: CategoryScore;
    indexes: CategoryScore;
    constraints: CategoryScore;
    other: CategoryScore; // functions, triggers, policies
  };
}

export interface QualityScore {
  score: number;
  maxScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
  severity: "healthy" | "minor" | "moderate" | "critical";
  warnings: WarningsReport;
}

export interface HealthMetrics {
  sync: SyncHealth;
  sourceQuality: QualityScore;
  targetQuality: QualityScore;
}

export interface SyncDirection {
  tablesToCreate: number;
  columnsToAdd: number;
  columnsToModify: number;
}

export interface SyncDirections {
  sourceToTarget: SyncDirection;
  targetToSource: SyncDirection;
}

// ============================================================
// ANALYSIS RESULT
// ============================================================

export interface AnalysisResult {
  timestamp: string;
  sourceDb: string;
  targetDb: string;
  summary: {
    tablesOnlyInSource: number;
    tablesOnlyInTarget: number;
    tablesWithDifferences: number;
    totalColumnDifferences: number;
  };
  diff: SchemaDiff;
}

// ============================================================
// CONFIG TYPES
// ============================================================

export interface ConfigFile {
  source: string;
  target?: string;
  excludeTables?: string[];
  skipSchemas?: string[];
  outputDir?: string;
  // Priority 2: Enhanced config options
  incrementalMode?: boolean;
  outputFormat?: 'split-files' | 'single-file';
  skipEmptyFiles?: boolean;
  transactionScope?: 'per-file' | 'single' | 'none';
  migrationNumbering?: 'auto' | 'manual';
  format?: 'sql' | 'json' | 'markdown';
}

export interface CLIArgs {
  source?: string;
  target?: string;
  config?: string;
  output?: string;
  outputDir?: string;
  excludeTables?: string[];
  skipSchemas?: string[];
  onlyMissingTables?: boolean;
  onlyColumnDiffs?: boolean;
  criticalOnly?: boolean;
  generateFullMigrations?: boolean;
  generateCleanupSQL?: boolean;
  cleanupDryRun?: boolean;
  saveHistory?: boolean;
  useTransactions?: boolean;
  transactionScope?: string;
  sortDependencies?: boolean;
  handleCircularDeps?: boolean;
  migrationNumber?: number;
  skipEmptyFiles?: boolean;
  format?: 'sql' | 'json' | 'markdown';
  dryRun?: boolean;
  help?: boolean;
}

export interface FilterOptions {
  onlyMissingTables: boolean;
  onlyColumnDiffs: boolean;
  criticalOnly: boolean;
}

// ============================================================
// SQL GENERATION TYPES
// ============================================================

export interface SplitMigrationFiles {
  '1-extensions-enums-functions': string;
  '2-sequences': string;
  '3-tables': string;
  '4-indexes': string;
  '5-constraints-foreign-keys': string;
  '6-triggers': string;
  '7-policies': string;
}
