import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { CLIArgs } from './types';

export async function runInteractiveMode(): Promise<CLIArgs> {
  p.intro(pc.bgCyan(pc.black(' 🗄️  Database Schema Comparison Tool ')));

  const source = await p.text({
    message: 'Source database URL:',
    placeholder: 'postgresql://user:pass@host:port/database',
    validate: (value) => {
      if (!value) return 'Source database URL is required';
      if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
        return 'Must be a valid PostgreSQL connection URL';
      }
    },
  });

  if (p.isCancel(source)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

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

  let target: string | symbol | undefined;

  if (mode === 'compare') {
    target = await p.text({
      message: 'Target database URL:',
      placeholder: 'postgresql://user:pass@host:port/database',
      validate: (value) => {
        if (!value) return 'Target database URL is required for comparison mode';
        if (!value.startsWith('postgres://') && !value.startsWith('postgresql://')) {
          return 'Must be a valid PostgreSQL connection URL';
        }
      },
    });

    if (p.isCancel(target)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }
  }

  const outputDir = await p.text({
    message: 'Output directory:',
    placeholder: './migrations',
    defaultValue: './migrations',
  });

  if (p.isCancel(outputDir)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  const format = await p.select({
    message: 'Output format:',
    options: [
      { value: 'sql', label: 'SQL', hint: 'Generate migration SQL files' },
      { value: 'json', label: 'JSON', hint: 'Machine-readable format' },
      { value: 'markdown', label: 'Markdown', hint: 'Human-readable report' },
    ],
    initialValue: 'sql',
  });

  if (p.isCancel(format)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  const migrationNumber = await p.text({
    message: 'Migration number (optional):',
    placeholder: 'e.g., 3 for migrations-3 directory',
    validate: (value) => {
      if (value && isNaN(parseInt(value as string, 10))) {
        return 'Must be a valid number';
      }
    },
  });

  if (p.isCancel(migrationNumber)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  const skipEmptyFiles = await p.confirm({
    message: 'Skip empty SQL files?',
    initialValue: true,
  });

  if (p.isCancel(skipEmptyFiles)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  const dryRun = await p.confirm({
    message: 'Dry-run mode (preview without writing files)?',
    initialValue: false,
  });

  if (p.isCancel(dryRun)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  const advancedOptions = await p.confirm({
    message: 'Configure advanced options?',
    initialValue: false,
  });

  if (p.isCancel(advancedOptions)) {
    p.cancel('Operation cancelled');
    process.exit(0);
  }

  let skipSchemas: string[] | undefined;
  let excludeTables: string[] | undefined;
  let generateFullMigrations: boolean | undefined;
  let useTransactions: boolean | undefined;

  if (advancedOptions) {
    const skipSchemasInput = await p.text({
      message: 'Skip schemas (comma-separated, optional):',
      placeholder: 'e.g., extensions,graphql,realtime',
    });

    if (p.isCancel(skipSchemasInput)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    if (skipSchemasInput) {
      skipSchemas = (skipSchemasInput as string).split(',').map(s => s.trim());
    }

    const excludeTablesInput = await p.text({
      message: 'Exclude tables (comma-separated, optional):',
      placeholder: 'e.g., migrations,schema_migrations',
    });

    if (p.isCancel(excludeTablesInput)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    if (excludeTablesInput) {
      excludeTables = (excludeTablesInput as string).split(',').map(s => s.trim());
    }

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

    const transactions = await p.confirm({
      message: 'Wrap migrations in transactions?',
      initialValue: false,
    });

    if (p.isCancel(transactions)) {
      p.cancel('Operation cancelled');
      process.exit(0);
    }

    useTransactions = transactions as boolean;
  } else if (mode === 'dump') {
    generateFullMigrations = true;
  }

  return {
    source: source as string,
    target: target as string | undefined,
    outputDir: outputDir as string,
    format: format as 'sql' | 'json' | 'markdown',
    migrationNumber: migrationNumber ? parseInt(migrationNumber as string, 10) : undefined,
    skipEmptyFiles: skipEmptyFiles as boolean,
    dryRun: dryRun as boolean,
    skipSchemas,
    excludeTables,
    generateFullMigrations,
    useTransactions,
  };
}
