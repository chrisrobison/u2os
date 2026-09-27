// Minimal semantic-version parsing and range checks for package
// dependencies (docs/plugin-architecture.md §5). Deliberately not an npm
// solver: a dependency is satisfied when the one installed version matches
// its range. Supported ranges: "*", exact "1.2.3" / "=1.2.3", comparators
// (>, >=, <, <=), caret "^1.2", tilde "~1.2", and space-separated
// conjunctions (">=1.0 <2.0"). Partial versions ("1", "1.2") fill with 0.

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const PARTIAL = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(text) {
  const match = VERSION.exec(String(text ?? '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] || null };
}

export function isValidVersion(text) {
  return parseVersion(text) !== null;
}

function parsePartial(text) {
  const match = PARTIAL.exec(String(text ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? null : Number(match[2]),
    patch: match[3] === undefined ? null : Number(match[3]),
    pre: match[4] || null,
  };
}

export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  if (!left || !right) throw new Error(`Invalid version comparison: ${a} vs ${b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1; // release > prerelease
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/** Returns a list of {op, version} comparators, or throws on an invalid range. */
export function parseRange(range) {
  const text = String(range ?? '*').trim();
  if (text === '' || text === '*' || text === 'x' || text === 'latest') return [];
  const comparators = [];
  for (const part of text.split(/\s+/)) {
    const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(part);
    const partial = match && parsePartial(match[2]);
    if (!partial) throw new Error(`Invalid version range: ${range}`);
    const base = { major: partial.major, minor: partial.minor ?? 0, patch: partial.patch ?? 0, pre: partial.pre };
    const op = match[1] || '=';
    if (op === '^') {
      comparators.push({ op: '>=', version: base });
      const upper = base.major > 0 || partial.minor === null ? { major: base.major + 1, minor: 0, patch: 0 }
        : base.minor > 0 || partial.patch === null ? { major: 0, minor: base.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: base.patch + 1 };
      comparators.push({ op: '<', version: { ...upper, pre: null } });
    } else if (op === '~') {
      comparators.push({ op: '>=', version: base });
      const upper = partial.minor === null ? { major: base.major + 1, minor: 0, patch: 0 } : { major: base.major, minor: base.minor + 1, patch: 0 };
      comparators.push({ op: '<', version: { ...upper, pre: null } });
    } else if (op === '=' && (partial.minor === null || partial.patch === null)) {
      // "1" or "1.2" means any version in that line.
      comparators.push({ op: '>=', version: base });
      const upper = partial.minor === null ? { major: base.major + 1, minor: 0, patch: 0 } : { major: base.major, minor: base.minor + 1, patch: 0 };
      comparators.push({ op: '<', version: { ...upper, pre: null } });
    } else {
      comparators.push({ op, version: base });
    }
  }
  return comparators;
}

export function isValidRange(range) {
  try { parseRange(range); return true; } catch { return false; }
}

export function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  let comparators;
  try { comparators = parseRange(range); } catch { return false; }
  return comparators.every(({ op, version: bound }) => {
    const cmp = compareVersions(parsed, bound);
    switch (op) {
      case '>': return cmp > 0;
      case '>=': return cmp >= 0;
      case '<': return cmp < 0;
      case '<=': return cmp <= 0;
      default: return cmp === 0;
    }
  });
}
