import { parseArgs } from 'util';
import type { ConfigFile, CLIArgs } from './types';

function parseArguments() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      source: {
        type: "string",
        short: "s",
      },
      target: {
        type: "string",
        short: "t",
      },
      config: {
        type: "string",
        short: "c",
      },
      output: {
        type: "string",
        short: "o",
        default: "db-schema-diff",
      },
      outputDir: {
        type: "string",
        short: "d",
      },
      excludeTables: {
        type: "string",
        multiple: true,
        short: "e",
      },
      skipSchemas: {
        type: "string",
        multiple: true,
        short: "x",
      },
      onlyMissingTables: {
        type: "boolean",
      },
      onlyColumnDiffs: {
        type: "boolean",
      },
      criticalOnly: {
        type: "boolean",
      },
      saveHistory: {
        type: "boolean",
      },
      compareWith: {
        type: "string",
      },
      generateFullMigrations: {
        type: "boolean",
      },
      generateCleanupSQL: {
        type: "boolean",
      },
      cleanupDryRun: {
        type: "boolean",
        default: true,
      },
      useTransactions: {
        type: "boolean",
      },
      transactionScope: {
        type: "string",
        default: "per-file",
      },
      sortDependencies: {
        type: "boolean",
        default: true,
      },
      handleCircularDeps: {
        type: "boolean",
        default: true,
      },
      migrationNumber: {
        type: "string",
      },
      skipEmptyFiles: {
        type: "boolean",
      },
      format: {
        type: "string",
      },
      dryRun: {
        type: "boolean",
      },
      help: {
        type: "boolean",
        short: "h",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  // Convert migrationNumber to number if provided
  const result = values as CLIArgs;
  if (result.migrationNumber !== undefined) {
    const num = parseInt(result.migrationNumber as any, 10);
    if (isNaN(num)) {
      throw new Error(`Invalid migration number: ${result.migrationNumber}`);
    }
    result.migrationNumber = num;
  }

  // Validate format option
  if (result.format !== undefined) {
    const validFormats = ['sql', 'json', 'markdown'];
    if (!validFormats.includes(result.format as string)) {
      throw new Error(`Invalid format: ${result.format}. Must be one of: ${validFormats.join(', ')}`);
    }
  }

  return result;
}

import pc from 'picocolors';
import * as p from '@clack/prompts';

