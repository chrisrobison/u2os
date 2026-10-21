//! Interpretation of one parsed vault file, matching `describe()` in
//! `server/vault/indexer.js`.

use super::{Parsed, VaultError};
use indexmap::IndexMap;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const RESERVED_KEYS: [&str; 6] = [
    "id",
    "name",
    "title",
    "classification",
    "sensitive_keys",
    "classifications",
];
const MAX_KEY_LENGTH: usize = 100;
const MAX_VALUE_CHARS: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Classification {
    Public,
    Personal,
    Private,
    Sensitive,
}

impl Classification {
    fn parse(value: &Value) -> Option<Self> {
        match value.as_str()? {
            "public" => Some(Self::Public),
            "personal" => Some(Self::Personal),
            "private" => Some(Self::Private),
            "sensitive" => Some(Self::Sensitive),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum RecordKind {
    /// `me.md`: the owner. Node links it to the owner account's entity.
    Owner,
    Person,
    Project,
    Commitment,
}

impl RecordKind {
    /// The entity type name Node stores (the owner is a `Person`).
    pub fn type_name(self) -> &'static str {
        match self {
            Self::Owner | Self::Person => "Person",
            Self::Project => "Project",
            Self::Commitment => "Commitment",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Fact {
    pub value: Value,
    pub classification: Classification,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Record {
    /// A valid `id:` from the file, else the path-derived id Node uses.
    pub id: String,
    pub id_from_file: bool,
    /// Vault-relative, `/`-separated.
    pub path: String,
    pub kind: RecordKind,
    pub name: String,
    pub classification: Classification,
    pub facts: IndexMap<String, Fact>,
    /// Commitments only: `open` unless the file says otherwise.
    pub status: Option<String>,
}

/// `ent_vault_` plus the first 20 hex chars of SHA-256 of the relative path:
/// the identity Node gives a file without `id:`.
pub fn path_derived_id(relative_path: &str) -> String {
    let digest = Sha256::digest(relative_path.as_bytes());
    let mut hex = String::with_capacity(40);
    for byte in digest.iter().take(10) {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("ent_vault_{hex}")
}

pub fn describe(
    relative_path: &str,
    kind: RecordKind,
    parsed: &Parsed,
) -> Result<Record, VaultError> {
    let fm = &parsed.frontmatter;
    let body = &parsed.body;

    let classification = match fm.get("classification") {
        None | Some(Value::Null) => Classification::Personal,
        Some(v) => Classification::parse(v).ok_or_else(|| {
            VaultError::new("classification must be public, personal, private, or sensitive")
        })?,
    };

    let sensitive_keys: Vec<&str> = match fm.get("sensitive_keys") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .ok_or_else(|| VaultError::new("sensitive_keys must be a list of key names"))
            })
            .collect::<Result<_, _>>()?,
        Some(_) => {
            return Err(VaultError::new(
                "sensitive_keys must be a list of key names",
            ))
        }
    };

    let per_key: IndexMap<&str, Classification> = match fm.get("classifications") {
        None | Some(Value::Null) => IndexMap::new(),
        Some(Value::Object(map)) => map
            .iter()
            .map(|(k, v)| {
                Classification::parse(v).map(|c| (k.as_str(), c)).ok_or_else(|| {
                    VaultError::new("classifications must map keys to public, personal, private, or sensitive")
                })
            })
            .collect::<Result<_, _>>()?,
        Some(_) => {
            return Err(VaultError::new(
                "classifications must map keys to public, personal, private, or sensitive",
            ))
        }
    };
    let level_for = |key: &str| -> Classification {
        if sensitive_keys.contains(&key) {
            Classification::Sensitive
        } else {
            per_key.get(key).copied().unwrap_or(classification)
        }
    };

    let bound_id = match fm.get("id") {
        None => None,
        Some(v) => {
            let text = match v {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                Value::Null => "null".to_string(),
                _ => return Err(invalid_id()),
            };
            if !valid_bound_id(&text) {
                return Err(invalid_id());
            }
            Some(text)
        }
    };

    let name = scalar_text(fm.get("name"))
        .or_else(|| scalar_text(fm.get("title")))
        .or_else(|| heading(body))
        .unwrap_or_else(|| humanize(relative_path));

    let mut facts: IndexMap<String, Fact> = IndexMap::new();
    let mut status_value: Option<Value> = None;
    for (raw_key, value) in fm {
        let key = raw_key.trim();
        if key.is_empty() || RESERVED_KEYS.contains(&key) || value.is_null() {
            continue;
        }
        if utf16_len(key) > MAX_KEY_LENGTH {
            let head: String = key.chars().take(20).collect();
            return Err(VaultError::new(format!(
                "Key \"{head}…\" is longer than {MAX_KEY_LENGTH} characters"
            )));
        }
        let encoded = serde_json::to_string(value).unwrap_or_default();
        if utf16_len(&encoded) > MAX_VALUE_CHARS {
            return Err(VaultError::new(format!("Value for \"{key}\" is too large")));
        }
        if kind == RecordKind::Commitment && key == "status" {
            status_value = Some(value.clone());
        }
        facts.insert(
            key.to_string(),
            Fact {
                value: value.clone(),
                classification: level_for(key),
            },
        );
    }
    if kind == RecordKind::Owner {
        if let Some(n) = scalar_text(fm.get("name")) {
            facts.insert(
                "name".into(),
                Fact {
                    value: Value::String(n),
                    classification: level_for("name"),
                },
            );
        }
    }
    if !body.is_empty() {
        if utf16_len(body) > MAX_VALUE_CHARS {
            return Err(VaultError::new("Notes are too large"));
        }
        facts.insert(
            "notes".into(),
            Fact {
                value: Value::String(body.clone()),
                classification: level_for("notes"),
            },
        );
    }

    let status = (kind == RecordKind::Commitment).then(|| match status_value {
        None => "open".to_string(),
        Some(Value::String(s)) => s,
        Some(other) => other.to_string(),
    });

    let derived = path_derived_id(relative_path);
    Ok(Record {
        id: bound_id.clone().unwrap_or(derived),
        id_from_file: bound_id.is_some(),
        path: relative_path.to_string(),
        kind,
        name,
        classification,
        facts,
        status,
    })
}

fn invalid_id() -> VaultError {
    VaultError::new("id must be an existing record id such as ent_abc123 (or a UUID)")
}

/// Node's record ids (`ent_` + up to 64 of `[A-Za-z0-9_]`), or a hyphenated UUID.
fn valid_bound_id(text: &str) -> bool {
    if let Some(rest) = text.strip_prefix("ent_") {
        return (1..=64).contains(&rest.len())
            && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    }
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn scalar_text(value: Option<&Value>) -> Option<String> {
    let text = match value? {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string().trim().to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn heading(body: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?m)^#\s+([^\n\r\u{2028}\u{2029}]+)")
            .unwrap_or_else(|e| unreachable!("static regex is valid: {e}"))
    });
    let text = re.captures(body)?.get(1)?.as_str().trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// `people/alice-chen.md` -> `Alice Chen` (ASCII word boundaries, as in Node).
fn humanize(relative_path: &str) -> String {
    let base = relative_path.rsplit('/').next().unwrap_or(relative_path);
    let stem = base.strip_suffix(".md").unwrap_or(base);
    let mut spaced = String::new();
    let mut in_sep = false;
    for c in stem.chars() {
        if c == '-' || c == '_' {
            if !in_sep {
                spaced.push(' ');
            }
            in_sep = true;
        } else {
            in_sep = false;
            spaced.push(c);
        }
    }
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::new();
    let mut prev_word = false;
    for c in spaced.chars() {
        let word = is_word(c);
        if word && !prev_word {
            out.push(c.to_ascii_uppercase());
        } else {
            out.push(c);
        }
        prev_word = word;
    }
    out.trim().to_string()
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::parse_markdown;

    fn rec(path: &str, kind: RecordKind, text: &str) -> Result<Record, VaultError> {
        describe(path, kind, &parse_markdown(text).unwrap())
    }

    #[test]
    fn path_id_matches_node() {
        // sha256("people/alice-chen.md")[..20], computed by Node's vaultEntityId.
        let id = path_derived_id("people/alice-chen.md");
        assert!(id.starts_with("ent_vault_") && id.len() == 10 + 20, "{id}");
    }

    #[test]
    fn humanizes_file_names() {
        assert_eq!(humanize("people/alice-chen.md"), "Alice Chen");
        assert_eq!(humanize("projects/house__reno.md"), "House Reno");
    }

    #[test]
    fn name_fallback_order() {
        let r = rec(
            "people/a-b.md",
            RecordKind::Person,
            "---\ntitle: T\n---\n# H",
        )
        .unwrap();
        assert_eq!(r.name, "T");
        let r = rec("people/a-b.md", RecordKind::Person, "# Heading\nbody").unwrap();
        assert_eq!(r.name, "Heading");
        let r = rec("people/a-b.md", RecordKind::Person, "just text").unwrap();
        assert_eq!(r.name, "A B");
    }

    #[test]
    fn classification_rules() {
        let r = rec(
            "people/x.md",
            RecordKind::Person,
            "---\nname: X\nclassification: private\nsensitive_keys: [phone]\nclassifications: {email: public}\nphone: '1'\nemail: e\ncity: c\n---\n",
        )
        .unwrap();
        assert_eq!(r.classification, Classification::Private);
        assert_eq!(r.facts["phone"].classification, Classification::Sensitive);
        assert_eq!(r.facts["email"].classification, Classification::Public);
        assert_eq!(r.facts["city"].classification, Classification::Private);
        assert!(rec(
            "people/x.md",
            RecordKind::Person,
            "---\nclassification: secret\n---\n"
        )
        .is_err());
        assert!(rec(
            "people/x.md",
            RecordKind::Person,
            "---\nsensitive_keys: phone\n---\n"
        )
        .is_err());
        assert!(rec(
            "people/x.md",
            RecordKind::Person,
            "---\nclassifications: {a: nope}\n---\n"
        )
        .is_err());
    }

    #[test]
    fn ids() {
        let r = rec(
            "people/x.md",
            RecordKind::Person,
            "---\nid: ent_abc123\n---\n",
        )
        .unwrap();
        assert_eq!((r.id.as_str(), r.id_from_file), ("ent_abc123", true));
        assert!(rec(
            "people/x.md",
            RecordKind::Person,
            "---\nid: 0199f03a-7c36-7000-8000-000000000001\n---\n"
        )
        .is_ok());
        assert!(rec("people/x.md", RecordKind::Person, "---\nid: ../etc\n---\n").is_err());
        assert!(
            rec("people/x.md", RecordKind::Person, "---\nid:\n---\n").is_err(),
            "null id is invalid, as in Node"
        );
    }

    #[test]
    fn commitment_status_and_facts() {
        let r = rec(
            "commitments/c.md",
            RecordKind::Commitment,
            "---\ntitle: Send report\ndue: 2026-10-01\n---\n",
        )
        .unwrap();
        assert_eq!(r.status.as_deref(), Some("open"));
        assert_eq!(r.facts["due"].value, "2026-10-01");
        let r = rec(
            "commitments/c.md",
            RecordKind::Commitment,
            "---\nstatus: done\n---\nnote",
        )
        .unwrap();
        assert_eq!(r.status.as_deref(), Some("done"));
        assert_eq!(r.facts["notes"].value, "note");
    }

    #[test]
    fn owner_gets_a_name_fact_and_null_values_are_skipped() {
        let r = rec(
            "me.md",
            RecordKind::Owner,
            "---\nname: Chris\nnothing:\n---\n",
        )
        .unwrap();
        assert_eq!(r.facts["name"].value, "Chris");
        assert!(!r.facts.contains_key("nothing"));
        let r = rec("people/p.md", RecordKind::Person, "---\nname: P\n---\n").unwrap();
        assert!(
            !r.facts.contains_key("name"),
            "name is reserved for non-owner files"
        );
    }

    #[test]
    fn size_limits() {
        let long_key = "k".repeat(101);
        assert!(rec(
            "people/x.md",
            RecordKind::Person,
            &format!("---\n{long_key}: 1\n---\n")
        )
        .is_err());
        assert!(rec(
            "people/x.md",
            RecordKind::Person,
            &format!("---\nk: {}\n---\n", "v".repeat(20_001))
        )
        .is_err());
        assert!(rec("people/x.md", RecordKind::Person, &"n".repeat(20_001)).is_err());
    }
}
