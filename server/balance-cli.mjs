#!/usr/bin/env node
// CLI для проверки баланса без Zed — и для будущей Rust-обёртки (слеш-команда).
//
//   node server/balance-cli.mjs            # markdown-отчёт
//   node server/balance-cli.mjs --json     # JSON
//   node server/balance-cli.mjs --config D:/path/polza.yaml
//   node server/balance-cli.mjs --check    # только диагностика конфига

import {
  balanceToJson,
  balanceToMarkdown,
  describeConfig,
  fetchBalance,
} from './polza-balance.mjs';

function parseArgs(argv) {
  const options = { json: false, force: false, check: false, configPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--config') {
      index += 1;
      options.configPath = argv[index];
    } else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(
      [
        'Использование: node server/balance-cli.mjs [--json] [--force] [--check] [--config <путь>]',
        '',
        '  --json     вывести баланс в JSON',
        '  --force    игнорировать кэш',
        '  --check    показать найденный конфиг и проверенные пути',
        '  --config   путь к polza.yaml',
      ].join('\n') + '\n',
    );
    return;
  }

  if (options.check) {
    const details = describeConfig({ configPath: options.configPath });
    process.stdout.write(`${details.markdown}\n`);
    return;
  }

  const result = await fetchBalance({ force: options.force, configPath: options.configPath });
  const output = options.json
    ? JSON.stringify(balanceToJson(result), null, 2)
    : balanceToMarkdown(result);
  process.stdout.write(`${output}\n`);
}

main().catch((error) => {
  process.stdout.write(`⚠️ ${error.message}\n`);
  process.exitCode = 1;
});
