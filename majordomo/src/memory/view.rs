//! JSON shapes shared by the daemon API and `u2 memory --json`.

use super::search::Page;
use super::{Hit, Link, MemoryIndex};
use crate::vault::Record;
use serde_json::{json, Value};

pub fn summary(r: &Record) -> Value {
    let mut v = json!({
        "id": r.id,
        "type": r.kind.type_name(),
        "name": r.name,
        "path": r.path,
        "classification": r.classification,
    });
    if let Some(status) = &r.status {
        v["status"] = json!(status);
    }
    if r.kind == crate::vault::RecordKind::Owner {
        v["owner"] = json!(true);
    }
    v
}

pub fn full(r: &Record) -> Value {
    let mut v = summary(r);
    let facts: serde_json::Map<String, Value> = r
        .facts
        .iter()
        .map(|(k, f)| {
            (
                k.clone(),
                json!({ "value": f.value, "classification": f.classification }),
            )
        })
        .collect();
    v["idFromFile"] = json!(r.id_from_file);
    v["facts"] = Value::Object(facts);
    v
}

pub fn hit(h: &Hit<'_>) -> Value {
    let mut v = summary(h.record);
    v["score"] = json!(h.score);
    v["matched"] = json!(h.matched);
    if let Some(s) = &h.snippet {
        v["snippet"] = json!(s);
    }
    v
}

pub fn page(p: &Page<'_>) -> Value {
    json!({
        "total": p.total,
        "offset": p.offset,
        "limit": p.limit,
        "items": p.hits.iter().map(hit).collect::<Vec<_>>(),
    })
}

fn link(index: &MemoryIndex, l: &Link, other_is_source: bool) -> Value {
    let mut v = serde_json::to_value(l).unwrap_or(Value::Null);
    let other = if other_is_source {
        index.get(&l.from)
    } else {
        l.to.as_deref().and_then(|id| index.get(id))
    };
    if let Some(o) = other {
        v["otherName"] = json!(o.name);
        v["otherPath"] = json!(o.path);
    }
    v
}

pub fn links(index: &MemoryIndex, r: &Record) -> Value {
    json!({
        "id": r.id,
        "outgoing": index.outgoing(&r.id).iter().map(|l| link(index, l, false)).collect::<Vec<_>>(),
        "backlinks": index.backlinks(&r.id).iter().map(|l| link(index, l, true)).collect::<Vec<_>>(),
    })
}

pub fn vault_status(index: &MemoryIndex) -> Value {
    json!({
        "root": index.vault.root,
        "files": index.vault.files,
        "valid": index.vault.records.len(),
        "invalid": index.vault.invalid,
        "notes": index.vault.notes,
        "links": index.links().len(),
        "dangling": index.dangling().len(),
        "warnings": index.warnings,
    })
}
