# 🗄️ Database Schema Comparison Tool

A powerful PostgreSQL schema comparison tool built with Bun. Compare schemas between databases, generate bidirectional migration SQL with advanced features like transaction wrappers, dependency sorting, and rollback scripts.

## ✨ Features

- 🎯 **Interactive Mode** - Guided CLI experience with prompts when running without arguments
- 🔍 **Deep Schema Comparison** - Tables, columns, indexes, constraints, foreign keys, triggers, policies, enums, functions
- 🔄 **Bidirectional Migrations** - Generate SQL to sync in either direction
- 📊 **Health Metrics** - Get a health score and identify issues with configurable warnings
- 🎯 **Smart Constraint Comparison** - Compares CHECK constraints by logic, UNIQUE constraints by columns (ignores auto-generated names)
- 📝 **Detailed Reports** - Beautiful markdown reports with all differences
- 💾 **Full Database Dumps** - Export complete schemas for local recreation
- 🎨 **Organized Output** - Split migrations into logical files (tables, indexes, constraints, etc.)
- 🎨 **Modern CLI** - Beautiful terminal output with spinners, progress indicators, and clack prompts
- ⚡ **Transaction Wrappers** - Wrap migrations in BEGIN/COMMIT blocks with configurable scope
- 🔗 **Dependency Sorting** - Automatically orders tables by foreign key dependencies
- 🔄 **Circular Dependency Handling** - Handles circular FK relationships with DEFERRABLE constraints
- ↩️ **Rollback Scripts** - Generate reverse migrations with dry-run safety mode
- ⚙️ **Warning Configuration** - Customize warning severity and ignore patterns
- 📋 **Migration Numbering** - Create numbered migration folders (migrations-0, migrations-1, etc.)
- 🧹 **Empty File Skipping** - Skip creation of empty SQL files for cleaner git diffs
- 🔌 **Programmatic API** - TypeScript API for integration with other tools
- 📄 **JSON Output** - Machine-readable output for tooling integration
- 👁️ **Dry-Run Mode** - Preview migrations without writing files
- 📈 **Enhanced Console Output** - Migration summaries with change statistics
- 📦 **Standalone Binary** - Compile to single executable for easy distribution

## 🚀 Quick Start

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Clone and navigate
git clone https://github.com/KhalilSelyan/dbdump
cd dbdump

# Install dependencies
bun install

# Option 1: Interactive mode (easiest!)
bun run compareordumpdbs.ts

# Option 2: Build binary and use it
bun run build
./dbdump

# Option 3: Install globally
bun run install-global
dbdump  # Now available anywhere!
```

## 📦 Building & Installation

### Build Standalone Binary

Compile to a single executable:

```bash
bun run build
```

This creates a `./dbdump` binary that you can distribute or run directly.

### Install Globally

Install the binary system-wide:

```bash
bun run install-global
```

This installs to `/usr/local/bin/dbdump`, making it available from anywhere:

```bash
dbdump --help
dbdump -c db-config.json
```

### NPM Scripts Available

- `bun run compare` - Run the tool with TypeScript source
- `bun run help` - Show help message
- `bun run build` - Compile to standalone binary
- `bun run install-global` - Build and install globally

## 📖 Usage

### Interactive Mode (Recommended)

Simply run without arguments for a guided experience:

```bash
# Using source
bun run compareordumpdbs.ts

# Using binary
./dbdump

# Or if installed globally
dbdump
```

The interactive mode will guide you through:
- Source and target database URLs
- Comparison vs dump-only mode
- Output directory and format
- Migration numbering
- Advanced options (transactions, dependencies, etc.)

### Compare Two Databases

```bash
# With config file
bun run compareordumpdbs.ts -c db-config.json

# Or directly with URLs
./dbdump -s $SOURCE_DB_URL -t $TARGET_DB_URL
```

### Generate Full Database Dumps

```bash
./dbdump -c db-config.json --generateFullMigrations
```

### With Transaction Wrappers

```bash
# Each migration file gets its own transaction
./dbdump -c db-config.json --useTransactions

