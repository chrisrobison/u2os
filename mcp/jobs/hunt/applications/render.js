// HTML and PDF rendering for resumes and letters, in the style of the
// owner's existing résumés (navy name, teal headline, uppercase section rules).
// The PDF comes from headless Chromium (Playwright, already used by the
// application forms). All text is escaped; nothing from a listing is HTML.

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = (size) => `
  @page { size: Letter; margin: 0.5in 0.55in; }
  * { box-sizing: border-box; }
  body { font-family: "DejaVu Sans", "Helvetica Neue", Arial, sans-serif; font-size: ${size}pt; line-height: 1.32; color: #1b1f27; margin: 0; }
  h1 { font-size: 24pt; margin: 0; color: #1f2a44; letter-spacing: 0.2px; }
  .headline { color: #1a6b6b; font-size: ${size + 3}pt; margin: 2px 0 2px; }
  .contact { color: #5a6270; font-size: ${size - 1}pt; margin-bottom: 8px; }
  h2 { font-size: ${size + 1.5}pt; text-transform: uppercase; color: #1f2a44; border-bottom: 1px solid #d5d9e0; padding-bottom: 1px; margin: 11px 0 5px; letter-spacing: .3px; }
  h3 { font-size: ${size + 0.5}pt; margin: 7px 0 0; color: #1f2a44; }
  .meta { color: #5a6270; font-size: ${size - 1}pt; }
  ul { margin: 2px 0 0; padding-left: 15px; } li { margin: 1px 0; }
  p { margin: 3px 0; }
  .exp { display: grid; grid-template-columns: 112px 1fr; gap: 1px 8px; } .exp b { color: #1f2a44; }
  .letter p { margin: 0 0 9px; } .letter .gap { height: 8px; }
  .keep { break-inside: avoid; }
`;

export function resumeHtml(doc, { fontSize = 9.4 } = {}) {
  const b = doc.basics;
  const contact = [b.location, b.phone, b.email, b.website?.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), b.github?.replace(/^https?:\/\//, ''), b.linkedin?.replace(/^https?:\/\/(www\.)?/, '')].filter(Boolean);
  const parts = [`<h1>${esc(b.name)}</h1>`, `<div class="headline">${esc(b.headline)}</div>`, `<div class="contact">${contact.map(esc).join(' | ')}</div>`];
  parts.push(`<h2>Profile</h2><p>${esc(b.summary)}</p>`);
  if (doc.highlights.length) parts.push(`<h2>Role alignment highlights</h2><ul>${doc.highlights.map((h) => `<li><b>${esc(h.label)}:</b> ${esc(h.text)}</li>`).join('')}</ul>`);
  if (doc.expertise.length) parts.push(`<h2>Core expertise</h2><div class="exp">${doc.expertise.map((r) => `<b>${esc(r.label)}</b><span>${esc(r.items)}</span>`).join('')}</div>`);
  parts.push('<h2>Experience</h2>');
  for (const job of doc.experience) {
    parts.push(`<div class="keep"><h3>${esc(job.position)} - ${esc(job.company)}</h3><div class="meta">${esc([job.period, job.location].filter(Boolean).join(' | '))}</div><ul>${job.bullets.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`);
  }
  if (doc.projects.length) {
    parts.push('<h2>Selected projects</h2>');
    for (const project of doc.projects) parts.push(`<div class="keep"><h3>${esc(project.name)}</h3><ul>${project.bullets.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`);
  }
  if (doc.earlier.length) parts.push(`<h2>Earlier experience</h2><p>${doc.earlier.map((j) => `${esc(j.position)} - ${esc(j.company)}`).join(' | ')}</p>`);
  if (doc.education.length) parts.push(`<h2>Education</h2><p>${doc.education.map((s) => `${esc(s.institution)}${s.area ? ` (${esc(s.area)})` : ''}`).join('; ')}</p>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(b.name)} - Resume</title><style>${CSS(fontSize)}</style></head><body>${parts.join('\n')}</body></html>`;
}

export function letterHtml(letter) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(letter.name)} - Cover letter</title><style>${CSS(10.5)}</style></head><body><div class="letter">
<h1>${esc(letter.name)}</h1><div class="contact">${esc(letter.contact)}</div>
<p>${esc(letter.date)}</p><div class="gap"></div><p>${esc(letter.greeting)}</p>
${letter.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('\n')}
<div class="gap"></div><p>${esc(letter.closing)}<br>${esc(letter.signature)}</p></div></body></html>`;
}

/** One document: the cover letter, then the resume on a fresh page. For forms that have no separate cover-letter upload. */
export function combinedHtml(letter, resumeDoc, { fontSize = 9.4 } = {}) {
  const body = (html) => html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';
  const style = (html) => html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(resumeDoc.basics.name)} - Cover letter and resume</title><style>${style(resumeHtml(resumeDoc, { fontSize }))}
  .part-letter { font-size: 10.5pt; } .part-resume { break-before: page; page-break-before: always; }</style></head><body>
<div class="part-letter">${body(letterHtml(letter))}</div><div class="part-resume">${body(resumeHtml(resumeDoc, { fontSize }))}</div></body></html>`;
}

async function launch(env) {
  let playwright;
  try { playwright = await import('playwright'); } catch { throw new Error('Playwright is not installed. Run: npm install && npx playwright install chromium'); }
  return playwright.chromium.launch({ headless: true, ...(env.JOBS_BROWSER_PATH ? { executablePath: env.JOBS_BROWSER_PATH } : {}) });
}

/**
 * Renders HTML builders to PDFs. Each entry: { html: (fontSize) => string,
 * maxPages, file }. Shrinks the font a step at a time to honour maxPages.
 * Returns the page count for each file.
 */
export async function renderPdfs(entries, { env = process.env } = {}) {
  const browser = await launch(env);
  try {
    const results = [];
    for (const entry of entries) {
      let pages = 0;
      for (const size of entry.sizes ?? [null]) {
        const page = await browser.newPage();
        try {
          await page.setContent(entry.html(size), { waitUntil: 'load' });
          const buffer = await page.pdf({ format: 'Letter', printBackground: true, preferCSSPageSize: true });
          pages = (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
          if (pages <= (entry.maxPages ?? 99) || size === (entry.sizes ?? [null]).at(-1)) { await (await import('node:fs')).promises.writeFile(entry.file, buffer, { mode: 0o600 }); break; }
        } finally { await page.close(); }
      }
      results.push({ file: entry.file, pages });
    }
    return results;
  } finally { await browser.close(); }
}
