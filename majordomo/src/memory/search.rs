use super::index::{value_text, MemoryIndex};
use crate::vault::{Classification, Record};

pub const MAX_QUERY_CHARS: usize = 256;
pub const MAX_TERMS: usize = 8;
pub const DEFAULT_LIMIT: usize = 50;
pub const MAX_LIMIT: usize = 500;

/// A list/search request. With no terms it is a filtered listing.
#[derive(Debug, Clone, Default)]
pub struct Query {
    /// Every term must match somewhere (case-insensitive substring).
    pub terms: Vec<String>,
    /// Entity type name, e.g. `Person`.
    pub type_name: Option<String>,
    pub classification: Option<Classification>,
    /// `fact key == value` filters (value compared case-insensitively).
    pub facts: Vec<(String, String)>,
    pub limit: usize,
    pub offset: usize,
}

impl Query {
    /// Split free text into terms; rejects over-long or over-complex input.
    pub fn with_text(mut self, text: &str) -> Result<Self, String> {
        if text.chars().count() > MAX_QUERY_CHARS {
            return Err(format!("query is longer than {MAX_QUERY_CHARS} characters"));
        }
        self.terms = text.split_whitespace().map(str::to_lowercase).collect();
        if self.terms.len() > MAX_TERMS {
            return Err(format!("query has more than {MAX_TERMS} terms"));
        }
        Ok(self)
    }

    fn effective_limit(&self) -> usize {
        match self.limit {
            0 => DEFAULT_LIMIT,
            n => n.min(MAX_LIMIT),
        }
    }
}

#[derive(Debug)]
pub struct Hit<'a> {
    pub record: &'a Record,
    pub score: u32,
    /// Where terms matched: `name`, `path`, `id`, `fact:<key>`, `notes`.
    pub matched: Vec<String>,
    pub snippet: Option<String>,
}

#[derive(Debug)]
pub struct Page<'a> {
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub hits: Vec<Hit<'a>>,
}

impl MemoryIndex {
    pub fn search(&self, query: &Query) -> Page<'_> {
        let mut hits: Vec<Hit<'_>> = Vec::new();
        for (record, doc) in self.vault.records.iter().zip(&self.docs) {
            if let Some(t) = &query.type_name {
                if !record.kind.type_name().eq_ignore_ascii_case(t) {
                    continue;
                }
            }
            if query
                .classification
                .is_some_and(|c| c != record.classification)
            {
                continue;
            }
            if !query.facts.iter().all(|(k, v)| {
                record
                    .facts
                    .get(k)
                    .is_some_and(|f| value_text(&f.value).eq_ignore_ascii_case(v))
            }) {
                continue;
            }

            let mut score = 0u32;
            let mut matched: Vec<String> = Vec::new();
            let mut all = true;
            for term in &query.terms {
                let mut hit = false;
                let mut add = |label: String, weight: u32, hit: &mut bool| {
                    score += weight;
                    if !matched.contains(&label) {
                        matched.push(label);
                    }
                    *hit = true;
                };
                if doc.name.contains(term) {
                    add("name".into(), 10, &mut hit);
                }
                if doc.id.contains(term) {
                    add("id".into(), 3, &mut hit);
                }
                if doc.path.contains(term) {
                    add("path".into(), 3, &mut hit);
                }
                for (key, key_lc, value_lc) in &doc.facts {
                    if value_lc.contains(term) || key_lc.contains(term) {
                        add(format!("fact:{key}"), 2, &mut hit);
                    }
                }
                if doc.notes.contains(term) {
                    add("notes".into(), 1, &mut hit);
                }
                if !hit {
                    all = false;
                    break;
                }
            }
            if !all {
                continue;
            }
            let snippet = if matched.iter().any(|m| m == "notes") {
                snippet(record, &query.terms)
            } else {
                None
            };
            hits.push(Hit {
                record,
                score,
                matched,
                snippet,
            });
        }

        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then_with(|| {
                    a.record
                        .name
                        .to_lowercase()
                        .cmp(&b.record.name.to_lowercase())
                })
                .then_with(|| a.record.path.cmp(&b.record.path))
        });
        let total = hits.len();
        let limit = query.effective_limit();
        let hits = hits.into_iter().skip(query.offset).take(limit).collect();
        Page {
            total,
            offset: query.offset,
            limit,
            hits,
        }
    }
}

/// About 80 characters of notes around the first matching term.
fn snippet(record: &Record, terms: &[String]) -> Option<String> {
    let notes = record.facts.get("notes")?.value.as_str()?;
    let chars: Vec<char> = notes.chars().collect();
    let lowered: Vec<char> = notes.to_lowercase().chars().collect();
    let at = terms
        .iter()
        .filter_map(|t| find(&lowered, &t.chars().collect::<Vec<_>>()))
        .min()?;
    let start = at.saturating_sub(30).min(chars.len());
    let end = (at + 50).min(chars.len());
    let mut s: String = chars[start..end]
        .iter()
        .collect::<String>()
        .replace(['\n', '\r'], " ");
    if start > 0 {
        s.insert(0, '…');
    }
    if end < chars.len() {
        s.push('…');
    }
    Some(s)
}

fn find(haystack: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}