function printHelp() {
  p.intro(pc.bgCyan(pc.black(' 🗄️  Database Schema Comparison Tool ')));

  console.log(`\n${pc.bold(pc.white('USAGE:'))}
  ${pc.dim('bun run compare-db-schemas.ts [options]')}
  ${pc.dim('bun run compare-db-schemas.ts')}              ${pc.cyan('# Interactive mode (no args)')}

${pc.bold(pc.magenta('✨ INTERACTIVE MODE:'))}
  Run without arguments for a guided, interactive setup experience!

  ${pc.cyan('Smart Features:')}
  ${pc.yellow('•')} Auto-detects config files: ${pc.cyan('db-config.json')}, ${pc.cyan('dbdump.config.json')}
  ${pc.yellow('•')} Uses environment variables: ${pc.cyan('$SOURCE_DB_URL')}, ${pc.cyan('$TARGET_DB_URL')}
  ${pc.yellow('•')} Applies sensible defaults (skip system schemas, empty files, etc.)
  ${pc.yellow('•')} Shows helpful hints and validation at each step
  ${pc.yellow('•')} Collapses advanced options for quick setup

  ${pc.dim('Typical flow: 2-4 questions instead of 11+')}

${pc.bold(pc.blue('📡 CONNECTION OPTIONS:'))}
  ${pc.green('-s, --source')} <url>         Source database URL ${pc.yellow('(required in CLI mode)')}
  ${pc.green('-t, --target')} <url>         Target database URL ${pc.gray('(optional - omit for dump-only mode)')}
  ${pc.green('-c, --config')} <file>        Load config from JSON file
                             ${pc.dim('Auto-detected in interactive mode')}

${pc.bold(pc.blue('📁 OUTPUT OPTIONS:'))}
  ${pc.green('-o, --output')} <prefix>      Output filename prefix ${pc.gray('(default: db-schema-diff)')}
  ${pc.green('-d, --outputDir')} <dir>      Output directory for generated files
  ${pc.green('--migrationNumber')} <num>    Use migrations-N directory structure ${pc.gray('(e.g., migrations-3)')}
  ${pc.green('--skipEmptyFiles')}           Skip creation of empty SQL files ${pc.gray('(cleaner git diffs)')}
  ${pc.green('--format')} <type>            Output format: sql | json | markdown ${pc.gray('(default: sql)')}
  ${pc.green('--dryRun')}                   Preview changes without writing files ${pc.gray('(shows what would be generated)')}

${pc.bold(pc.blue('🔍 FILTER OPTIONS:'))}
  ${pc.green('-e, --excludeTables')} <...>  Exclude specific tables from comparison
  ${pc.green('-x, --skipSchemas')} <...>    Skip entire schemas ${pc.gray('(e.g., extensions, graphql)')}
  ${pc.green('--onlyMissingTables')}        Show only tables that exist in one DB but not the other
  ${pc.green('--onlyColumnDiffs')}          Show only column-level differences
  ${pc.green('--criticalOnly')}             Show only breaking changes ${pc.red('(type changes, nullability)')}

${pc.bold(pc.blue('📜 HISTORY OPTIONS:'))}
  ${pc.green('--saveHistory')}              Save this comparison as a timestamped snapshot
  ${pc.green('--compareWith')} <file>       Compare current state against a historical snapshot

${pc.bold(pc.blue('💾 FULL MIGRATION OPTIONS:'))}
  ${pc.green('--generateFullMigrations')}   Generate complete SQL dumps for database(s)
                             ${pc.gray('Creates full-schema.sql files for cloning each database')}
                             ${pc.yellow('Required when using dump-only mode (no target specified)')}

${pc.bold(pc.blue('⚡ ADVANCED SQL OPTIONS:'))}
  ${pc.green('--useTransactions')}          Wrap migrations in BEGIN...COMMIT blocks ${pc.gray('(default: off)')}
  ${pc.green('--transactionScope')} <type>  Transaction scope: per-file | single ${pc.gray('(default: per-file)')}
                             ${pc.dim('per-file: Each migration file gets its own transaction')}
                             ${pc.dim('single: One transaction across all files (requires same session)')}
  ${pc.green('--sortDependencies')}         Order tables by foreign key dependencies ${pc.gray('(default: on)')}
                             ${pc.dim('Automatically orders table creation to satisfy FK constraints')}
                             ${pc.dim('Use --sortDependencies=false to disable')}
  ${pc.green('--handleCircularDeps')}       Handle circular FK dependencies with DEFERRABLE ${pc.gray('(default: on)')}
                             ${pc.dim('Creates tables in 2 phases: structure first, then deferred FKs')}
                             ${pc.dim('Use --handleCircularDeps=false to disable')}

${pc.bold(pc.blue('🔄 ROLLBACK/CLEANUP OPTIONS:'))}
  ${pc.green('--generateCleanupSQL')}       Generate rollback scripts to undo migrations ${pc.gray('(default: off)')}
                             ${pc.dim('Creates rollback-* directories with reverse migration scripts')}
                             ${pc.red('⚠️  These scripts DROP tables/columns - use with caution!')}
  ${pc.green('--cleanupDryRun')}            Dry-run mode for cleanup scripts ${pc.gray('(default: on)')}
                             ${pc.dim('When enabled, all DROP statements are commented out')}
                             ${pc.dim('Use --cleanupDryRun=false to enable actual execution')}

${pc.bold(pc.blue('❓ OTHER:'))}
  ${pc.green('-h, --help')}                 Show this help message

${pc.bold(pc.magenta('📚 EXAMPLES:'))}

  ${pc.cyan('●')} Interactive mode (recommended for first-time users):
    ${pc.dim('$ bun run compare-db-schemas.ts')}
    ${pc.dim('  # Guides you through all options with smart defaults')}

  ${pc.cyan('●')} Interactive with environment variables:
    ${pc.dim('$ export SOURCE_DB_URL="postgresql://..."')}
    ${pc.dim('$ export TARGET_DB_URL="postgresql://..."')}
    ${pc.dim('$ bun run compare-db-schemas.ts')}
    ${pc.dim('  # Automatically uses env vars, just confirm settings')}

  ${pc.cyan('●')} Interactive with auto-detected config:
    ${pc.dim('$ bun run compare-db-schemas.ts')}
    ${pc.dim('  # Finds db-config.json and asks to use it')}

  ${pc.cyan('●')} CLI mode - Basic comparison:
    ${pc.dim('$ bun run compare-db-schemas.ts -c db-config.json')}

  ${pc.cyan('●')} CLI mode - Dump only source database:
    ${pc.dim('$ bun run compare-db-schemas.ts -s $SOURCE_DB_URL --generateFullMigrations -d ./dumps')}

  ${pc.cyan('●')} CLI mode - Compare with filters:
    ${pc.dim('$ bun run compare-db-schemas.ts -c db-config.json -x extensions graphql')}

  ${pc.cyan('●')} CLI mode - Focus on missing tables only:
    ${pc.dim('$ bun run compare-db-schemas.ts -c db-config.json --onlyMissingTables')}

  ${pc.cyan('●')} CLI mode - Track schema evolution over time:
    ${pc.dim('$ bun run compare-db-schemas.ts -c db-config.json --saveHistory')}
    ${pc.dim('$ bun run compare-db-schemas.ts -c db-config.json --compareWith db-schema-diff-2025-01-05.json')}

  ${pc.cyan('●')} CLI mode - Show only critical breaking changes:
    ${pc.dim('$ bun run compare-db-schemas.ts -c db-config.json --criticalOnly')}

  ${pc.cyan('●')} CLI mode - Generate full database dumps:
    ${pc.dim('$ bun run compare-db-schemas.ts -c db-config.json --generateFullMigrations -d ./migrations')}

${pc.bold(pc.magenta('⚙️  CONFIG FILE FORMAT'))} ${pc.gray('(db-config.json):')}

  ${pc.yellow('For comparison mode:')}
  ${pc.dim(`{
    "source": "postgresql://user:pass@host:port/prod_db",
    "target": "postgresql://user:pass@host:port/dev_db",
    "excludeTables": ["migrations", "schema_migrations"],
    "skipSchemas": ["extensions", "graphql", "realtime"],
    "outputDir": "migrations"
  }`)}

  ${pc.yellow('For dump-only mode (omit target):')}
  ${pc.dim(`{
    "source": "postgresql://user:pass@host:port/prod_db",
    "excludeTables": ["migrations", "schema_migrations"],
    "skipSchemas": ["extensions", "graphql", "realtime"],
    "outputDir": "dumps"
  }`)}

${pc.bold(pc.magenta('🔗 CONNECTION URL FORMAT:'))}
  ${pc.dim(`postgresql://user:password@host:port/database
  postgres://user:password@host:port/database`)}

  ${pc.yellow('💡 Tip:')} ${pc.gray('Use environment variables for security:')}
     ${pc.dim('-s $PROD_DB_URL -t $DEV_DB_URL')}

${pc.bold(pc.green('✨ FEATURES:'))}
  ${pc.green('✓')} Automatic schema discovery across all database schemas
  ${pc.green('✓')} Bidirectional sync analysis (what changes are needed both ways)
  ${pc.green('✓')} Schema health score and recommendations
  ${pc.green('✓')} Beautiful markdown reports with tables and emojis
  ${pc.green('✓')} Historical comparison and drift detection
  ${pc.green('✓')} Flexible filtering for focused analysis
  ${pc.green('✓')} Dump-only mode for single database exports

`);

  p.outro(pc.green('💡 Tip: Run without arguments for interactive mode with smart defaults!'));
}

// Load config from file
async function loadConfig(configPath: string): Promise<ConfigFile> {
  try {
    const file = Bun.file(configPath);
    const config: ConfigFile = await file.json();

    if (!config.source) {
      throw new Error(
        "Config file must contain 'source' property"
      );
    }

    // Apply incrementalMode preset
    if (config.incrementalMode) {
      // incrementalMode enables skipEmptyFiles by default
      if (config.skipEmptyFiles === undefined) {
        config.skipEmptyFiles = true;
      }
    }

    return config;
  } catch (error) {
    throw new Error(`Failed to load config file: ${error}`);
  }
}

// Mask sensitive parts of connection string for logging
function maskConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      return url.replace(parsed.password, "****");
    }
    return url;
  } catch {
    return "****";
  }
}

// Fetch all user schemas from database (excluding system schemas)


export { parseArguments, printHelp, loadConfig };
