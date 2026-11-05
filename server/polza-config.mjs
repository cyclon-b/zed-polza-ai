// Загрузка конфигурации Polza.ai из YAML.
//
// Расширение Zed (WASM) не имеет доступа к файловой системе, поэтому конфиг
// читает процесс MCP-сервера — обычный Node-процесс.

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(moduleDir, '..');

export const DEFAULT_CONFIG = {
  api_key: '',
  api_url: 'https://polza.ai/api/v1',
  balance_url: 'https://polza.ai/api/v2/balance',
  currency: '₽',
  locale: 'ru-RU',
  timeout_ms: 10000,
  cache_ttl_ms: 1000,
  verbose: true,
};

/**
 * Убирает комментарий из строки, не задевая решётки внутри кавычек.
 * Экранированные кавычки в значениях не поддерживаются намеренно:
 * конфиг плоский, а ключи Polza.ai спецсимволов не содержат.
 */
function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      return value.slice(1, -1);
    }
  }
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  if (/^null$/i.test(value) || value === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^\[.*\]$/.test(value)) {
    const body = value.slice(1, -1).trim();
    if (!body) return [];
    return body.split(',').map((item) => parseScalar(item));
  }
  return value;
}

/**
 * Разбирает упрощённый YAML: плоские пары `ключ: значение`.
 * Вложенные структуры не поддерживаются намеренно — конфиг остаётся
 * плоским и предсказуемым. JSON-файл тоже принимается.
 */
export function parseConfigText(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : {};
  }

  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line || line === '---') continue;
    if (line.startsWith('-')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const valueText = line.slice(separator + 1).trim();
    if (!key || !valueText) continue;
    result[key] = parseScalar(valueText);
  }
  return result;
}

/** Пути, где ищется polza.yaml, в порядке приоритета. */
export function configPaths(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const paths = [];

  if (env.POLZA_CONFIG) paths.push(env.POLZA_CONFIG);
  if (env.POLZA_EXTENSION_DIR) paths.push(join(env.POLZA_EXTENSION_DIR, 'polza.yaml'));

  paths.push(join(packageRoot, 'polza.yaml'));

  if (env.APPDATA) paths.push(join(env.APPDATA, 'Zed', 'polza.yaml'));
  if (home) {
    paths.push(join(home, '.config', 'zed', 'polza.yaml'));
    paths.push(join(home, '.zed', 'polza.yaml'));
    paths.push(join(home, '.polza', 'polza.yaml'));
  }

  paths.push(resolve(process.cwd(), 'polza.yaml'));

  return [...new Set(paths)];
}

function applyEnvOverrides(parsed, env) {
  const config = { ...DEFAULT_CONFIG, ...parsed };

  if (env.POLZA_API_KEY) config.api_key = env.POLZA_API_KEY;
  if (env.POLZA_API_URL) config.api_url = env.POLZA_API_URL;
  if (env.POLZA_BALANCE_URL) config.balance_url = env.POLZA_BALANCE_URL;

  const timeout = Number(env.POLZA_TIMEOUT_MS);
  if (Number.isFinite(timeout) && timeout > 0) config.timeout_ms = timeout;

  const cacheTtl = Number(env.POLZA_CACHE_TTL_MS);
  if (Number.isFinite(cacheTtl) && cacheTtl >= 0) config.cache_ttl_ms = cacheTtl;

  config.api_key = typeof config.api_key === 'string' ? config.api_key.trim() : '';
  config.api_url = String(config.api_url || DEFAULT_CONFIG.api_url);
  config.balance_url = String(config.balance_url || DEFAULT_CONFIG.balance_url);
  config.currency = config.currency === null ? '' : String(config.currency);
  config.locale = String(config.locale || DEFAULT_CONFIG.locale);
  config.timeout_ms = Number(config.timeout_ms) > 0 ? Number(config.timeout_ms) : DEFAULT_CONFIG.timeout_ms;
  config.cache_ttl_ms = Number(config.cache_ttl_ms) >= 0 ? Number(config.cache_ttl_ms) : DEFAULT_CONFIG.cache_ttl_ms;
  config.verbose = config.verbose !== false;

  return config;
}

/**
 * Читает конфиг из первого найденного файла.
 * Возвращает конфиг, путь файла и полный список проверенных путей —
 * последнее нужно для диагностики через инструмент `polza_config`.
 */
export function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const explicitPath = options.configPath ?? env.POLZA_CONFIG;
  const candidates = explicitPath ? [explicitPath, ...configPaths(env)] : configPaths(env);

  for (const candidate of candidates) {
    const fullPath = resolve(candidate);
    try {
      if (!statSync(fullPath).isFile()) continue;
    } catch {
      continue;
    }
    const text = readFileSync(fullPath, 'utf8');
    return {
      config: applyEnvOverrides(parseConfigText(text), env),
      path: fullPath,
      candidates,
    };
  }

  return {
    config: applyEnvOverrides({}, env),
    path: null,
    candidates,
  };
}

/** Маскирует ключ для вывода: показывает только края. */
export function maskKey(key) {
  if (!key) return '(не задан)';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
