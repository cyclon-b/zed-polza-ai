#!/usr/bin/env node
// MCP-сервер (stdio, JSON-RPC 2.0) с инструментами баланса Polza.ai.
//
// Запуск:
//   node server/polza-mcp.mjs
//
// Zed подключает его как кастомный context server:
//   "context_servers": {
//     "polza-ai": { "command": "node", "args": ["<путь>/server/polza-mcp.mjs"] }
//   }

import { createInterface } from 'node:readline';

import {
  balanceToJson,
  balanceToMarkdown,
  describeConfig,
  fetchBalance,
  PolzaError,
} from './polza-balance.mjs';

const SERVER_INFO = { name: 'polza-ai', title: 'Polza.ai', version: '0.1.0' };
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];

const TOOLS = [
  {
    name: 'polza_balance',
    title: 'Баланс Polza.ai',
    description:
      'Текущий баланс организации Polza.ai: сколько доступно к трате, полный остаток кошелька, резерв под выполняющиеся запросы и потрачено за всё время. Вызывайте после работы с моделями Polza.ai, чтобы показать остаток.',
    inputSchema: {
      type: 'object',
      properties: {
        refresh: {
          type: 'boolean',
          description: 'Игнорировать кэш (1 секунда) и запросить баланс заново.',
          default: false,
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Формат ответа: markdown для человека, json для разбора моделью.',
          default: 'markdown',
        },
        config_path: {
          type: 'string',
          description: 'Необязательный путь к polza.yaml, если конфиг лежит не в стандартном месте.',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Баланс Polza.ai',
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'polza_config',
    title: 'Конфигурация Polza.ai',
    description:
      'Показывает, откуда прочитан polza.yaml, какие адреса API используются и задан ли ключ (сам ключ маскируется). Нужен для диагностики, если баланс не запрашивается.',
    inputSchema: {
      type: 'object',
      properties: {
        config_path: {
          type: 'string',
          description: 'Необязательный путь к polza.yaml.',
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Конфигурация Polza.ai',
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
];

function log(message) {
  process.stderr.write(`[polza-ai] ${message}\n`);
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id, error });
}

function negotiateProtocol(requested) {
  return SUPPORTED_PROTOCOLS.includes(requested) ? requested : '2024-11-05';
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

async function callTool(name, args) {
  if (name === 'polza_balance') {
    const format = args.format === 'json' ? 'json' : 'markdown';
    const result = await fetchBalance({
      force: args.refresh === true,
      configPath: args.config_path,
    });
    const text = format === 'json' ? JSON.stringify(balanceToJson(result), null, 2) : balanceToMarkdown(result);
    return textResult(text);
  }

  if (name === 'polza_config') {
    const details = describeConfig({ configPath: args.config_path });
    return textResult(details.markdown);
  }

  throw new PolzaError('UNKNOWN_TOOL', `Неизвестный инструмент: ${name}`);
}

async function handleRequest(message) {
  const { id, method } = message;
  const params = message.params || {};

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: negotiateProtocol(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'Инструмент polza_balance показывает баланс организации Polza.ai. Ключ и адреса берутся из polza.yaml.',
      });
      return;

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params.name;
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      if (!name) {
        replyError(id, -32602, 'Не указано имя инструмента');
        return;
      }
      try {
        const result = await callTool(name, args);
        reply(id, result);
      } catch (error) {
        const code = error instanceof PolzaError ? error.code : 'INTERNAL_ERROR';
        const details = error instanceof PolzaError && error.traceId ? ` (trace_id: ${error.traceId})` : '';
        log(`tools/call ${name} → ${code}: ${error.message}`);
        reply(id, textResult(`⚠️ ${error.message}${details}`, true));
      }
      return;
    }

    case 'prompts/list':
      reply(id, { prompts: [] });
      return;

    case 'resources/list':
      reply(id, { resources: [] });
      return;

    case 'resources/templates/list':
      reply(id, { resourceTemplates: [] });
      return;

    case 'completion/complete':
      reply(id, { completion: { values: [] } });
      return;

    default:
      replyError(id, -32601, `Метод не поддерживается: ${method}`);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    log(`пропущена строка, не являющаяся JSON: ${trimmed.slice(0, 160)}`);
    return;
  }

  // Уведомления (без id) ответа не требуют.
  if (message.id === undefined || message.id === null) return;

  handleRequest(message).catch((error) => {
    log(`необработанная ошибка: ${error && error.stack ? error.stack : error}`);
    replyError(message.id, -32603, 'Внутренняя ошибка MCP-сервера', String(error));
  });
});

input.on('close', () => {
  process.exit(0);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

log('MCP-сервер запущен');
