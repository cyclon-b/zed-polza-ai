// Баланс Polza.ai: запрос GET /api/v2/balance и форматирование результата.
//
// Ответ API (все суммы — строки):
// { amount, available, reservedAmount, spentAmount, updatedAt }

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, maskKey } from './polza-config.mjs';

export class PolzaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PolzaError';
    this.code = code;
    this.status = details.status;
    this.traceId = details.traceId;
  }
}

// Кэш на процесс MCP-сервера: у Polza.ai ответ и так кэшируется ~1 секунду,
// но повторные вызовы инструмента не должны каждый раз ходить в сеть.
const cache = { at: 0, url: '', key: '', balance: null };

const TLS_ERROR_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

function isTlsError(error) {
  const code = error && error.cause && error.cause.code;
  if (code && TLS_ERROR_CODES.has(code)) return true;
  return /certificate|self-signed|self signed/i.test(String(error && error.message));
}

async function fetchWithTimeout(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Фолбэк через curl: в корпоративных сетях с MITM-прокси Node не доверяет
 * цепочке (SELF_SIGNED_CERT_IN_CHAIN), а curl с системными CA — доверяет.
 */
function curlRequest(url, apiKey, timeoutMs) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const dir = mkdtempSync(join(tmpdir(), 'polza-ai-'));
  const bodyFile = join(dir, 'body.json');

  const result = spawnSync(
    'curl',
    [
      '-sS',
      '--max-time',
      String(seconds),
      '-o',
      bodyFile,
      '-w',
      '%{http_code}',
      '-H',
      `Authorization: Bearer ${apiKey}`,
      '-H',
      'Accept: application/json',
      url,
    ],
    { encoding: 'utf8', windowsHide: true },
  );

  const text = existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });

  if (result.error) {
    throw new PolzaError(
      'CURL_UNAVAILABLE',
      'Node не смог установить TLS-соединение, а curl недоступен. Установите curl или запустите Zed с NODE_OPTIONS=--use-system-ca.',
      { status: 0 },
    );
  }

  const status = Number(String(result.stdout || '').trim());
  if (!Number.isFinite(status) || status === 0) {
    const reason = String(result.stderr || '').trim() || 'curl завершился без HTTP-статуса';
    throw new PolzaError('NETWORK', `Не удалось запросить баланс: ${reason}`, { status: 0 });
  }

  return { status, text };
}

function parseResponse({ status, text }) {
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (status >= 200 && status < 300) {
    if (!payload || typeof payload !== 'object') {
      throw new PolzaError('BAD_RESPONSE', 'Polza.ai вернул ответ не в формате JSON.', { status });
    }
    return payload;
  }

  const apiError = (payload && payload.error) || {};
  const message = apiError.message || `HTTP ${status}`;
  const traceId = apiError.trace_id || (payload && payload.trace_id);

  if (status === 401 || status === 403) {
    throw new PolzaError(
      'BAD_API_KEY',
      `Ключ Polza.ai не принят (${status}): ${message}. Проверьте api_key в polza.yaml.`,
      { status, traceId },
    );
  }
  if (status === 402) {
    throw new PolzaError('PAYMENT_REQUIRED', `Запрос отклонён по балансу или лимитам (402): ${message}`, {
      status,
      traceId,
    });
  }
  if (status === 429) {
    throw new PolzaError('RATE_LIMITED', `Слишком много запросов к Polza.ai (429): ${message}`, {
      status,
      traceId,
    });
  }
  if (status >= 500) {
    throw new PolzaError('SERVICE_UNAVAILABLE', `Polza.ai временно недоступен (${status}): ${message}`, {
      status,
      traceId,
    });
  }
  throw new PolzaError('HTTP_ERROR', `Polza.ai ответил ${status}: ${message}`, { status, traceId });
}

async function requestBalance(config) {
  const headers = {
    Authorization: `Bearer ${config.api_key}`,
    Accept: 'application/json',
  };

  try {
    const response = await fetchWithTimeout(config.balance_url, headers, config.timeout_ms);
    return parseResponse(response);
  } catch (error) {
    if (error instanceof PolzaError) throw error;
    if (isTlsError(error)) {
      return parseResponse(curlRequest(config.balance_url, config.api_key, config.timeout_ms));
    }
    const reason = error && error.name === 'AbortError' ? 'истекло время ожидания' : error.message;
    throw new PolzaError('NETWORK', `Не удалось связаться с Polza.ai: ${reason}`);
  }
}

/**
 * Возвращает баланс (с учётом короткого кэша) и предыдущий замер —
 * по нему считается изменение «с прошлой проверки».
 */