# Single transaction across all files
./dbdump -c db-config.json --useTransactions --transactionScope single
```

### Generate Rollback Scripts

```bash
# Generate rollback scripts in dry-run mode (safe, all DROP statements commented)
./dbdump -c db-config.json --generateCleanupSQL

# Enable actual execution (DANGEROUS - will execute DROP statements)
./dbdump -c db-config.json --generateCleanupSQL --cleanupDryRun=false
```

### Dump Single Database (No Comparison)

```bash
./dbdump -s $DATABASE_URL --generateFullMigrations
```

### With Filters

```bash
# Skip certain schemas
./dbdump -c db-config.json -x extensions graphql realtime

# Only show missing tables
./dbdump -c db-config.json --onlyMissingTables

# Only show breaking changes
./dbdump -c db-config.json --criticalOnly
```

## ⚙️ Configuration

### Database Configuration

Create a `db-config.json`:

```json
{
  "source": "postgresql://user:pass@host:port/source_db",
  "target": "postgresql://user:pass@host:port/target_db",
  "excludeTables": ["migrations", "schema_migrations"],
  "skipSchemas": ["extensions", "graphql", "realtime"],
  "outputDir": "."
}
```

### Warning Configuration

Create a `.dbdumpconfig.json` to customize warning severity and ignore patterns:

```json
{
  "severity": {
    "DUPLICATE_INDEX": "minor",
    "MISSING_PRIMARY_KEY": "moderate"
  },
  "ignore": [
    {
      "type": "UNINDEXED_FOREIGN_KEY",
      "table": "public.migrations",
      "reason": "Migrations table doesn't need FK indexes"
    },
    {
      "type": "DUPLICATE_INDEX",
      "pattern": "public.temp_*",
      "reason": "Temporary tables are okay with duplicates"
    }
  ]
}
```

Or use `.dbdumpignore` for simpler patterns:

```
# Ignore all warnings for migrations table
UNINDEXED_FOREIGN_KEY public.migrations

# Ignore duplicate indexes on all temp tables
DUPLICATE_INDEX public.temp_*

# Comments and reasons
MISSING_PRIMARY_KEY public.logs  # Logs table doesn't need PK
```

## 📁 Output Structure

```
.
├── db-schema-diff.md                    # Main comparison report
├── db-schema-diff-MIGRATION-README.md   # Migration guide
├── db-schema-warnings-source.md         # Warning report for source DB
├── db-schema-warnings-target.md         # Warning report for target DB
├── diff-source-to-target/               # Sync target with source
│   ├── 1-extensions-enums-functions.sql
│   ├── 2-sequences.sql
│   ├── 3-tables.sql
│   ├── 4-indexes.sql
│   ├── 5-constraints-foreign-keys.sql
│   ├── 6-triggers.sql
│   └── 7-policies.sql
├── diff-target-to-source/               # Sync source with target
│   └── (same structure)
├── rollback-source-to-target/           # Rollback source→target migration
│   ├── 7-policies.sql                   # Execute in REVERSE order
│   ├── 6-triggers.sql                   # (7→6→5→4→3→2→1)
│   ├── 5-constraints-foreign-keys.sql
│   ├── 4-indexes.sql
│   ├── 3-tables.sql                     # ⚠️ Contains DROP statements
│   ├── 2-sequences.sql
│   └── 1-extensions-enums-functions.sql
├── rollback-target-to-source/           # Rollback target→source migration
│   └── (same structure)
├── full-source/                         # Complete source schema
│   └── (same structure as diff)
└── full-target/                         # Complete target schema
    └── (same structure as diff)
```

## 🎯 Key Features Explained

### Smart Constraint Comparison

Instead of comparing constraint names (which can be auto-generated), we compare:
- **CHECK constraints** by their logic: `created_at IS NOT NULL` (ignores name differences like `17349_17350_12_not_null` vs `20917734_1_not_null`)
- **UNIQUE constraints** by their columns: Recognizes that constraints on `(user_id, email)` are the same even with different names

### Health Score & Warnings

Get a 0-100 health score based on:
- Missing tables
- Column type mismatches
- Nullability changes
- Default value differences

Plus configurable warnings for:
- Duplicate indexes
- Missing primary keys
- Unindexed foreign keys
- Duplicate primary keys

### Transaction Wrappers

Wrap your migrations in transactions for atomicity:

**Per-File Mode** (default): Each migration file gets its own transaction
```sql
BEGIN;
-- migrations here
COMMIT;
```

**Single Mode**: One transaction across all files (requires same psql session)
```sql
-- File 1
BEGIN;
-- migrations...

