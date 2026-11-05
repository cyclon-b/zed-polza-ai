//! Расширение Zed для Polza.ai.
//!
//! Даёт слеш-команду `/polza_balance` в панели агента. Тяжёлую часть
//! (чтение polza.yaml, запрос баланса) делает Node-скрипт `server/balance-cli.mjs`:
//! у WASM-расширения нет доступа к файловой системе и своему окружению.
//!
//! Примечание: `CARGO_MANIFEST_DIR` подставляется на этапе сборки, поэтому
//! расширение рассчитано на установку как dev extension из этой папки.

use zed_extension_api as zed;
use zed_extension_api::process::Command;
use zed_extension_api::{SlashCommand, SlashCommandOutput, SlashCommandOutputSection};

const BALANCE_COMMAND: &str = "polza_balance";

struct PolzaAi;

impl PolzaAi {
    fn extension_dir() -> String {
        env!("CARGO_MANIFEST_DIR").to_string()
    }

    fn node_binary(worktree: Option<&zed::Worktree>) -> String {
        worktree
            .and_then(|worktree| worktree.which("node"))
            .unwrap_or_else(|| "node".to_string())
    }

    fn run_node(
        worktree: Option<&zed::Worktree>,
        script: &str,
        args: &[String],
    ) -> Result<String, String> {
        let script_path = format!("{}/{}", Self::extension_dir(), script);
        let output = Command::new(Self::node_binary(worktree))
            .arg(script_path)
            .args(args.iter().cloned())
            .env("POLZA_EXTENSION_DIR", Self::extension_dir())
            .output()?;

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

        match output.status {
            Some(0) => Ok(stdout),
            _ => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if !stdout.is_empty() {
                    Ok(stdout)
                } else if !stderr.is_empty() {
                    Err(stderr)
                } else {
                    Err("Node завершился с ошибкой без вывода".to_string())
                }
            }
        }
    }
}

impl zed::Extension for PolzaAi {
    fn new() -> Self {
        Self
    }

    fn run_slash_command(
        &self,
        command: SlashCommand,
        _args: Vec<String>,
        worktree: Option<&zed::Worktree>,
    ) -> Result<SlashCommandOutput, String> {
        if command.name != BALANCE_COMMAND {
            return Err(format!("Неизвестная команда расширения: {}", command.name));
        }

        let text = Self::run_node(worktree, "server/balance-cli.mjs", &[])?;

        Ok(SlashCommandOutput {
            sections: vec![SlashCommandOutputSection {
                range: 0..text.len(),
                label: "Баланс Polza.ai".to_string(),
            }],
            text,
        })
    }

    /// MCP-сервер, который Zed запускает после установки расширения.
    /// Регистрируется в extension.toml как `[context_servers.polza-ai]`.
    fn context_server_command(
        &mut self,
        _context_server_id: &zed::ContextServerId,
        _project: &zed::Project,
    ) -> Result<zed::Command, String> {
        Ok(zed::Command::new(Self::node_binary(None))
            .arg(format!("{}/server/polza-mcp.mjs", Self::extension_dir()))
            .env("POLZA_EXTENSION_DIR", Self::extension_dir()))
    }

    /// Подсказка в модалке установки: без ключа баланс не запросится.
    fn context_server_configuration(
        &mut self,
        _context_server_id: &zed::ContextServerId,
        _project: &zed::Project,
    ) -> Result<Option<zed::ContextServerConfiguration>, String> {
        Ok(Some(zed::ContextServerConfiguration {
            installation_instructions: "Впишите `api_key` в `polza.yaml` рядом с папкой расширения и включите сервер в Settings → AI → MCP Servers.".to_string(),
            settings_schema: r#"{"type":"object","properties":{}}"#.to_string(),
            default_settings: "{}".to_string(),
        }))
    }
}

zed::register_extension!(PolzaAi);
