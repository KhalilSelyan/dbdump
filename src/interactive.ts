import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { CLIArgs, ConfigFile } from './types';
import { loadConfig } from './config';

// Common schema presets that most projects want to skip
const COMMON_SKIP_SCHEMAS = ['extensions', 'graphql', 'realtime', 'auth', 'storage', 'vault', 'pgsodium'];
const COMMON_EXCLUDE_TABLES = ['migrations', 'schema_migrations', 'drizzle_migrations'];

/**
 * Detect config files in common locations
 * Returns the first config file found or undefined
 */
async function detectConfigFile(): Promise<string | undefined> {
  const possiblePaths = [
    'db-config.json',
    'dbdump.config.json',
    '.dbdump.json',
    'dbdump.json',
  ];

  for (const path of possiblePaths) {
    const file = Bun.file(path);
    if (await file.exists()) {
      return path;
    }
  }

  return undefined;
}

/**
 * Check environment variables for database URLs
 */
function getEnvDatabaseUrls(): { source?: string; target?: string } {
  return {
    source: process.env.SOURCE_DB_URL || process.env.DATABASE_URL,
    target: process.env.TARGET_DB_URL,
  };
}

export async function runInteractiveMode(): Promise<CLIArgs> {
  p.intro(pc.bgCyan(pc.black(' 🗄️  Database Schema Comparison Tool ')));

  p.note(
    `${pc.dim('This tool helps you:')}
${pc.cyan('•')} Compare schemas between two databases
${pc.cyan('•')} Generate migration SQL files
${pc.cyan('•')} Dump a single database schema

${pc.dim('Tips:')}
${pc.yellow('•')} Use ${pc.cyan('db-config.json')} for reusable configurations
${pc.yellow('•')} Set ${pc.cyan('$SOURCE_DB_URL')} and ${pc.cyan('$TARGET_DB_URL')} env vars
${pc.yellow('•')} Press ${pc.cyan('Ctrl+C')} anytime to cancel`,
    'Welcome!'
  );

  // Step 1: Check for config file
  const detectedConfig = await detectConfigFile();
  let loadedConfig: ConfigFile | undefined;

  if (detectedConfig) {
    const useConfig = await p.confirm({
      message: `Found ${pc.cyan(detectedConfig)}. Load settings from this file?`,
      initialValue: true,
    });

    if (p.isCancel(useConfig)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    if (useConfig) {
      try {
        loadedConfig = await loadConfig(detectedConfig);
        p.log.success(`Loaded config from ${pc.cyan(detectedConfig)}`);
      } catch (error) {
        p.log.error(`Failed to load config: ${error}`);
      }
    }
  } else {
    // Offer to specify a config file path
    const hasConfig = await p.confirm({
      message: 'Do you have a config file you want to use?',
      initialValue: false,
    });

    if (p.isCancel(hasConfig)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    if (hasConfig) {
      const configPath = await p.text({
        message: 'Config file path:',
        placeholder: './db-config.json',
        validate: (value) => {
          if (!value) return 'Config path is required';
        },
      });

      if (p.isCancel(configPath)) {
        p.cancel('Operation cancelled');
        process.exit(0);
      }

      try {
        loadedConfig = await loadConfig(configPath as string);
        p.log.success(`Loaded config from ${pc.cyan(configPath as string)}`);
      } catch (error) {
        p.log.error(`Failed to load config: ${error}`);
        p.log.info('Continuing with manual setup...');
      }
    }
  }

  // Check environment variables
  const envUrls = getEnvDatabaseUrls();
  if (envUrls.source) {
    p.log.info(`Found ${pc.cyan('$SOURCE_DB_URL')} environment variable`);
  }
  if (envUrls.target) {
    p.log.info(`Found ${pc.cyan('$TARGET_DB_URL')} environment variable`);
  }

  // Step 2: Get source database URL (use config > env > prompt)
  let source: string | symbol;

  if (loadedConfig?.source) {
    const useConfigSource = await p.confirm({
      message: `Use source from config: ${pc.dim(loadedConfig.source.substring(0, 50))}...?`,
      initialValue: true,
    });

    if (p.isCancel(useConfigSource)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    if (useConfigSource) {
      source = loadedConfig.source;
      p.log.success('Using source database from config');
    } else {
      source = await p.text({
        message: 'Source database URL:',
        placeholder: envUrls.source || 'postgresql://user:pass@host:port/database',
        defaultValue: envUrls.source,
        validate: (value) => {
          if (!value) return 'Source database URL is required';
          if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
            return 'Must be a valid PostgreSQL connection URL';
          }
        },
      });
    }
  } else {
    source = await p.text({
      message: 'Source database URL:',
      placeholder: envUrls.source || 'postgresql://user:pass@host:port/database',
      defaultValue: envUrls.source,
      validate: (value) => {
        if (!value) return 'Source database URL is required';
        if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
          return 'Must be a valid PostgreSQL connection URL';
        }
      },
    });
  }

  if (p.isCancel(source)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  // Step 3: Choose mode
  const mode = await p.select({
    message: 'What would you like to do?',
    options: [
      { value: 'compare', label: 'Compare two databases', hint: 'Find differences between source and target' },
      { value: 'dump', label: 'Dump source database only', hint: 'Generate full schema export' },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  // Step 4: Get target database URL if comparing
  let target: string | symbol | undefined;

  if (mode === 'compare') {
    if (loadedConfig?.target) {
      const useConfigTarget = await p.confirm({
        message: `Use target from config: ${pc.dim(loadedConfig.target.substring(0, 50))}...?`,
        initialValue: true,
      });

      if (p.isCancel(useConfigTarget)) {
        p.cancel('Operation cancelled');
        process.exit(0);
      }

      if (useConfigTarget) {
        target = loadedConfig.target;
        p.log.success('Using target database from config');
      } else {
        target = await p.text({
          message: 'Target database URL:',
          placeholder: envUrls.target || 'postgresql://user:pass@host:port/database',
          defaultValue: envUrls.target,
          validate: (value) => {
            if (!value) return 'Target database URL is required for comparison mode';
            if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
              return 'Must be a valid PostgreSQL connection URL';
            }
          },
        });
      }
    } else {
      target = await p.text({
        message: 'Target database URL:',
        placeholder: envUrls.target || 'postgresql://user:pass@host:port/database',
        defaultValue: envUrls.target,
        validate: (value) => {
          if (!value) return 'Target database URL is required for comparison mode';
          if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
            return 'Must be a valid PostgreSQL connection URL';
          }
        },
      });
    }

    if (p.isCancel(target)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }
  }

  // Step 5: Output configuration (with smart defaults)
  const defaultOutputDir = loadedConfig?.outputDir || './migrations';
  const outputDir = await p.text({
    message: 'Output directory:',
    placeholder: defaultOutputDir,
    defaultValue: defaultOutputDir,
  });

  if (p.isCancel(outputDir)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  // Step 6: Basic options (with smart defaults)
  const defaultFormat = loadedConfig?.format || 'sql';
  const format = await p.select({
    message: 'Output format:',
    options: [
      { value: 'sql', label: 'SQL', hint: 'Migration SQL files (recommended)' },
      { value: 'json', label: 'JSON', hint: 'Machine-readable format' },
      { value: 'markdown', label: 'Markdown', hint: 'Human-readable report' },
    ],
    initialValue: defaultFormat,
  });

  if (p.isCancel(format)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  // Step 7: Common filters with smart defaults
  const useCommonDefaults = await p.confirm({
    message: `Use common defaults? ${pc.dim('(skip system schemas, skip empty files)')}`,
    initialValue: true,
  });

  if (p.isCancel(useCommonDefaults)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  let skipSchemas: string[] | undefined;
  let excludeTables: string[] | undefined;
  let skipEmptyFiles: boolean;
  let dryRun: boolean = false;

  if (useCommonDefaults) {
    // Use sensible defaults
    skipSchemas = loadedConfig?.skipSchemas || COMMON_SKIP_SCHEMAS;
    excludeTables = loadedConfig?.excludeTables || COMMON_EXCLUDE_TABLES;
    skipEmptyFiles = loadedConfig?.skipEmptyFiles !== undefined ? loadedConfig.skipEmptyFiles : true;

    p.log.info(`${pc.dim('Skipping schemas:')} ${pc.cyan(skipSchemas.join(', '))}`);
    p.log.info(`${pc.dim('Excluding tables:')} ${pc.cyan(excludeTables.join(', '))}`);
    p.log.info(`${pc.dim('Skip empty files:')} ${pc.cyan(skipEmptyFiles ? 'Yes' : 'No')}`);
  } else {
    // Ask for custom values
    skipEmptyFiles = await p.confirm({
      message: 'Skip empty SQL files?',
      initialValue: loadedConfig?.skipEmptyFiles !== undefined ? loadedConfig.skipEmptyFiles : true,
    }) as boolean;

    if (p.isCancel(skipEmptyFiles)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }
  }

  // Step 8: Advanced options
  const advancedOptions = await p.confirm({
    message: `Configure advanced options? ${pc.dim('(filters, transactions, migrations)')}`,
    initialValue: false,
  });

  if (p.isCancel(advancedOptions)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  let migrationNumber: number | undefined;
  let generateFullMigrations: boolean | undefined;
  let useTransactions: boolean | undefined;

  if (advancedOptions) {
    // Custom schema/table filters (if not using defaults)
    if (!useCommonDefaults) {
      const skipSchemasInput = await p.text({
        message: 'Skip schemas (comma-separated):',
        placeholder: COMMON_SKIP_SCHEMAS.join(','),
        defaultValue: loadedConfig?.skipSchemas?.join(','),
      });

      if (p.isCancel(skipSchemasInput)) {
        p.cancel('Operation cancelled');
        process.exit(0);
      }

      if (skipSchemasInput) {
        skipSchemas = (skipSchemasInput as string).split(',').map(s => s.trim());
      }

      const excludeTablesInput = await p.text({
        message: 'Exclude tables (comma-separated):',
        placeholder: COMMON_EXCLUDE_TABLES.join(','),
        defaultValue: loadedConfig?.excludeTables?.join(','),
      });

      if (p.isCancel(excludeTablesInput)) {
        p.cancel('Operation cancelled');
        process.exit(0);
      }

      if (excludeTablesInput) {
        excludeTables = (excludeTablesInput as string).split(',').map(s => s.trim());
      }
    }

    // Migration number
    const migrationNumberInput = await p.text({
      message: 'Migration number (optional):',
      placeholder: 'e.g., 3 for migrations-3 directory',
      validate: (value) => {
        if (value && isNaN(parseInt(value as string, 10))) {
          return 'Must be a valid number';
        }
      },
    });

    if (p.isCancel(migrationNumberInput)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    if (migrationNumberInput) {
      migrationNumber = parseInt(migrationNumberInput as string, 10);
    }

    // Dry run mode
    dryRun = await p.confirm({
      message: 'Dry-run mode (preview without writing files)?',
      initialValue: false,
    }) as boolean;

    if (p.isCancel(dryRun)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    // Full migrations
    if (mode === 'dump') {
      generateFullMigrations = true;
    } else {
      const fullMigrations = await p.confirm({
        message: 'Generate full database dumps?',
        initialValue: false,
      });

      if (p.isCancel(fullMigrations)) {
        p.cancel('Operation cancelled');
        process.exit(0);
      }

      generateFullMigrations = fullMigrations as boolean;
    }

    // Transactions
    const transactions = await p.confirm({
      message: 'Wrap migrations in transactions?',
      initialValue: loadedConfig?.transactionScope !== 'none',
    });

    if (p.isCancel(transactions)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    useTransactions = transactions as boolean;
  } else {
    // Non-advanced mode defaults
    if (mode === 'dump') {
      generateFullMigrations = true;
    }
  }

  // Show summary
  p.note(
    `${pc.bold('Configuration Summary:')}
${pc.dim('Source:')} ${pc.cyan(typeof source === 'string' ? source.substring(0, 50) + '...' : '')}
${mode === 'compare' ? `${pc.dim('Target:')} ${pc.cyan(typeof target === 'string' ? target.substring(0, 50) + '...' : '')}` : ''}
${pc.dim('Output:')} ${pc.cyan(outputDir as string)}
${pc.dim('Format:')} ${pc.cyan(format as string)}
${skipSchemas ? `${pc.dim('Skip schemas:')} ${pc.cyan(skipSchemas.length + ' schemas')}` : ''}
${excludeTables ? `${pc.dim('Exclude tables:')} ${pc.cyan(excludeTables.length + ' tables')}` : ''}`,
    'Ready to proceed'
  );

  return {
    source: source as string,
    target: target as string | undefined,
    outputDir: outputDir as string,
    format: format as 'sql' | 'json' | 'markdown',
    migrationNumber,
    skipEmptyFiles,
    dryRun,
    skipSchemas,
    excludeTables,
    generateFullMigrations,
    useTransactions,
  };
}
