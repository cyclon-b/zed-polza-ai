#!/usr/bin/env node
// Держит баланс Polza.ai в заголовке вкладки терминала.
//
// Запускается задачей Zed (`task: spawn` → «Polza: баланс в заголовке»)
// и не использует агента или модель.
//
//   node scripts/balance-watch.mjs
//   POLZA_WATCH_INTERVAL_MS=60000 node scripts/balance-watch.mjs

import { balanceToMarkdown, fetchBalance, formatMoney } from '../server/polza-balance.mjs';

const intervalMs = Math.max(15000, Number(process.env.POLZA_WATCH_INTERVAL_MS) || 120000);
const tty = process.stdout.isTTY;

let lastAvailable = null;
let timer = null;

function setTitle(text) {
  if (tty) process.stdout.write(`\x1b]0;${text}\x07`);
}

function timeLabel() {
  return new Intl.DateTimeFormat('ru-RU', { timeStyle: 'short' }).format(new Date());
}

async function tick(first = false) {
  try {
    const result = await fetchBalance();
    const available = String(result.balance.available);
    setTitle(`Polza: ${formatMoney(result.balance.available, result.config)}`);

    if (first) {
      process.stdout.write(`${balanceToMarkdown(result)}\n\n`);
    } else if (available !== lastAvailable) {
      process.stdout.write(`[${timeLabel()}] доступно ${formatMoney(result.balance.available, result.config)}\n`);
    }
    lastAvailable = available;
  } catch (error) {
    setTitle('Polza: ошибка');
    process.stdout.write(`[${timeLabel()}] ⚠️ ${error.message}\n`);
  }
}

async function main() {
  await tick(true);
  process.stdout.write(`Обновление каждые ${Math.round(intervalMs / 1000)} с. Ctrl+C — остановить.\n`);
  timer = setInterval(tick, intervalMs);
}

function stop() {
  if (timer) clearInterval(timer);
  setTitle('Polza');
  process.stdout.write('\nОстановлено.\n');
  process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

main();
