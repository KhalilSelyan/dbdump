import type { WarningConfig, IgnoreRule } from './types';
import { c } from './colors';

/**
 * Default warning configuration
 */
const DEFAULT_CONFIG: WarningConfig = {
  severity: {},
  ignore: []
};

/**
 * Load warning configuration from .dbdumpconfig.json
 */
export async function loadWarningConfig(configPath: string = '.dbdumpconfig.json'): Promise<WarningConfig> {
  try {
    const file = Bun.file(configPath);
    if (await file.exists()) {
      const content = await file.text();
      const json = JSON.parse(content);

      if (json.warnings) {
        return {
          severity: json.warnings.severity || {},
          ignore: json.warnings.ignore || []
        };
      }
    }
  } catch (error) {
    console.warn(`Warning: Failed to load ${configPath}: ${error}`);
  }

  return DEFAULT_CONFIG;
}

/**
 * Load ignore rules from .dbdumpignore file
 */
export async function loadIgnoreFile(ignorePath: string = '.dbdumpignore'): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];

  try {
    const file = Bun.file(ignorePath);
    if (await file.exists()) {
      const content = await file.text();
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Parse format: WARNING_TYPE pattern [reason]
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) continue;

        const [type, pattern, ...reasonParts] = parts;
        const reason = reasonParts.join(' ') || 'Ignored via .dbdumpignore';

        rules.push({
          type: type as any,
          pattern,
          reason
        });
      }
    }
  } catch (error) {
    console.warn(`Warning: Failed to load ${ignorePath}: ${error}`);
  }

  return rules;
}

/**
 * Check if a table matches a glob pattern
 * Supports: * (any chars), ? (single char)
 */
export function matchesPattern(tableName: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
    .replace(/\*/g, '.*')  // * matches any chars
    .replace(/\?/g, '.');  // ? matches single char

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(tableName);
}

/**
 * Check if a warning should be ignored based on rules
 */
export function shouldIgnoreWarning(
  warningType: string,
  tableName: string,
  ignoreRules: IgnoreRule[]
): boolean {
  for (const rule of ignoreRules) {
    if (rule.type === warningType) {
      // Check if table matches pattern
      if (rule.pattern === '*' || matchesPattern(tableName, rule.pattern)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Merge ignore rules from config and ignore file
 */
export function mergeIgnoreRules(
  configRules: IgnoreRule[],
  ignoreFileRules: IgnoreRule[]
): IgnoreRule[] {
  // Convert config rules to the same format as ignore file rules
  const normalizedConfigRules = configRules.map(rule => ({
    type: rule.type,
    pattern: rule.table || '*',
    reason: rule.reason || 'Ignored via config'
  }));

  return [...normalizedConfigRules, ...ignoreFileRules];
}

/**
 * Load complete warning configuration
 */
export async function loadCompleteWarningConfig(): Promise<{
  config: WarningConfig;
  ignoreRules: IgnoreRule[];
  summary: string;
}> {
  const config = await loadWarningConfig();
  const ignoreFileRules = await loadIgnoreFile();
  const allIgnoreRules = mergeIgnoreRules(config.ignore, ignoreFileRules);

  // Generate summary
  const severityCount = Object.keys(config.severity).length;
  const ignoreCount = allIgnoreRules.length;

  let summary = '';
  if (severityCount > 0 || ignoreCount > 0) {
    summary = c.info('Loaded warning configuration:') + '\n';
    if (severityCount > 0) {
      summary += c.dim(`  - `) + c.count(severityCount) + c.dim(` severity override(s)\n`);
    }
    if (ignoreCount > 0) {
      summary += c.dim(`  - `) + c.count(ignoreCount) + c.dim(` ignore rule(s)\n`);
    }
  }

  return {
    config,
    ignoreRules: allIgnoreRules,
    summary
  };
}
