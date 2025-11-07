# 🗄️ Database Schema Comparison Tool

A powerful PostgreSQL schema comparison tool built with Bun. Compare schemas between databases, generate bidirectional migration SQL, and get detailed health reports.

## ✨ Features

- 🔍 **Deep Schema Comparison** - Tables, columns, indexes, constraints, foreign keys, triggers, policies, enums, functions
- 🔄 **Bidirectional Migrations** - Generate SQL to sync in either direction
- 📊 **Health Metrics** - Get a health score and identify issues
- 🎯 **Smart Constraint Comparison** - Compares CHECK constraints by logic, UNIQUE constraints by columns (ignores auto-generated names)
- 📝 **Detailed Reports** - Beautiful markdown reports with all differences
- 💾 **Full Database Dumps** - Export complete schemas for local recreation
- 🎨 **Organized Output** - Split migrations into logical files (tables, indexes, constraints, etc.)

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

## 📁 Output Structure

```
.
├── db-schema-diff.md                    # Main comparison report
├── db-schema-diff-MIGRATION-README.md   # Migration guide
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
├── full-source/                         # Complete source schema
│   └── (same structure)
└── full-target/                         # Complete target schema
    └── (same structure)
```

## 🎯 Key Features Explained

### Smart Constraint Comparison

Instead of comparing constraint names (which can be auto-generated), we compare:
- **CHECK constraints** by their logic: `created_at IS NOT NULL` (ignores name differences like `17349_17350_12_not_null` vs `20917734_1_not_null`)
- **UNIQUE constraints** by their columns: Recognizes that constraints on `(user_id, email)` are the same even with different names

### Health Score

Get a 0-100 health score based on:
- Missing tables
- Column type mismatches
- Nullability changes
- Default value differences

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
│   ├── database.ts              # PostgreSQL queries
│   ├── comparison.ts            # Schema comparison logic
│   ├── health.ts                # Health metrics calculation
│   └── generators/
│       ├── sql.ts               # SQL migration generation
│       └── markdown.ts          # Report generation
└── db-config.example.json       # Example configuration
```

## 🔧 CLI Options

```
CONNECTION OPTIONS:
  -s, --source <url>         Source database URL (required)
  -t, --target <url>         Target database URL (optional)
  -c, --config <file>        Load config from JSON file

OUTPUT OPTIONS:
  -o, --output <prefix>      Output filename prefix (default: db-schema-diff)
  -d, --outputDir <dir>      Output directory

FILTER OPTIONS:
  -e, --excludeTables <...>  Exclude specific tables
  -x, --skipSchemas <...>    Skip entire schemas
  --onlyMissingTables        Show only missing tables
  --onlyColumnDiffs          Show only column differences
  --criticalOnly             Show only breaking changes

OTHER:
  --generateFullMigrations   Generate complete SQL dumps
  --saveHistory              Save timestamped snapshot
  -h, --help                 Show help
```

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
