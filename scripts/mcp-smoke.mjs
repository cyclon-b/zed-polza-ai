#!/usr/bin/env node
// Смоук-тест MCP-сервера: поднимает его как дочерний процесс и проверяет
// handshake, список инструментов и диагностику конфига — без сетевого ключа.
//
//   node scripts/mcp-smoke.mjs
//
// С --network дополнительно проверяет реальный запрос баланса с (заведомо
// неверным) ключом и ждёт 401 от Polza.ai.

import { spawn } from 'node:child_process';
import { EOL } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(moduleDir, '..');
const serverPath = join(root, 'server', 'polza-mcp.mjs');

const withNetwork = process.argv.includes('--network');
const failures = [];

function check(name, condition, details) {
  if (condition) {
    process.stdout.write(`  ok  ${name}${EOL}`);
    return;
  }
  failures.push(name);
  process.stdout.write(`  FAIL ${name}${details ? `: ${details}` : ''}${EOL}`);
}

function startServer(env) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  return child;
}

function createClient(child) {
  const pending = new Map();
  let nextId = 1;
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  return function request(method, params = {}) {
    const id = nextId;
    nextId += 1;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`Таймаут ответа на ${method}`));
      }, 15000);
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolvePromise(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}${EOL}`);
    });
  };
}

async function main() {
  process.stdout.write(`MCP-сервер: ${serverPath}${EOL}`);

  const child = startServer({ POLZA_CONFIG: join(root, 'polza.yaml'), POLZA_API_KEY: '' });
  const request = createClient(child);

  try {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'polza-smoke', version: '0.1.0' },
    });
    check('initialize: имя сервера', init.serverInfo && init.serverInfo.name === 'polza-ai');
    check('initialize: инструменты объявлены', Boolean(init.capabilities && init.capabilities.tools));

    const listed = await request('tools/list');
    const names = (listed.tools || []).map((tool) => tool.name);
    check('tools/list: polza_balance', names.includes('polza_balance'), names.join(', '));
    check('tools/list: polza_config', names.includes('polza_config'), names.join(', '));

    const configResult = await request('tools/call', { name: 'polza_config', arguments: {} });
    const configText = configResult.content[0].text;
    check('polza_config: читает polza.yaml', configText.includes('polza.yaml'), configText.slice(0, 120));
    check('polza_config: ключ замаскирован', configText.includes('api_key: (не задан)') || configText.includes('…'));

    const noKey = await request('tools/call', { name: 'polza_balance', arguments: {} });
    check('polza_balance без ключа: ошибка', noKey.isError === true);
    check(
      'polza_balance без ключа: подсказка про api_key',
      String(noKey.content[0].text).includes('api_key'),
      noKey.content[0].text,
    );

    const unknown = await request('tools/call', { name: 'nope', arguments: {} });
    check('неизвестный инструмент: isError', unknown.isError === true);

    if (withNetwork) {
      child.kill();
      const networkChild = startServer({ POLZA_CONFIG: join(root, 'polza.yaml'), POLZA_API_KEY: 'test-key' });
      const networkRequest = createClient(networkChild);
      try {
        const badKey = await networkRequest('tools/call', { name: 'polza_balance', arguments: {} });
        const text = String(badKey.content[0].text);
        check('сеть: неверный ключ → 401', badKey.isError === true && text.includes('401'), text);
      } finally {
        networkChild.kill();
      }
    }
  } finally {
    child.kill();
  }

  if (failures.length > 0) {
    process.stdout.write(`${EOL}Провалено: ${failures.length}${EOL}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${EOL}Все проверки прошли${EOL}`);
}

main().catch((error) => {
  process.stdout.write(`Смоук-тест упал: ${error.message}${EOL}`);
  process.exitCode = 1;
});
