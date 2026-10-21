//! Frontmatter + body split, matching `server/vault/markdown.js`.

use super::VaultError;
use regex::Regex;
use serde_json::{Map, Number, Value};
use serde_yaml_ng::Value as Yaml;
use std::sync::OnceLock;

pub const MAX_VAULT_FILE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub frontmatter: Map<String, Value>,
    pub body: String,
}

fn frontmatter_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Same pattern as Node: lazy, requires a newline before the closing
        // fence, and the fence may be followed by blanks then a newline or EOF.
        Regex::new(r"(?s)\A---\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\z)")
            .unwrap_or_else(|e| unreachable!("static regex is valid: {e}"))
    })
}

pub fn parse_markdown(text: &str) -> Result<Parsed, VaultError> {
    let source = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(caps) = frontmatter_re().captures(source) else {
        return Ok(Parsed {
            frontmatter: Map::new(),
            body: source.trim().to_string(),
        });
    };
    let whole = caps.get(0).map_or(0, |m| m.end());
    let yaml_text = caps.get(1).map_or("", |m| m.as_str());
    let value: Yaml = serde_yaml_ng::from_str(yaml_text)
        .map_err(|e| VaultError::new(format!("Invalid YAML frontmatter: {e}")))?;
    let frontmatter = match to_json(&value)? {
        Value::Null => Map::new(),
        Value::Object(map) => map,
        _ => {
            return Err(VaultError::new(
                "Frontmatter must be a mapping of keys to values",
            ))
        }
    };
    Ok(Parsed {
        frontmatter,
        body: source[whole..].trim().to_string(),
    })
}

/// Plain YAML types only: no custom tags, dates stay strings (YAML core schema).
fn to_json(value: &Yaml) -> Result<Value, VaultError> {
    Ok(match value {
        Yaml::Null => Value::Null,
        Yaml::Bool(b) => Value::Bool(*b),
        Yaml::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Number(i.into())
            } else if let Some(u) = n.as_u64() {
                Value::Number(u.into())
            } else {
                // Non-finite floats become null, as `JSON.stringify` does in Node.
                n.as_f64()
                    .and_then(Number::from_f64)
                    .map_or(Value::Null, Value::Number)
            }
        }
        Yaml::String(s) => Value::String(s.clone()),
        Yaml::Sequence(items) => Value::Array(items.iter().map(to_json).collect::<Result<_, _>>()?),
        Yaml::Mapping(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                out.insert(key_text(k)?, to_json(v)?);
            }
            Value::Object(out)
        }
        Yaml::Tagged(_) => return Err(VaultError::new("Custom YAML tags are not allowed")),
    })
}

fn key_text(key: &Yaml) -> Result<String, VaultError> {
    match key {
        Yaml::String(s) => Ok(s.clone()),
        Yaml::Bool(b) => Ok(b.to_string()),
        Yaml::Null => Ok("null".to_string()),
        Yaml::Number(n) => Ok(n.to_string()),
        _ => Err(VaultError::new("Frontmatter keys must be plain scalars")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plain_types_dates_stay_strings() {
        let p = parse_markdown(
            "---\nname: Alice\nbirthday: 1990-05-01\ntags: [a, b]\n---\n# Alice\nLikes tea.\n",
        )
        .unwrap();
        assert_eq!(
            Value::Object(p.frontmatter),
            json!({"name":"Alice","birthday":"1990-05-01","tags":["a","b"]})
        );
        assert_eq!(p.body, "# Alice\nLikes tea.");
    }

    #[test]
    fn no_frontmatter_is_all_body() {
        let p = parse_markdown("Just notes.").unwrap();
        assert!(p.frontmatter.is_empty());
        assert_eq!(p.body, "Just notes.");
    }

    #[test]
    fn bom_and_crlf() {
        let p = parse_markdown("\u{feff}---\r\nname: A\r\n---\r\nbody\r\n").unwrap();
        assert_eq!(p.frontmatter["name"], "A");
        assert_eq!(p.body, "body");
    }

    #[test]
    fn closing_fence_without_trailing_newline() {
        let p = parse_markdown("---\nname: A\n---").unwrap();
        assert_eq!(p.frontmatter["name"], "A");
        assert_eq!(p.body, "");
    }

    #[test]
    fn empty_frontmatter_block_is_body_like_node() {
        // `---\n---\n` has no newline before the closing fence, so Node's
        // pattern does not match and the text is treated as body.
        let p = parse_markdown("---\n---\ntext").unwrap();
        assert!(p.frontmatter.is_empty());
        assert_eq!(p.body, "---\n---\ntext");
    }

    #[test]
    fn errors() {
        assert!(parse_markdown("---\nname: [unclosed\n---\n")
            .unwrap_err()
            .0
            .contains("Invalid YAML"));
        assert!(parse_markdown("---\n- a\n- b\n---\n")
            .unwrap_err()
            .0
            .contains("mapping"));
        assert!(
            parse_markdown("---\nname: !custom x\n---\n").is_err(),
            "custom tags are rejected"
        );
        assert!(
            parse_markdown("---\na: 1\na: 2\n---\n").is_err(),
            "duplicate keys are invalid"
        );
    }

    #[test]
    fn numeric_and_bool_keys_become_strings() {
        let p = parse_markdown("---\n1: one\ntrue: yes-ish\n---\n").unwrap();
        assert_eq!(p.frontmatter["1"], "one");
        assert_eq!(p.frontmatter["true"], "yes-ish");
    }
}
