// U2OS docs browser -- static, client-side only. No build step, no server code.
// Fetches the markdown files listed in DOC_FILES (relative to this page's
// parent directory, i.e. ../docs/*.md), renders them with a small hand-rolled
// markdown-to-HTML converter, and routes between them via location.hash.
//
// Requires the page to be served over http(s) (fetch() of local files is
// blocked from file:// in most browsers) -- see README.md next to this file.

'use strict';

// Curated reading order. Add new docs/*.md files here to make them show up.
const DOC_FILES = [
  'overview.md',
  'architecture.md',
  'models.md',
  'tools.md',
  'policies.md',
  'events.md',
  'automation.md',
  'connectors.md',
  'dashboards.md',
  'voice.md',
  'feedback.md',
  'deployment.md',
];

/** @type {Map<string, {slug:string, filename:string, title:string, raw:string|null, error:string|null}>} */
const docs = new Map();

const els = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  els.sidebarList = document.getElementById('doc-list');
  els.content = document.getElementById('content');
  els.toc = document.getElementById('toc');
  els.search = document.getElementById('search');
  els.themeToggle = document.getElementById('theme-toggle');
  els.rawToggle = document.getElementById('raw-toggle');
  els.warning = document.getElementById('file-protocol-warning');
  els.menuToggle = document.getElementById('menu-toggle');
  els.sidebar = document.getElementById('sidebar');
  els.status = document.getElementById('status');

  initTheme();

  if (location.protocol === 'file:') {
    els.warning.hidden = false;
  }

  for (const filename of DOC_FILES) {
    const slug = filename.replace(/\.md$/, '');
    docs.set(slug, { slug, filename, title: prettifyFilename(filename), raw: null, error: null });
  }
  renderSidebar();

  await Promise.all(DOC_FILES.map(loadDoc));
  renderSidebar();

  els.search.addEventListener('input', () => {
    renderSidebar(els.search.value.trim().toLowerCase());
  });
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { els.search.value = ''; renderSidebar(); els.search.blur(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== els.search) {
      e.preventDefault();
      els.search.focus();
    }
  });

  els.themeToggle.addEventListener('click', cycleTheme);
  els.menuToggle.addEventListener('click', () => {
    els.sidebar.classList.toggle('open');
  });
  els.content.addEventListener('click', (e) => {
    els.sidebar.classList.remove('open');
    const a = e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    const internal = href.match(/^([a-zA-Z0-9_-]+)\.md(#.*)?$/);
    if (internal) {
      e.preventDefault();
      navigate(internal[1] + (internal[2] || ''));
    }
  });

  let rawMode = false;
  els.rawToggle.addEventListener('click', () => {
    rawMode = !rawMode;
    els.rawToggle.setAttribute('aria-pressed', String(rawMode));
    els.rawToggle.textContent = rawMode ? 'Rendered' : 'Raw';
    renderCurrent(rawMode);
  });
  window.addEventListener('hashchange', () => {
    rawMode = false;
    els.rawToggle.textContent = 'Raw';
    els.rawToggle.setAttribute('aria-pressed', 'false');
    renderCurrent(false);
  });

  renderCurrent(false);
}

async function loadDoc(filename) {
  const slug = filename.replace(/\.md$/, '');
  const doc = docs.get(slug);
  try {
    const res = await fetch(`../${filename}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    doc.raw = text;
    const h1 = text.match(/^#\s+(.+)$/m);
    if (h1) doc.title = stripInlineMarkup(h1[1].trim());
  } catch (err) {
    doc.error = err && err.message ? err.message : String(err);
  }
}

function prettifyFilename(filename) {
  return filename
    .replace(/\.md$/, '')
    .split(/[-_]/g)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function stripInlineMarkup(s) {
  return s.replace(/[`*_]/g, '');
}

function currentSlug() {
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [slug] = hash.split('#');
  if (slug && docs.has(slug)) return slug;
  return DOC_FILES[0].replace(/\.md$/, '');
}

function navigate(hash) {
  location.hash = '#/' + hash;
}

function renderSidebar(filter) {
  const q = (filter || '').toLowerCase();
  els.sidebarList.innerHTML = '';
  const active = currentSlug();
  for (const filename of DOC_FILES) {
    const slug = filename.replace(/\.md$/, '');
    const doc = docs.get(slug);
    if (q && !doc.title.toLowerCase().includes(q) && !slug.includes(q) &&
        !(doc.raw && doc.raw.toLowerCase().includes(q))) {
      continue;
    }
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '#/' + slug;
    a.textContent = doc.title;
    if (doc.error) a.classList.add('doc-error');
    if (slug === active) a.setAttribute('aria-current', 'page');
    li.appendChild(a);
    els.sidebarList.appendChild(li);
  }
  if (!els.sidebarList.children.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No matching docs.';
    els.sidebarList.appendChild(li);
  }
}

function renderCurrent(rawMode) {
  const slug = currentSlug();
  const doc = docs.get(slug);
  renderSidebar(els.search.value.trim());

  if (!doc || (doc.raw == null && !doc.error)) {
    els.content.innerHTML = '<p class="loading">Loading&hellip;</p>';
    els.toc.innerHTML = '';
    return;
  }
  if (doc.error) {
    els.content.innerHTML = `
      <h1>Couldn't load ${escapeHtml(doc.filename)}</h1>
      <p>${escapeHtml(doc.error)}</p>
      <p>If you're opening this file directly (<code>file://</code>), serve the
      <code>docs/</code> folder over HTTP instead -- see the notice at the top
      of the page, or <code>README.md</code> next to this app.</p>`;
    els.toc.innerHTML = '';
    document.title = `${doc.filename} – U2OS docs`;
    return;
  }

  if (rawMode) {
    els.content.innerHTML = `<pre class="raw-source"><code>${escapeHtml(doc.raw)}</code></pre>`;
    els.toc.innerHTML = '';
  } else {
    const { html, toc } = renderMarkdown(doc.raw);
    els.content.innerHTML = html;
    renderToc(toc);
  }

  document.title = `${doc.title} – U2OS docs`;
  els.status.textContent = doc.title;

  if (location.hash.includes('#', location.hash.indexOf('/'))) {
    const anchor = location.hash.split('#')[2];
    if (anchor) {
      const target = els.content.querySelector(`#${CSS.escape(anchor)}`);
      if (target) { target.scrollIntoView(); return; }
    }
  }
  els.content.scrollTop = 0;
}

function renderToc(toc) {
  els.toc.innerHTML = '';
  if (!toc.length) return;
  const heading = document.createElement('p');
  heading.className = 'toc-heading';
  heading.textContent = 'On this page';
  els.toc.appendChild(heading);
  const ul = document.createElement('ul');
  for (const item of toc) {
    const li = document.createElement('li');
    li.className = `toc-level-${item.level}`;
    const a = document.createElement('a');
    a.href = '#' + item.id;
    a.textContent = item.text;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(item.id);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', `#/${currentSlug()}#${item.id}`);
    });
    li.appendChild(a);
    ul.appendChild(li);
  }
  els.toc.appendChild(ul);
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const THEME_KEY = 'u2os-docs-theme'; // 'light' | 'dark' | absent = system