export async function fetchBalance(options = {}) {
  const loaded = options.config
    ? { config: options.config, path: null, candidates: [] }
    : loadConfig({ configPath: options.configPath });
  const config = loaded.config;

  if (!config.api_key) {
    throw new PolzaError(
      'NO_API_KEY',
      'Не задан api_key. Создайте polza.yaml рядом с проектом расширения (или задайте POLZA_CONFIG / POLZA_API_KEY).',
    );
  }

  const now = Date.now();
  const sameTarget = cache.balance && cache.url === config.balance_url && cache.key === config.api_key;
  const cached = sameTarget && options.force !== true && now - cache.at < config.cache_ttl_ms;

  if (cached) {
    return { balance: cache.balance, previous: null, config, configPath: loaded.path, cached: true };
  }

  const balance = await requestBalance(config);
  const previous = sameTarget ? cache.balance : null;

  cache.at = now;
  cache.url = config.balance_url;
  cache.key = config.api_key;
  cache.balance = balance;

  return { balance, previous, config, configPath: loaded.path, cached: false };
}

export function formatMoney(value, config) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value == null ? '—' : value);
  const formatted = new Intl.NumberFormat(config.locale || 'ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
  return config.currency ? `${formatted} ${config.currency}` : formatted;
}

export function formatUpdated(iso, config) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '—');
  return new Intl.DateTimeFormat(config.locale || 'ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function availableDelta(balance, previous) {
  if (!previous) return null;
  const current = Number(balance.available);
  const before = Number(previous.available);
  if (!Number.isFinite(current) || !Number.isFinite(before)) return null;
  return Math.round((current - before) * 100000000) / 100000000;
}

export function balanceToMarkdown(result) {
  const { balance, previous, config, cached } = result;
  const lines = [];

  lines.push(`**Polza.ai — доступно ${formatMoney(balance.available, config)}**`);
  if (balance.amount !== undefined) {
    lines.push(`- Баланс организации: ${formatMoney(balance.amount, config)}`);
  }
  if (balance.reservedAmount !== undefined) {
    lines.push(`- Резерв под выполняющиеся запросы: ${formatMoney(balance.reservedAmount, config)}`);
  }
  if (balance.spentAmount !== undefined) {
    lines.push(`- Потрачено за всё время: ${formatMoney(balance.spentAmount, config)}`);
  }
  if (balance.updatedAt) {
    lines.push(`- Обновлено: ${formatUpdated(balance.updatedAt, config)}`);
  }

  const delta = availableDelta(balance, previous);
  if (delta !== null && delta !== 0) {
    const sign = delta > 0 ? '+' : '−';
    lines.push(`- Изменение с прошлой проверки: ${sign}${formatMoney(Math.abs(delta), config)}`);
  }

  if (cached) lines.push('_Данные из кэша (менее секунды с прошлого запроса)._');
  if (result.configPath) lines.push(`_Конфиг: ${result.configPath}_`);

  return lines.join('\n');
}

export function balanceToJson(result) {
  const delta = availableDelta(result.balance, result.previous);
  return {
    amount: result.balance.amount,
    available: result.balance.available,
    reservedAmount: result.balance.reservedAmount,
    spentAmount: result.balance.spentAmount,
    updatedAt: result.balance.updatedAt,
    changeSincePrevious: delta,
    cached: result.cached,
    configPath: result.configPath,
  };
}

/** Диагностика конфигурации — без самого ключа. */
export function describeConfig(options = {}) {
  const loaded = loadConfig({ configPath: options.configPath });
  const config = loaded.config;
  const lines = [];

  lines.push('**Конфигурация Polza.ai**');
  lines.push(`- Файл: ${loaded.path || 'не найден (используются значения по умолчанию)'}`);
  lines.push(`- api_key: ${maskKey(config.api_key)}`);
  lines.push(`- api_url: ${config.api_url}`);
  lines.push(`- balance_url: ${config.balance_url}`);
  lines.push(`- timeout_ms: ${config.timeout_ms}`);
  lines.push(`- cache_ttl_ms: ${config.cache_ttl_ms}`);
  lines.push(`- currency: ${config.currency || '(без символа)'}`);
  lines.push('');
  lines.push('_Проверенные пути:_');
  for (const candidate of loaded.candidates) {
    lines.push(`- ${candidate}`);
  }

  return {
    path: loaded.path,
    apiKeySet: Boolean(config.api_key),
    config,
    candidates: loaded.candidates,
    markdown: lines.join('\n'),
  };
}
