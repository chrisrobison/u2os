// Local stand-ins for application forms on different boards, for tests/job-form-applicant.test.js.
import http from 'node:http';

const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const ASHBY_FORM = (errors = []) => page('Apply: Founding Engineer', `<h1>Founding Engineer</h1>
<form action="/ashby/submit" method="post" enctype="multipart/form-data">
  ${errors.length ? `<div role="alert" class="error">${errors.join('; ')}</div>` : ''}
  <div class="field"><label for="n">Full name *</label><input id="n" name="_systemfield_name" required></div>
  <div class="field"><label for="e">Email *</label><input id="e" name="_systemfield_email" type="email" required></div>
  <div class="field"><label for="p">Phone</label><input id="p" name="phone" type="tel"></div>
  <div class="field"><label for="r">Resume *</label><input id="r" name="_systemfield_resume" type="file" accept=".pdf" required></div>
  <div class="field"><label for="l">LinkedIn</label><input id="l" name="linkedin" type="url"></div>
  <div class="field"><label for="w">Why do you want to work at Tahoma? *</label><textarea id="w" name="why" required maxlength="800"></textarea></div>
  <fieldset class="field"><legend>Are you legally authorized to work in the United States? *</legend>
    <label><input type="radio" name="auth" value="yes" required> Yes</label> <label><input type="radio" name="auth" value="no"> No</label></fieldset>
  <fieldset class="field"><legend>Will you now or in the future require visa sponsorship? *</legend>
    <label><input type="radio" name="sponsor" value="yes" required> Yes</label> <label><input type="radio" name="sponsor" value="no"> No</label></fieldset>
  <div class="field"><label for="h">How did you hear about us?</label><select id="h" name="heard"><option value="">Select...</option><option>LinkedIn</option><option>Hacker News</option><option>Other</option></select></div>
  <div class="field"><label for="g">Gender</label><select id="g" name="gender"><option value="">Select...</option><option>Male</option><option>Female</option><option>Decline to self-identify</option></select></div>
  <div class="field"><label for="v">Veteran status</label><select id="v" name="veteran"><option value="">Select...</option><option>I am a veteran</option><option>I am not a veteran</option><option>I prefer not to answer</option></select></div>
  <div class="field"><label><input type="checkbox" name="privacy" required> I agree to the privacy policy and consent to processing of my data *</label></div>
  <button type="submit">Submit Application</button>
</form>`);

const SIMPLE_FORM = (extra = '') => page('Apply', `<form id="search" action="/search"><input name="q" aria-label="Search jobs"><button type="submit">Search</button></form>
<form action="/simple/submit" method="post" enctype="multipart/form-data">
  <label for="fn">First Name *</label><input id="fn" name="first_name" required>
  <label for="ln">Last Name *</label><input id="ln" name="last_name" required>
  <label for="em">Email *</label><input id="em" name="email" type="email" required>
  <label for="cv">Resume/CV *</label><input id="cv" name="resume" type="file" required>
  ${extra}
  <button type="submit">Submit</button>
</form>`);

export function startApplyForms() {
  const submissions = [];
  let slowSubmits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const html = (body, status = 200) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end(body); };
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        const fields = Object.fromEntries([...body.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r\n]+\r\n)?\r\n([\s\S]*?)\r\n--/g)].map((m) => [m[1], m[2] !== undefined ? `file:${m[2]}:${m[3].length}` : m[3]]));
        submissions.push({ path: url.pathname, fields });
        if (url.pathname === '/ashby/submit') {
          const missing = ['_systemfield_name', '_systemfield_email', 'auth', 'sponsor', 'why'].filter((key) => !fields[key]);
          if (missing.length) return html(ASHBY_FORM([`Missing required: ${missing.join(', ')}`]), 200);
          res.writeHead(302, { location: '/thanks' }); return res.end();
        }
        if (url.pathname === '/quiet/submit') return html(page('Done', '<p>ok</p>'));
        if (url.pathname === '/slow/submit') { slowSubmits += 1; return; } // never answers: the browser is closed first
        res.writeHead(302, { location: '/thanks' }); res.end();
      });
      return;
    }
    switch (url.pathname) {
      case '/ashby/application': return html(ASHBY_FORM());
      case '/simple/apply': return html(SIMPLE_FORM());
      case '/simple/extra': return html(SIMPLE_FORM('<label for="x">Describe a system you scaled to millions of users *</label><textarea id="x" name="scaled" required></textarea><label for="s">Current salary *</label><input id="s" name="salary_now" required>'));
      case '/cover/apply': return html(SIMPLE_FORM('<label for="cl">Cover letter</label><input id="cl" name="cover_letter" type="file">'));
      case '/captcha/apply': return html(SIMPLE_FORM('<iframe src="https://www.hcaptcha.com/captcha/frame" title="hCaptcha challenge"></iframe>'));
      case '/login/apply': return html(page('Sign in', '<form action="/login" method="post"><label>Email</label><input name="email"><label>Password</label><input name="password" type="password"><button>Sign in</button></form>'));
      case '/slow/apply': return html(SIMPLE_FORM().replace('/simple/submit', '/slow/submit'));
      case '/quiet/apply': return html(SIMPLE_FORM().replace('/simple/submit', '/quiet/submit'));
      case '/thanks': return html(page('Thank you', '<h1>Thank you for applying</h1><p>We have received your application.</p>'));
      case '/careers': return html(page('Careers', '<h1>Careers</h1><p>We are hiring. <a href="/ashby/application">Open roles</a></p>'));
      default: return html(page('Not found', 'x'), 404);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`, submissions, slowSubmits: () => slowSubmits, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
  })));
}