function initTheme() {
  const saved = safeLocalStorageGet(THEME_KEY);
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.setAttribute('data-theme', saved);
  }
  updateThemeToggleLabel();
}

function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : current === 'light' ? null : 'dark';
  if (next) {
    document.documentElement.setAttribute('data-theme', next);
    safeLocalStorageSet(THEME_KEY, next);
  } else {
    document.documentElement.removeAttribute('data-theme');
    safeLocalStorageSet(THEME_KEY, '');
  }
  updateThemeToggleLabel();
}

function updateThemeToggleLabel() {
  const current = document.documentElement.getAttribute('data-theme') || 'system';
  els.themeToggle.textContent =
    current === 'dark' ? '☀️ Light' : current === 'light' ? '🌙 Dark' : '◑ Auto';
  els.themeToggle.title = `Theme: ${current} (click to change)`;
}

function safeLocalStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeLocalStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Markdown -> HTML (small hand-rolled subset: headings, paragraphs, lists
// incl. nesting, blockquotes, fenced code, inline code, tables, links,
// images, emphasis, strikethrough, horizontal rules).
// ---------------------------------------------------------------------------

function renderMarkdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks = collectBlocks(lines);
  const toc = [];
  const slugCounts = Object.create(null);
  const html = blocks.map((b) => renderBlock(b, toc, slugCounts)).join('\n');
  return { html, toc };
}

