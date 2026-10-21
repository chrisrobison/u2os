use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Where the vault lives, with the same precedence as Node's `getVaultDir()`:
/// `U2OS_VAULT`, then `config/config.json` `vaultDir` (relative paths resolve
/// against the home), then `<home>/vault`. Reads only; never creates anything.
pub fn locate(home: &Path, env_vault: Option<OsString>) -> PathBuf {
    if let Some(v) = env_vault.filter(|v| !v.is_empty()) {
        return absolutize(Path::new(&v), None);
    }
    if let Ok(text) = std::fs::read_to_string(home.join("config").join("config.json")) {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(dir) = config.get("vaultDir").and_then(|v| v.as_str()) {
                if !dir.trim().is_empty() {
                    return absolutize(Path::new(dir), Some(home));
                }
            }
        }
    }
    home.join("vault")
}

fn absolutize(path: &Path, base: Option<&Path>) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else if let Some(base) = base {
        base.join(path)
    } else {
        std::env::current_dir()
            .map(|d| d.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precedence_env_then_config_then_default() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        assert_eq!(locate(home, None), home.join("vault"));

        std::fs::create_dir_all(home.join("config")).unwrap();
        std::fs::write(home.join("config/config.json"), r#"{"vaultDir":"notes"}"#).unwrap();
        assert_eq!(locate(home, None), home.join("notes"));

        std::fs::write(
            home.join("config/config.json"),
            r#"{"vaultDir":"/abs/vault"}"#,
        )
        .unwrap();
        assert_eq!(locate(home, None), PathBuf::from("/abs/vault"));

        assert_eq!(
            locate(home, Some("/env/vault".into())),
            PathBuf::from("/env/vault")
        );
    }

    #[test]
    fn broken_or_blank_config_falls_back_to_default() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        std::fs::create_dir_all(home.join("config")).unwrap();
        std::fs::write(home.join("config/config.json"), "{not json").unwrap();
        assert_eq!(locate(home, None), home.join("vault"));
        std::fs::write(home.join("config/config.json"), r#"{"vaultDir":"  "}"#).unwrap();
        assert_eq!(locate(home, None), home.join("vault"));
    }
}