-- File 7
-- more migrations...
COMMIT;
```

### Dependency Sorting

Automatically orders table creation by foreign key dependencies:
- Tables with no dependencies are created first
- Prevents constraint errors during migration
- Can be disabled with `--sortDependencies=false`

### Circular Dependency Handling

Handles circular FK relationships with two-phase creation:

**Phase 1**: Create table structures without foreign keys
```sql
CREATE TABLE users (...);
CREATE TABLE profiles (...);
```

**Phase 2**: Add FKs with DEFERRABLE constraints
```sql
ALTER TABLE users ADD CONSTRAINT fk_profile
  FOREIGN KEY (profile_id) REFERENCES profiles(id)
  DEFERRABLE INITIALLY DEFERRED;
```

This allows circular references to be validated at COMMIT time.

### Rollback Scripts

Generate reverse migrations to undo changes:

**Dry-Run Mode** (default - SAFE):
```sql
-- [DRY-RUN] DROP TABLE IF EXISTS users CASCADE;
-- [DRY-RUN] DROP FUNCTION IF EXISTS calculate_total(...) CASCADE;
```

**Execution Mode** (DANGEROUS):
```sql
DROP TABLE IF EXISTS users CASCADE;
DROP FUNCTION IF EXISTS calculate_total(...) CASCADE;
```

Features:
- Comprehensive warnings about data loss
- Row count check suggestions before dropping tables
- Files numbered in reverse (7→1) for proper teardown
- Separate rollback directories for each migration direction

### Bidirectional Analysis

Understand what needs to sync in both directions:
- **Source → Target**: What target needs from source
- **Target → Source**: What source needs from target

## 🏗️ Project Structure

```
.
├── compareordumpdbs.ts          # CLI entry point
├── src/
│   ├── api.ts                   # Programmatic API (NEW!)
│   ├── types.ts                 # TypeScript interfaces
│   ├── utils.ts                 # Helper functions
│   ├── config.ts                # CLI argument parsing
│   ├── config-loader.ts         # Warning config loader
│   ├── colors.ts                # Terminal color utilities
│   ├── database.ts              # PostgreSQL queries with retry logic
│   ├── comparison.ts            # Schema comparison logic
│   ├── health.ts                # Health metrics calculation
│   └── generators/
│       ├── sql.ts               # SQL migration generation
│       ├── markdown.ts          # Report generation
│       └── warnings.ts          # Warning detection
├── package.json                 # Exports API and CLI
├── db-config.example.json       # Example configuration with new options
├── .dbdumpconfig.json           # Warning configuration (optional)
└── .dbdumpignore                # Simple warning ignore patterns (optional)
```

## 🔧 CLI Options

### Connection Options
```
-s, --source <url>         Source database URL (required)
-t, --target <url>         Target database URL (optional - omit for dump-only mode)
-c, --config <file>        Load config from JSON file
```

### Output Options
```
-o, --output <prefix>      Output filename prefix (default: db-schema-diff)
-d, --outputDir <dir>      Output directory for generated files
--migrationNumber <num>    Use migrations-N directory structure (e.g., migrations-3)
--skipEmptyFiles           Skip creation of empty SQL files (cleaner git diffs)
--format <type>            Output format: sql | json | markdown (default: sql)
--dryRun                   Preview changes without writing files (shows what would be generated)
```

### Filter Options
```
-e, --excludeTables <...>  Exclude specific tables from comparison
-x, --skipSchemas <...>    Skip entire schemas (e.g., extensions, graphql)
--onlyMissingTables        Show only tables that exist in one DB but not the other
--onlyColumnDiffs          Show only column-level differences
--criticalOnly             Show only breaking changes (type changes, nullability)
```

### History Options
```
--saveHistory              Save this comparison as a timestamped snapshot
--compareWith <file>       Compare current state against a historical snapshot
```

### Full Migration Options
```
--generateFullMigrations   Generate complete SQL dumps for database(s)
                           Creates full-schema.sql files for cloning each database
