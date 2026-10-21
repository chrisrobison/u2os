use super::links::{self, Link};
use crate::vault::{Record, VaultIndex};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Warning {
    pub path: String,
    pub message: String,
}

/// Lower-cased text used by search, computed once per record.
#[derive(Debug)]
pub(super) struct SearchDoc {
    pub id: String,
    pub path: String,
    pub name: String,
    /// (key, lower-cased key, lower-cased value) for every fact except notes
    /// and relationships.
    pub facts: Vec<(String, String, String)>,
    pub notes: String,
}

#[derive(Debug)]
pub struct MemoryIndex {
    pub vault: VaultIndex,
    links: Vec<Link>,
    outgoing: HashMap<String, Vec<usize>>,
    incoming: HashMap<String, Vec<usize>>,
    pub warnings: Vec<Warning>,
    pub(super) docs: Vec<SearchDoc>,
}

impl MemoryIndex {
    pub fn build(vault: VaultIndex) -> Self {
        let mut warnings = Vec::new();
        let mut raw: Vec<Link> = Vec::new();
        for record in &vault.records {
            let mut bad = Vec::new();
            raw.extend(links::extract(record, &mut bad));
            warnings.extend(bad.into_iter().map(|message| Warning {
                path: record.path.clone(),
                message,
            }));
        }

        let mut seen: HashSet<(String, String, String)> = HashSet::new();
        let mut links: Vec<Link> = Vec::new();
        for mut link in raw {
            link.to = vault
                .get(&link.target)
                .or_else(|| vault.by_path(&link.target))
                .map(|r| r.id.clone());
            if seen.insert((
                link.from.clone(),
                link.predicate.clone(),
                link.target.clone(),
            )) {
                links.push(link);
            }
        }

        let mut outgoing: HashMap<String, Vec<usize>> = HashMap::new();
        let mut incoming: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, link) in links.iter().enumerate() {
            outgoing.entry(link.from.clone()).or_default().push(i);
            if let Some(to) = &link.to {
                incoming.entry(to.clone()).or_default().push(i);
            }
        }

        let docs = vault.records.iter().map(search_doc).collect();
        MemoryIndex {
            vault,
            links,
            outgoing,
            incoming,
            warnings,
            docs,
        }
    }

    pub fn get(&self, id: &str) -> Option<&Record> {
        self.vault.get(id)
    }

    pub fn links(&self) -> &[Link] {
        &self.links
    }

    pub fn outgoing(&self, id: &str) -> Vec<&Link> {
        self.pick(self.outgoing.get(id))
    }

    pub fn backlinks(&self, id: &str) -> Vec<&Link> {
        self.pick(self.incoming.get(id))
    }

    /// Links whose target matches no record.
    pub fn dangling(&self) -> Vec<&Link> {
        self.links.iter().filter(|l| l.to.is_none()).collect()
    }

    fn pick(&self, idx: Option<&Vec<usize>>) -> Vec<&Link> {
        idx.map(|v| v.iter().map(|&i| &self.links[i]).collect())
            .unwrap_or_default()
    }
}

fn search_doc(record: &Record) -> SearchDoc {
    let facts = record
        .facts
        .iter()
        .filter(|(k, _)| k.as_str() != "notes" && k.as_str() != "relationships")
        .map(|(k, f)| {
            (
                k.clone(),
                k.to_lowercase(),
                value_text(&f.value).to_lowercase(),
            )
        })
        .collect();
    let notes = record
        .facts
        .get("notes")
        .and_then(|f| f.value.as_str())
        .unwrap_or("")
        .to_lowercase();
    SearchDoc {
        id: record.id.to_lowercase(),
        path: record.path.to_lowercase(),
        name: record.name.to_lowercase(),
        facts,
        notes,
    }
}

pub(super) fn value_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}
