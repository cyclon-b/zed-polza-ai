# Zed Polza.ai

Расширение Zed для [Polza.ai](https://polza.ai): показывает баланс организации
(`GET /api/v2/balance`) в панели агента. Ключ хранится в `polza.yaml`.

## Из чего состоит

| Часть | Что делает | Нужен ли Rust |
| --- | --- | --- |
| `server/polza-mcp.mjs` | MCP-сервер (stdio) с инструментами `polza_balance` и `polza_config` | нет |
| `server/balance-cli.mjs` | CLI для ручной проверки и для слеш-команды | нет |
| `src/lib.rs` | расширение Zed: слеш-команда `/polza-balance` + регистрация MCP-сервера | да |

MCP-сервер — самостоятельный Node-процесс: он читает `polza.yaml`, ходит в API и
кэширует ответ на секунду. Расширение — тонкая обёртка: WASM не умеет читать
файлы, поэтому слеш-команда запускает тот же Node-скрипт.

## Быстрый старт (без Rust)

1. Впишите ключ в `polza.yaml`:

   ```yaml
   api_key: "ваш ключ Polza.ai"
   ```

2. Добавьте сервер в `settings.json` Zed (файл `settings.snippet.json`):

   ```json
   {
     "context_servers": {
       "polza-ai": {
         "command": "node",
         "args": ["D:/path/to/zed-polza-ai/server/polza-mcp.mjs"],
         "env": {
           "POLZA_CONFIG": "D:/path/to/zed-polza-ai/polza.yaml"
         }
       }
     }
   }
   ```

   То же самое можно сделать через UI: **Settings → AI → MCP Servers → Add
   Server → Add Local Server** (command: `node`, args: путь к `polza-mcp.mjs`).

3. Проверьте: **Settings → AI → MCP Servers** — индикатор `polza-ai` зелёный,
   в панели агента доступен инструмент `polza_balance`.

Если Zed не находит `node` (частый случай на Windows без PATH для GUI-приложений),
укажите абсолютный путь к нему в `command`, например
`C:/nvm4w/nodejs/node.exe`.

### Проверка из терминала

```bash
node server/balance-cli.mjs           # отчёт по балансу
node server/balance-cli.mjs --check   # какой конфиг найден, какие пути проверены
node server/balance-cli.mjs --json    # машинный формат
node scripts/mcp-smoke.mjs            # смоук-тест MCP-протокола
node scripts/mcp-smoke.mjs --network  # + реальный запрос с неверным ключом (ждём 401)
```

## «Обновлять после каждого запроса»

Это ограничение платформы: у расширений Zed **нет** хука «после запроса к
модели», нет статус-бара и нет возможности добавить свою панель. Поэтому
автоматического индикатора не бывает в принципе.

Ближайшее рабочее решение — правило для агента: MCP-инструменты модель вызывает
сама. Добавьте в `AGENTS.md` проекта (или в правила профиля):

```markdown
После завершения каждой задачи, прежде чем ответить, вызывай инструмент
`polza_balance` и укажи в ответе доступный остаток Polza.ai.
```

Тогда после каждого хода агента (то есть после запросов к Polza.ai) в ответе
будет свежий остаток. Минус — лишний вызов инструмента на каждый ход; при
необходимости правило можно сделать мягче («раз в задачу»).

## Установка расширения (слеш-команда)

Нужен Rust и target `wasm32-wasip2`:

```bash
rustup target add wasm32-wasip2
```

Затем в Zed: командная палитра → `zed: install dev extension` → выбрать эту папку.
После установки:

- в панели агента появится `/polza-balance`;
- в **Settings → AI → MCP Servers** появится сервер `polza-ai` (его нужно включить) —
  расширение само отдаёт команду запуска, править `settings.json` не надо;
- в диалоге установки расширение попросит настроить `polza.yaml` — впишите ключ в
  файл рядом с расширением.

Расширение подставляет `CARGO_MANIFEST_DIR` на этапе сборки, поэтому оно
рассчитано на установку как dev extension из этой папки. Для публикации в
реестре расширений путь к скрипту нужно будет заменить на путь внутри
extension work dir (или передавать скрипт через `node -e`).

## Где ищется `polza.yaml`

По порядку, первый найденный:

1. `POLZA_CONFIG` (переменная окружения, может быть путём к файлу);
2. `<POLZA_EXTENSION_DIR>/polza.yaml` (задаёт расширение);
3. `polza.yaml` рядом с проектом расширения;
4. `%APPDATA%/Zed/polza.yaml`;
5. `~/.config/zed/polza.yaml`, `~/.zed/polza.yaml`, `~/.polza/polza.yaml`;
6. `polza.yaml` в текущем рабочем каталоге.

`node server/balance-cli.mjs --check` покажет, какой файл выбран и какие пути
проверялись.

## Ограничения и мелочи

- В корпоративной сети с MITM-прокси Node может ругаться
  `SELF_SIGNED_CERT_IN_CHAIN`. Сервер сам переключается на `curl`; альтернатива —
  запускать Node с `--use-system-ca` (Node 22.15+) или задать
  `NODE_EXTRA_CA_CERTS` с корневым сертификатом.
- Ключ лежит в открытом YAML. Не коммитьте `polza.yaml` (он в `.gitignore`);
  для секретов лучше `POLZA_API_KEY` в окружении.
- API-ключ в `polza.yaml` и ключ провайдера в `settings.json`
  (`language_models.openai_compatible.POLZA`) — разные записи, но один и тот же
  ключ Polza.ai.
- Баланс в `available` уже учитывает резерв под выполняющиеся запросы; `amount`
  — полный остаток кошелька. Для «хватит ли денег» ориентируйтесь на `available`.

## Лицензия

Правообладатель — **Gennady Artamonov**.

Использование разрешено (включая рабочие задачи), но **модификация,
распространение, продажа плагина и продуктов на его основе запрещены**.

- `LICENSE` — полный текст, английский (юридически значимый);
- `LICENSE.ru.md` — краткий пересказ по-русски.

Это не open-source-лицензия: опубликовать расширение в реестре Zed с такими
условиями нельзя — плагин ставится как dev extension из локальной папки.

## Структура

```
extension.toml        манифест расширения (слеш-команда)
Cargo.toml            крейт расширения (cdylib → wasm)
src/lib.rs            impl zed::Extension
server/polza-config.mjs   поиск и парсинг polza.yaml
server/polza-balance.mjs  запрос баланса, кэш, формат
server/polza-mcp.mjs      MCP-сервер (stdio JSON-RPC)
server/balance-cli.mjs    CLI
scripts/mcp-smoke.mjs     смоук-тест протокола
polza.yaml            рабочий конфиг (в .gitignore)
settings.snippet.json фрагмент для settings.json Zed
LICENSE               полный текст лицензии (английский)
LICENSE.ru.md         краткий пересказ лицензии по-русски
```
