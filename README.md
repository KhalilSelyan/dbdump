# 🗄️ Database Schema Comparison Tool

A powerful PostgreSQL schema comparison tool built with Bun. Compare schemas between databases, generate bidirectional migration SQL with advanced features like transaction wrappers, dependency sorting, and rollback scripts.

## ✨ Features

- 🔍 **Deep Schema Comparison** - Tables, columns, indexes, constraints, foreign keys, triggers, policies, enums, functions
- 🔄 **Bidirectional Migrations** - Generate SQL to sync in either direction
- 📊 **Health Metrics** - Get a health score and identify issues with configurable warnings
- 🎯 **Smart Constraint Comparison** - Compares CHECK constraints by logic, UNIQUE constraints by columns (ignores auto-generated names)
- 📝 **Detailed Reports** - Beautiful markdown reports with all differences
- 💾 **Full Database Dumps** - Export complete schemas for local recreation
- 🎨 **Organized Output** - Split migrations into logical files (tables, indexes, constraints, etc.)
- 🎨 **Colorful Terminal Output** - Easy-to-read colored console output with progress indicators
- ⚡ **Transaction Wrappers** - Wrap migrations in BEGIN/COMMIT blocks with configurable scope
- 🔗 **Dependency Sorting** - Automatically orders tables by foreign key dependencies
- 🔄 **Circular Dependency Handling** - Handles circular FK relationships with DEFERRABLE constraints
- ↩️ **Rollback Scripts** - Generate reverse migrations with dry-run safety mode
- ⚙️ **Warning Configuration** - Customize warning severity and ignore patterns

## 🚀 Quick Start

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Clone and navigate
git clone https://github.com/KhalilSelyan/dbdump
cd dbdump

# Copy example config
cp db-config.example.json db-config.json

# Edit with your database URLs
nano db-config.json

# Run comparison
bun run compareordumpdbs.ts -c db-config.json
```

## 📖 Usage

### Compare Two Databases

```bash
bun run compareordumpdbs.ts -c db-config.json
```

### Generate Full Database Dumps

```bash
bun run compareordumpdbs.ts -c db-config.json --generateFullMigrations
```

### With Transaction Wrappers

```bash
# Each migration file gets its own transaction
bun run compareordumpdbs.ts -c db-config.json --useTransactions

# Single transaction across all files
bun run compareordumpdbs.ts -c db-config.json --useTransactions --transactionScope single
```

### Generate Rollback Scripts

```bash
# Generate rollback scripts in dry-run mode (safe, all DROP statements commented)
bun run compareordumpdbs.ts -c db-config.json --generateCleanupSQL

# Enable actual execution (DANGEROUS - will execute DROP statements)
bun run compareordumpdbs.ts -c db-config.json --generateCleanupSQL --cleanupDryRun=false
```

### Dump Single Database (No Comparison)

```bash
bun run compareordumpdbs.ts -s $DATABASE_URL --generateFullMigrations
```

### With Filters

```bash
# Skip certain schemas
bun run compareordumpdbs.ts -c db-config.json -x extensions graphql realtime

# Only show missing tables
bun run compareordumpdbs.ts -c db-config.json --onlyMissingTables

# Only show breaking changes
bun run compareordumpdbs.ts -c db-config.json --criticalOnly
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
├── compareordumpdbs.ts          # Main entry point
├── src/
│   ├── types.ts                 # TypeScript interfaces
│   ├── utils.ts                 # Helper functions
│   ├── config.ts                # CLI argument parsing
│   ├── config-loader.ts         # Warning config loader
│   ├── colors.ts                # Terminal color utilities
│   ├── database.ts              # PostgreSQL queries
│   ├── comparison.ts            # Schema comparison logic
│   ├── health.ts                # Health metrics calculation
│   └── generators/
│       ├── sql.ts               # SQL migration generation
│       ├── markdown.ts          # Report generation
│       └── warnings.ts          # Warning detection
├── db-config.example.json       # Example configuration
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

## 🔒 Safety Features

1. **Dry-Run by Default**: Rollback scripts are generated with all DROP statements commented out
2. **Transaction Support**: Optional transaction wrappers for atomicity
3. **Row Count Checks**: Rollback scripts include suggestions to check row counts before dropping
4. **Comprehensive Warnings**: Clear warnings about data loss risks in rollback scripts
5. **Dependency Sorting**: Prevents FK constraint errors by ordering table creation
6. **Circular Dep Handling**: Uses DEFERRABLE constraints to handle circular relationships safely

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
