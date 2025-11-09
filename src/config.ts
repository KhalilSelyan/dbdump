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
      help: {
        type: "boolean",
        short: "h",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  return values;
}

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',

  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  bgBlue: '\x1b[44m',
  bgCyan: '\x1b[46m',
};

function printHelp() {
  console.log(`
${colors.cyan}╔════════════════════════════════════════════════════════════════════════╗
║                                                                        ║
║   ${colors.bright}🗄️  DATABASE SCHEMA COMPARISON TOOL${colors.reset}${colors.cyan}                            ║
║                                                                        ║
║   ${colors.gray}Compare tables and columns between two databases${colors.reset}${colors.cyan}               ║
║                                                                        ║
╚════════════════════════════════════════════════════════════════════════╝${colors.reset}

${colors.bright}${colors.white}USAGE:${colors.reset}
  ${colors.dim}bun run compare-db-schemas.ts [options]${colors.reset}

${colors.bright}${colors.blue}📡 CONNECTION OPTIONS:${colors.reset}
  ${colors.green}-s, --source${colors.reset} <url>         Source database URL ${colors.yellow}(required)${colors.reset}
  ${colors.green}-t, --target${colors.reset} <url>         Target database URL ${colors.gray}(optional - omit for dump-only mode)${colors.reset}
  ${colors.green}-c, --config${colors.reset} <file>        Load config from JSON file

${colors.bright}${colors.blue}📁 OUTPUT OPTIONS:${colors.reset}
  ${colors.green}-o, --output${colors.reset} <prefix>      Output filename prefix ${colors.gray}(default: db-schema-diff)${colors.reset}
  ${colors.green}-d, --outputDir${colors.reset} <dir>      Output directory for generated files

${colors.bright}${colors.blue}🔍 FILTER OPTIONS:${colors.reset}
  ${colors.green}-e, --excludeTables${colors.reset} <...>  Exclude specific tables from comparison
  ${colors.green}-x, --skipSchemas${colors.reset} <...>    Skip entire schemas ${colors.gray}(e.g., extensions, graphql)${colors.reset}
  ${colors.green}--onlyMissingTables${colors.reset}        Show only tables that exist in one DB but not the other
  ${colors.green}--onlyColumnDiffs${colors.reset}          Show only column-level differences
  ${colors.green}--criticalOnly${colors.reset}             Show only breaking changes ${colors.red}(type changes, nullability)${colors.reset}

${colors.bright}${colors.blue}📜 HISTORY OPTIONS:${colors.reset}
  ${colors.green}--saveHistory${colors.reset}              Save this comparison as a timestamped snapshot
  ${colors.green}--compareWith${colors.reset} <file>       Compare current state against a historical snapshot

${colors.bright}${colors.blue}💾 FULL MIGRATION OPTIONS:${colors.reset}
  ${colors.green}--generateFullMigrations${colors.reset}   Generate complete SQL dumps for database(s)
                             ${colors.gray}Creates full-schema.sql files for cloning each database${colors.reset}
                             ${colors.yellow}Required when using dump-only mode (no target specified)${colors.reset}

${colors.bright}${colors.blue}⚡ TRANSACTION OPTIONS:${colors.reset}
  ${colors.green}--useTransactions${colors.reset}          Wrap migrations in BEGIN...COMMIT blocks ${colors.gray}(default: off)${colors.reset}
  ${colors.green}--transactionScope${colors.reset} <type>  Transaction scope: per-file | single ${colors.gray}(default: per-file)${colors.reset}
                             ${colors.dim}per-file: Each migration file gets its own transaction${colors.reset}
                             ${colors.dim}single: One transaction across all files (requires same session)${colors.reset}

${colors.bright}${colors.blue}❓ OTHER:${colors.reset}
  ${colors.green}-h, --help${colors.reset}                 Show this help message

${colors.bright}${colors.magenta}📚 EXAMPLES:${colors.reset}

  ${colors.cyan}●${colors.reset} Basic comparison:
    ${colors.dim}$ bun run compare-db-schemas.ts -c db-config.json${colors.reset}

  ${colors.cyan}●${colors.reset} Dump only source database (no comparison):
    ${colors.dim}$ bun run compare-db-schemas.ts -s $SOURCE_DB_URL --generateFullMigrations -d ./dumps${colors.reset}

  ${colors.cyan}●${colors.reset} Compare with filters:
    ${colors.dim}$ bun run compare-db-schemas.ts -c db-config.json -x extensions graphql${colors.reset}

  ${colors.cyan}●${colors.reset} Focus on missing tables only:
    ${colors.dim}$ bun run compare-db-schemas.ts -c db-config.json --onlyMissingTables${colors.reset}

  ${colors.cyan}●${colors.reset} Track schema evolution over time:
    ${colors.dim}$ bun run compare-db-schemas.ts -c db-config.json --saveHistory${colors.reset}
    ${colors.dim}$ bun run compare-db-schemas.ts -c db-config.json --compareWith db-schema-diff-2025-01-05.json${colors.reset}

  ${colors.cyan}●${colors.reset} Show only critical breaking changes:
    ${colors.dim}$ bun run compare-db-schemas.ts -c db-config.json --criticalOnly${colors.reset}

  ${colors.cyan}●${colors.reset} Generate full database dumps for local cloning:
    ${colors.dim}$ bun run compare-db-schemas.ts -c db-config.json --generateFullMigrations -d ./migrations${colors.reset}

${colors.bright}${colors.magenta}⚙️  CONFIG FILE FORMAT${colors.reset} ${colors.gray}(db-config.json):${colors.reset}

  ${colors.yellow}For comparison mode:${colors.reset}
  ${colors.dim}{
    "source": "postgresql://user:pass@host:port/prod_db",
    "target": "postgresql://user:pass@host:port/dev_db",
    "excludeTables": ["migrations", "schema_migrations"],
    "skipSchemas": ["extensions", "graphql", "realtime"],
    "outputDir": "migrations"
  }${colors.reset}

  ${colors.yellow}For dump-only mode (omit target):${colors.reset}
  ${colors.dim}{
    "source": "postgresql://user:pass@host:port/prod_db",
    "excludeTables": ["migrations", "schema_migrations"],
    "skipSchemas": ["extensions", "graphql", "realtime"],
    "outputDir": "dumps"
  }${colors.reset}

${colors.bright}${colors.magenta}🔗 CONNECTION URL FORMAT:${colors.reset}
  ${colors.dim}postgresql://user:password@host:port/database
  postgres://user:password@host:port/database${colors.reset}

  ${colors.yellow}💡 Tip:${colors.reset} ${colors.gray}Use environment variables for security:${colors.reset}
     ${colors.dim}-s $PROD_DB_URL -t $DEV_DB_URL${colors.reset}

${colors.bright}${colors.green}✨ FEATURES:${colors.reset}
  ${colors.green}✓${colors.reset} Automatic schema discovery across all database schemas
  ${colors.green}✓${colors.reset} Bidirectional sync analysis (what changes are needed both ways)
  ${colors.green}✓${colors.reset} Schema health score and recommendations
  ${colors.green}✓${colors.reset} Beautiful markdown reports with tables and emojis
  ${colors.green}✓${colors.reset} Historical comparison and drift detection
  ${colors.green}✓${colors.reset} Flexible filtering for focused analysis
  ${colors.green}✓${colors.reset} Dump-only mode for single database exports

`);
}

// Load config from file
async function loadConfig(configPath: string): Promise<Config> {
  try {
    const file = Bun.file(configPath);
    const config: Config = await file.json();

    if (!config.source || !config.target) {
      throw new Error(
        "Config file must contain 'source' and 'target' properties"
      );
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
