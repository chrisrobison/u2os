//! Relationships between records: typed `relationships:` entries in the
//! frontmatter and inline `[text](u2os:TARGET)` links in the body.
//!
//! A target resolves by record id first, then by vault-relative path. A target
//! that resolves to nothing is kept and reported as dangling; two names that
//! merely appear in the same document are never linked.

use crate::vault::Record;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

pub const INLINE_PREDICATE: &str = "links_to";
const MAX_TARGET_CHARS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    Typed,
    Inline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Link {
    pub from: String,
    pub predicate: String,
    pub kind: LinkKind,
    /// The target exactly as written.
    pub target: String,
    /// The record it resolved to, if any.
    pub to: Option<String>,
    /// Link text for inline links.
    pub text: Option<String>,
}

/// Extract the links one record declares. `bad` collects entries that were
/// ignored, with a reason.
pub fn extract(record: &Record, bad: &mut Vec<String>) -> Vec<Link> {
    let mut out = Vec::new();

    if let Some(fact) = record.facts.get("relationships") {
        match &fact.value {
            Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    match typed_entry(item) {
                        Some((predicate, target)) => out.push(Link {
                            from: record.id.clone(),
                            predicate,
                            kind: LinkKind::Typed,
                            target,
                            to: None,
                            text: None,
                        }),
                        None => bad.push(format!(
                            "relationships[{i}] ignored: expected {{predicate, target}} with a lowercase predicate"
                        )),
                    }
                }
            }
            _ => bad.push("relationships ignored: expected a list".to_string()),
        }
    }

    if let Some(notes) = record.facts.get("notes").and_then(|f| f.value.as_str()) {
        for (text, target) in inline_links(notes) {
            out.push(Link {
                from: record.id.clone(),
                predicate: INLINE_PREDICATE.to_string(),
                kind: LinkKind::Inline,
                target,
                to: None,
                text: Some(text),
            });
        }
    }
    out
}

fn typed_entry(item: &Value) -> Option<(String, String)> {
    let obj = item.as_object()?;
    let predicate = obj.get("predicate")?.as_str()?;
    let target = obj.get("target")?.as_str()?.trim();
    valid_predicate(predicate).then_some(())?;
    valid_target(target).then_some(())?;
    Some((predicate.to_string(), target.to_string()))
}

fn valid_predicate(p: &str) -> bool {
    let mut chars = p.chars();
    matches!(chars.next(), Some('a'..='z'))
        && p.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn valid_target(t: &str) -> bool {
    !t.is_empty() && t.chars().count() <= MAX_TARGET_CHARS && !t.chars().any(char::is_control)
}

/// `[text](u2os:TARGET)` and `<u2os:TARGET>` outside fenced code blocks.
fn inline_links(markdown: &str) -> Vec<(String, String)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"\[([^\]\n]*)\]\(u2os:([^)\s]+)\)|<u2os:([^>\s]+)>")
            .unwrap_or_else(|e| unreachable!("static regex is valid: {e}"))
    });
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        for caps in re.captures_iter(line) {
            let (text, target) = match (caps.get(1), caps.get(2), caps.get(3)) {
                (Some(t), Some(g), _) => (t.as_str().to_string(), g.as_str()),
                (_, _, Some(g)) => (String::new(), g.as_str()),
                _ => continue,
            };
            if valid_target(target) {
                out.push((text, target.to_string()));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_inline_links_and_skips_code() {
        let md = "See [Alice](u2os:ent_alice) and <u2os:projects/house.md>.\n```\n[no](u2os:ent_code)\n```\nplain [web](https://x.test)";
        let found = inline_links(md);
        assert_eq!(
            found,
            vec![
                ("Alice".to_string(), "ent_alice".to_string()),
                (String::new(), "projects/house.md".to_string())
            ]
        );
    }

    #[test]
    fn predicates_are_lowercase_identifiers() {
        assert!(valid_predicate("created_by"));
        assert!(!valid_predicate("Created By"));
        assert!(!valid_predicate(""));
    }
}