```

### Advanced SQL Options
```
--useTransactions          Wrap migrations in BEGIN...COMMIT blocks (default: off)
--transactionScope <type>  Transaction scope: per-file | single (default: per-file)
                           per-file: Each migration file gets its own transaction
                           single: One transaction across all files (requires same session)
--sortDependencies         Order tables by foreign key dependencies (default: on)
                           Automatically orders table creation to satisfy FK constraints
                           Use --sortDependencies=false to disable
--handleCircularDeps       Handle circular FK dependencies with DEFERRABLE (default: on)
                           Creates tables in 2 phases: structure first, then deferred FKs
                           Use --handleCircularDeps=false to disable
```

### Rollback/Cleanup Options
```
--generateCleanupSQL       Generate rollback scripts to undo migrations (default: off)
                           Creates rollback-* directories with reverse migration scripts
                           ⚠️  These scripts DROP tables/columns - use with caution!
--cleanupDryRun            Dry-run mode for cleanup scripts (default: on)
                           When enabled, all DROP statements are commented out
                           Use --cleanupDryRun=false to enable actual execution
```

### Other
```
-h, --help                 Show help message
```

## 💡 Usage Examples

### Basic Comparison
```bash
bun run compareordumpdbs.ts -c db-config.json
```

### Dump Only Source Database
```bash
bun run compareordumpdbs.ts -s $SOURCE_DB_URL --generateFullMigrations -d ./dumps
```

### Compare with Filters
```bash
bun run compareordumpdbs.ts -c db-config.json -x extensions graphql
```

### Focus on Missing Tables
```bash
bun run compareordumpdbs.ts -c db-config.json --onlyMissingTables
```

### Track Schema Evolution
```bash
# Save current state
bun run compareordumpdbs.ts -c db-config.json --saveHistory

# Compare against previous state
bun run compareordumpdbs.ts -c db-config.json --compareWith db-schema-diff-2025-01-05.json
```

### Show Only Critical Changes
```bash
bun run compareordumpdbs.ts -c db-config.json --criticalOnly
```

### Generate Full Dumps with Transactions
```bash
bun run compareordumpdbs.ts -c db-config.json \
  --generateFullMigrations \
  --useTransactions \
  --transactionScope per-file \
  -d ./migrations
```

### Generate Migrations with Rollback Scripts
```bash
bun run compareordumpdbs.ts -c db-config.json \
  --generateFullMigrations \
  --generateCleanupSQL \
  --useTransactions
```

### Disable Dependency Sorting (for debugging)
```bash
bun run compareordumpdbs.ts -c db-config.json \
  --sortDependencies=false \
  --handleCircularDeps=false
```

## 🚀 Advanced Features

### Migration Numbering

Create numbered migration folders for version control integration:

```bash
# Create baseline migration (migrations-0)
bun run compareordumpdbs.ts \
  -s postgresql://localhost/prod_db \
  --generateFullMigrations \
  --migrationNumber 0 \
  --outputDir ./drizzle

# Creates: ./drizzle/migrations-0/ with all schema files
```

```bash
# Create incremental migration (migrations-3)
bun run compareordumpdbs.ts \
  -s postgresql://localhost/current_db \
  -t postgresql://localhost/temp_migration \
  --migrationNumber 3 \
  --skipEmptyFiles \
  --outputDir ./drizzle

# Creates: ./drizzle/migrations-3/ with only changed files
```

### JSON Output Mode

Generate machine-readable output for tooling integration:

```bash
bun run compareordumpdbs.ts \
  -s postgresql://localhost/source \
  -t postgresql://localhost/target \
  --format json > migration-result.json
```

**Output format:**
```json
{
  "differences": {
    "tables": {
      "added": ["public.profiles"],
      "removed": [],
      "modified": [{
        "table": "public.users",
        "changes": [
          { "type": "column_added", "column": "bio", "dataType": "text" }
        ]
      }]
    },
    "functions": { "added": ["calculate_stats"], "removed": [], "modified": [] }
  },
  "summary": {
    "totalChanges": 2,
    "breaking": false,
    "fileCount": 0
  }
}
```

### Dry-Run Mode

Preview what would be generated without writing files:

```bash
bun run compareordumpdbs.ts \
  -s postgresql://localhost/source \
  -t postgresql://localhost/target \
  --migrationNumber 5 \
  --dryRun

