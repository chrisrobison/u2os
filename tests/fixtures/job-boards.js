// Local stand-ins for the Greenhouse and Lever job-board APIs and their
// hosted application forms, for tests/jobs-mcp.test.js.
import http from 'node:http';

const GH_JOBS = [
  { id: 101, title: 'Senior Software Engineer', location: { name: 'Portland, OR' }, updated_at: '2026-09-20T00:00:00Z', content: '&lt;p&gt;Build &amp;amp; ship things.&lt;/p&gt;' },
  { id: 102, title: 'Product Designer', location: { name: 'Portland, OR' }, updated_at: '2026-09-21T00:00:00Z', content: '' },
  { id: 103, title: 'Backend Engineer', location: { name: 'Remote (US)' }, updated_at: '2026-09-22T00:00:00Z', content: '' },
  { id: 104, title: 'Platform Engineer', location: { name: 'Berlin' }, updated_at: '2026-09-23T00:00:00Z', content: '' },
];
const GH_QUESTIONS = [
  { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text' }] },
  { label: 'LinkedIn Profile', required: false, fields: [{ name: 'question_1', type: 'input_text' }] },
  { label: 'Why do you want to work at Acme?', required: true, fields: [{ name: 'question_2', type: 'textarea' }] },
  { label: 'Are you legally authorized to work in the United States?', required: true, fields: [{ name: 'question_3', type: 'multi_value_single_select', values: [{ label: 'Yes', value: 1 }, { label: 'No', value: 0 }] }] },
];
const LEVER = [{
  id: 'abc-1', text: 'Staff Engineer', categories: { location: 'Remote - US', team: 'Platform' }, workplaceType: 'remote',
  descriptionPlain: 'Own the platform.', createdAt: Date.parse('2026-09-24T00:00:00Z'), salaryRange: { min: 180000, max: 220000, currency: 'USD', interval: 'per-year-salary' },
}];

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>${body}</body></html>`;

function greenhouseForm(id) {
  return page(`<h1>${GH_JOBS.find((job) => job.id === id).title}</h1>
<form method="post" enctype="multipart/form-data" action="/gh-board/acme/jobs/${id}/submit">
  <label for="first_name">First Name *</label><input id="first_name" name="first_name" required>
  <label for="last_name">Last Name *</label><input id="last_name" name="last_name" required>
  <label for="email">Email *</label><input id="email" name="email" type="email" required>
  <label for="phone">Phone</label><input id="phone" name="phone">
  <label for="resume">Resume/CV *</label><input id="resume" name="resume" type="file" required>
  <label for="cover_letter_text">Cover letter</label><textarea id="cover_letter_text" name="cover_letter_text"></textarea>
  <label for="question_1">LinkedIn Profile</label><input id="question_1" name="question_1">
  <label for="question_2">Why do you want to work at Acme? *</label><textarea id="question_2" name="question_2" required></textarea>
  <label for="question_3">Are you legally authorized to work in the United States? *</label>
  <select id="question_3" name="question_3" required><option value="">Select...</option><option value="1">Yes</option><option value="0">No</option></select>
  <fieldset><legend>Gender</legend>
    <label><input type="radio" name="gender" value="m"> Male</label>
    <label><input type="radio" name="gender" value="f"> Female</label>
    <label><input type="radio" name="gender" value="d"> Decline to self identify</label>
  </fieldset>
  <button type="submit">Submit application</button>
</form>`);
}

const LEVER_FORM = page(`<h2>Staff Engineer</h2>
<form method="post" enctype="multipart/form-data" action="/lever-jobs/globex/abc-1/apply/submit">
  <div class="application-question"><div class="application-label">Full name *</div><input name="name" required></div>
  <div class="application-question"><div class="application-label">Email *</div><input name="email" type="email" required></div>
  <div class="application-question"><div class="application-label">Phone</div><input name="phone"></div>
  <div class="application-question"><div class="application-label">Current company</div><input name="org"></div>
  <div class="application-question"><div class="application-label">LinkedIn URL</div><input name="urls[LinkedIn]"></div>
  <div class="application-question"><div class="application-label">Resume/CV *</div><input type="file" name="resume" id="resume-upload-input" required></div>
  <div class="application-question"><div class="application-label">What is the best system you have built? *</div><textarea name="cards[c1][field0]" required></textarea></div>
  <div class="application-question"><div class="application-label">Additional information</div><textarea name="comments"></textarea></div>
  <button type="submit">Submit application</button>
</form>`);

export async function startJobBoards() {
  const submissions = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const html = (status, value) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end(value); };
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        submissions.push({ path: url.pathname, body });
        if (url.pathname === '/gh-board/acme/jobs/103/submit') {
          return html(200, page(`<form><p>Please verify you are human.</p><iframe src="/hcaptcha-challenge" title="hCaptcha challenge" style="width:300px;height:200px"></iframe></form>`));
        }
        const done = url.pathname.startsWith('/gh-board') ? `${url.pathname.replace(/\/submit$/, '')}/confirmation` : '/lever-jobs/globex/abc-1/thanks';
        res.writeHead(303, { location: done });
        res.end();
      });
      return;
    }
    if (url.pathname === '/gh-api/v1/boards/acme') return json(200, { name: 'Acme Corp' });
    if (url.pathname === '/gh-api/v1/boards/acme/jobs') return json(200, { jobs: GH_JOBS });
    const ghJob = url.pathname.match(/^\/gh-api\/v1\/boards\/acme\/jobs\/(\d+)$/);
    if (ghJob && GH_JOBS.some((job) => job.id === Number(ghJob[1]))) return json(200, { id: Number(ghJob[1]), questions: GH_QUESTIONS });
    if (url.pathname === '/lever-api/v0/postings/globex') return json(200, LEVER);
    const ghForm = url.pathname.match(/^\/gh-board\/acme\/jobs\/(\d+)$/);
    if (ghForm && GH_JOBS.some((job) => job.id === Number(ghForm[1]))) return html(200, greenhouseForm(Number(ghForm[1])));
    if (url.pathname.endsWith('/confirmation')) return html(200, page('<h1>Thank you for applying.</h1>'));
    if (url.pathname === '/lever-jobs/globex/abc-1/apply') return html(200, LEVER_FORM);
    if (url.pathname === '/lever-jobs/globex/abc-1/thanks') return html(200, page('<h3>Application submitted!</h3>'));
    if (url.pathname === '/hcaptcha-challenge') return html(200, page('<p>challenge</p>'));
    return json(404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    submissions,
    env: {
      JOBS_GREENHOUSE_API: `${base}/gh-api`,
      JOBS_GREENHOUSE_BOARD: `${base}/gh-board`,
      JOBS_LEVER_API: `${base}/lever-api`,
      JOBS_LEVER_JOBS: `${base}/lever-jobs`,
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