function collectBlocks(lines) {
  const blocks = [];
  let i = 0;
  const n = lines.length;

  const fenceRe = /^ {0,3}(```|~~~)(.*)$/;
  const headingRe = /^ {0,3}(#{1,6})\s+(.*?)\s*#*$/;
  const hrRe = /^ {0,3}((?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
  const blockquoteRe = /^ {0,3}>\s?(.*)$/;
  const listItemRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const tableRowRe = /^ {0,3}\|?(.+\|.+)\|?$/;
  const tableSepRe = /^ {0,3}\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

  while (i < n) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    const fenceMatch = line.match(fenceRe);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1];
      const lang = fenceMatch[2].trim();
      const code = [];
      i++;
      while (i < n && !lines[i].startsWith(fenceChar)) { code.push(lines[i]); i++; }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang, code: code.join('\n') });
      continue;
    }

    const headingMatch = line.match(headingRe);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
      i++;
      continue;
    }

    if (hrRe.test(line) && line.trim().length >= 3) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (blockquoteRe.test(line)) {
      const qLines = [];
      while (i < n && (blockquoteRe.test(lines[i]) || (lines[i].trim() && qLines.length))) {
        const m = lines[i].match(blockquoteRe);
        qLines.push(m ? m[1] : lines[i]);
        i++;
      }
      blocks.push({ type: 'blockquote', inner: collectBlocks(qLines) });
      continue;
    }

    if (tableRowRe.test(line) && i + 1 < n && tableSepRe.test(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((c) => {
        const t = c.trim();
        if (t.startsWith(':') && t.endsWith(':')) return 'center';
        if (t.endsWith(':')) return 'right';
        if (t.startsWith(':')) return 'left';
        return null;
      });
      i += 2;
      const rows = [];
      while (i < n && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, aligns, rows });
      continue;
    }

    const listMatch = line.match(listItemRe);
    if (listMatch) {
      const listLines = [];
      while (i < n) {
        const l = lines[i];
        if (listItemRe.test(l) || /^\s+\S/.test(l)) { listLines.push(l); i++; continue; }
        if (!l.trim()) {
          let j = i + 1;
          while (j < n && !lines[j].trim()) j++;
          if (j < n && (listItemRe.test(lines[j]) || /^\s+\S/.test(lines[j]))) { i = j; continue; }
        }
        break;
      }
      blocks.push({ type: 'list', node: parseListLines(listLines) });
      continue;
    }

    // paragraph: gather until blank line or a line that starts a new block
    const paraLines = [line];
    i++;
    while (i < n && lines[i].trim() &&
           !fenceRe.test(lines[i]) && !headingRe.test(lines[i]) &&
           !blockquoteRe.test(lines[i]) && !listItemRe.test(lines[i]) &&
           !(hrRe.test(lines[i]) && lines[i].trim().length >= 3)) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
  }

  return blocks;
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // split on unescaped pipes
  const cells = [];
  let cur = '';
  for (let j = 0; j < s.length; j++) {
    const ch = s[j];
    if (ch === '\\' && s[j + 1] === '|') { cur += '|'; j++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseListLines(lines) {
  const root = { type: null, items: [] };
  // Each stack frame tracks the marker indent of the item that owns `list`
  // (root's owning item is null). Kept for the lifetime of parsing (never
  // truncated on a continuation line) so later, deeper markers can still
  // pop/push against it correctly.
  const stack = [{ indent: -1, list: root, item: null }];
  const markerRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

  for (const rawLine of lines) {
    const m = rawLine.match(markerRe);
    if (m) {
      const indent = m[1].length;
      const ordered = /\d/.test(m[2]);
      const text = m[3];
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const parentList = stack[stack.length - 1].list;
      if (!parentList.type) parentList.type = ordered ? 'ol' : 'ul';
      const item = { text, children: { type: null, items: [] } };
      parentList.items.push(item);
      stack.push({ indent, list: item.children, item });
    } else {
      // Continuation line (no marker): attach to the nearest enclosing item
      // whose marker indent is less than this line's indent, without
      // mutating the stack (a later, deeper marker still needs it intact).
      const indent = (rawLine.match(/^(\s*)/) || [''])[0].length;
      let k = stack.length - 1;
      while (k > 0 && indent <= stack[k].indent) k--;
      if (stack[k].item) stack[k].item.text += ' ' + rawLine.trim();
    }
  }
  return root;
}

function renderBlock(block, toc, slugCounts) {
  switch (block.type) {
    case 'heading': {
      const id = slugify(block.text, slugCounts);
      if (block.level >= 2 && block.level <= 3) {
        toc.push({ level: block.level, id, text: stripInlineMarkup(block.text) });
      }
      return `<h${block.level} id="${id}">${inline(block.text)}</h${block.level}>`;
    }
    case 'hr':
      return '<hr>';
    case 'code': {
      const langClass = block.lang ? ` class="lang-${escapeHtml(block.lang)}"` : '';
      const label = block.lang ? `<div class="code-lang">${escapeHtml(block.lang)}</div>` : '';
      return `<div class="code-block">${label}<pre><code${langClass}>${escapeHtml(block.code)}</code></pre></div>`;
    }
    case 'blockquote':
      return `<blockquote>${block.inner.map((b) => renderBlock(b, toc, slugCounts)).join('\n')}</blockquote>`;
    case 'list':
      return renderListNode(block.node);
    case 'table':
      return renderTable(block);
    case 'paragraph':
      return `<p>${inline(block.text)}</p>`;
    default:
      return '';
  }
}

function renderListNode(node) {
  if (!node.items.length) return '';
  const tag = node.type === 'ol' ? 'ol' : 'ul';
  const items = node.items
    .map((item) => `<li>${inline(item.text)}${item.children.items.length ? renderListNode(item.children) : ''}</li>`)
    .join('');
  return `<${tag}>${items}</${tag}>`;
}

function renderTable({ header, aligns, rows }) {
  const th = header
    .map((c, idx) => `<th${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${inline(c)}</th>`)
    .join('');
  const trs = rows
    .map((r) => `<tr>${r.map((c, idx) => `<td${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${inline(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

function slugify(text, counts) {
  let s = stripInlineMarkup(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');
  if (!s) s = 'section';
  const n = (counts[s] = (counts[s] || 0) + 1);
  return n > 1 ? `${s}-${n}` : s;
}

// Inline markdown: code spans, images, links, bold, italic, strikethrough.
function inline(text) {
  const placeholders = [];
  const stash = (html) => {
    placeholders.push(html);
    return `\u0000${placeholders.length - 1}\u0000`;
  };

  // Code spans first (protect their contents from further inline parsing).
  let s = text.replace(/`([^`]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));

  // Escape remaining HTML-significant characters.
  s = escapeHtml(s);

  // Images: ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, url, title) =>
    stash(`<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}"${title ? ` title="${escapeAttr(title)}"` : ''}>`));

  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, txt, url, title) => {
    const external = /^https?:\/\//.test(url);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return stash(`<a href="${escapeAttr(url)}"${title ? ` title="${escapeAttr(title)}"` : ''}${attrs}>${txt}</a>`);
  });

  // Bold + italic combos, then bold, then italic, then strikethrough.
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Line breaks within a paragraph.
  s = s.replace(/\n/g, '<br>');

  // Restore stashed HTML.
  s = s.replace(/\u0000(\d+)\u0000/g, (_, idx) => placeholders[Number(idx)]);

  return s;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