# Shows:
#   [DRY RUN] ./migrations-5/diff-source-to-target/3-tables.sql (127 lines)
#   [DRY RUN] ./migrations-5/diff-source-to-target/6-triggers.sql (45 lines)
```

### Programmatic API

Use dbdump as a TypeScript library:

```typescript
import { generateMigration, generateFullDump } from 'dbdump';

// Generate incremental migration
const result = await generateMigration({
  sourceUrl: 'postgresql://localhost/current',
  targetUrl: 'postgresql://localhost/temp',
  outputDir: './drizzle',
  migrationNumber: 5,
  skipEmptyFiles: true,
  useTransactions: true,
  sortDependencies: true,
});

console.log(`Created migration-${result.version}`);
console.log(`Files created: ${result.filesCreated.length}`);
console.log(`Total changes: ${result.totalChanges}`);
console.log(`Tables: ${result.changeTypes.tables}`);
console.log(`Columns: ${result.changeTypes.columns}`);

// Generate full database dump
const files = await generateFullDump({
  dbUrl: 'postgresql://localhost/prod',
  outputDir: './dumps',
  migrationNumber: 0,
  skipEmptyFiles: true,
});

console.log(`Created ${files.length} files`);
```

### Enhanced Config File

Use config file for cleaner commands:

**db-config.json:**
```json
{
  "source": "postgresql://localhost/source_db",
  "target": "postgresql://localhost/target_db",
  "outputDir": "./migrations",
  "excludeTables": ["migrations", "schema_migrations"],
  "skipSchemas": ["extensions", "graphql"],
  "incrementalMode": true,
  "skipEmptyFiles": true,
  "format": "sql",
  "transactionScope": "per-file"
}
```

Then simply run:
```bash
bun run compareordumpdbs.ts -c db-config.json --migrationNumber 3
```

**Config Options:**
- `incrementalMode` - When true, automatically enables `skipEmptyFiles`
- `skipEmptyFiles` - Skip creation of empty SQL files
- `format` - Output format (sql, json, markdown)
- `transactionScope` - Transaction scope (per-file, single, none)
- `migrationNumbering` - "manual" (requires --migrationNumber flag) or "auto" (future feature)

### Migration Summary

When generating migrations, see a detailed summary:

```
Migration Summary:
  Tables: 3 changes
  Columns: 12 changes
  Indexes: 5 changes
  Constraints: 8 changes
  Functions: 2 changes
  Total files created: 6
```

### Circular Dependency Warnings

Automatically detects and warns about circular foreign key relationships:

```
⚠️  Circular dependencies detected!
Tables with circular FK relationships will use DEFERRABLE constraints.
Check the generated SQL for details.
```

## 🔒 Safety Features

1. **Dry-Run by Default**: Rollback scripts are generated with all DROP statements commented out
2. **Preview Mode**: Use `--dryRun` to see what would be generated without writing files
3. **Transaction Support**: Optional transaction wrappers for atomicity
4. **Row Count Checks**: Rollback scripts include suggestions to check row counts before dropping
5. **Comprehensive Warnings**: Clear warnings about data loss risks in rollback scripts
6. **Dependency Sorting**: Prevents FK constraint errors by ordering table creation
7. **Circular Dep Handling**: Uses DEFERRABLE constraints to handle circular relationships safely
8. **Retry Logic**: Automatic retry with exponential backoff for transient connection failures
9. **Enhanced Error Messages**: Clear, actionable error messages for common database issues
10. **Migration Summary**: Shows detailed change statistics before committing

## 🤝 Contributing

This is a personal tool but feel free to fork and adapt for your needs!

## 📝 License

MIT

## 🙏 Built With

- [Bun](https://bun.sh) - Fast JavaScript runtime
- [pg](https://node-postgres.com) - PostgreSQL client
- TypeScript - Type safety

---

**Made with ❤️ for database schema management**
