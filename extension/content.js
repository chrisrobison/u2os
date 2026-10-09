// Content script: runs in the job's tab only (injected by the side panel after the owner clicks "Fill").
// It reads the form, fills it from the reviewed plan the side panel hands it, shows what it did, and answers
// questions about the page. It holds no token and makes no network request: the side panel talks to U2OS.
// Everything it reads from the page is untrusted data and is only ever rendered with textContent.
(() => {
  if (globalThis.__u2FillerLoaded) return;
  globalThis.__u2FillerLoaded = true;
  const { readFormSchema } = globalThis.U2Schema;
  const Core = globalThis.U2Core;

  const COLORS = { filled: '#1a7f37', uncertain: '#bf8700', unfilled: '#cf222e' };
  const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const elementsFor = (key) => [...document.querySelectorAll('[data-u2]')].filter((element) => element.getAttribute('data-u2') === key);
  const buttonsFor = (key) => [...document.querySelectorAll('[data-u2-btn]')].filter((element) => element.getAttribute('data-u2-btn') === key);

  const fire = (element, type, init = {}) => element.dispatchEvent(new Event(type, { bubbles: true, cancelable: false, ...init }));
  /** React/Vue track the value through the prototype's setter; assigning .value directly would be ignored. */
  function setNative(element, value) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
  }
  function commit(element, value) {
    fire(element, 'focus', { bubbles: false });
    fire(element, 'focusin');
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
    fire(element, 'change');
    fire(element, 'blur', { bubbles: false });
    fire(element, 'focusout');
  }

  function bytesOf(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** One planned field -> 'filled' | 'uncertain' | 'unfilled'. Never throws. */
  async function setField(entry, schemaField, files) {
    const elements = elementsFor(entry.key);
    if (!elements.length) return 'unfilled';
    const control = elements[0];
    const options = schemaField?.options ?? entry.options ?? [];
    try {
      if (entry.file) {
        const file = files[entry.file];
        if (!file || !(await Core.verifySha256(file.bytes, file.sha256))) return 'unfilled';
        const transfer = new DataTransfer();
        transfer.items.add(new File([file.bytes], entry.fileName || `${entry.file}.pdf`, { type: 'application/pdf' }));
        control.files = transfer.files;
        fire(control, 'input');
        fire(control, 'change');
        return control.files.length === 1 ? 'filled' : 'unfilled';
      }
      const value = String(entry.value ?? '');
      switch (schemaField?.type ?? entry.type) {
        case 'buttons': {
          const wanted = Core.matchOption(options, value);
          const button = wanted ? buttonsFor(entry.key)[options.indexOf(wanted)] : null;
          if (!button) return 'unfilled';
          button.click();
          return button.getAttribute('aria-pressed') === 'true' || control.checked ? 'filled' : 'uncertain';
        }
        case 'select': {
          const wanted = Core.matchOption(options, value);
          const option = wanted ? [...control.options].find((candidate) => clean(candidate.text) === wanted) : null;
          if (!option) return 'unfilled';
          setNative(control, option.value);
          commit(control, option.value);
          return control.value === option.value ? 'filled' : 'uncertain';
        }
        case 'checkbox':
        case 'radio': {
          if (schemaField?.type === 'checkbox' && options.length <= 1) {
            if (/^(yes|true)$/i.test(value) && !control.checked) control.click();
            return !/^(yes|true)$/i.test(value) || control.checked ? 'filled' : 'uncertain';
          }
          const wanted = Core.matchOption(options, value);
          const target = wanted ? elements[options.indexOf(wanted)] : null;
          if (!target) return 'unfilled';
          if (!target.checked) target.click();
          return target.checked ? 'filled' : 'uncertain';
        }
        case 'combobox': {
          setNative(control, value);
          commit(control, value);
          await wait(300);
          for (const type of ['keydown', 'keyup']) control.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true }));
          return 'uncertain'; // a custom widget: only the owner can tell whether the option took
        }
        default: {
          setNative(control, value);
          commit(control, value);
          return control.value === value ? 'filled' : 'uncertain'; // e.g. the page truncated it
        }
      }
    } catch { return 'unfilled'; }
  }

  function mark(elements, state) {
    for (const element of elements) {
      element.setAttribute('data-u2-state', state);
      element.style.setProperty('outline', `3px solid ${COLORS[state]}`, 'important');
      element.style.setProperty('outline-offset', '2px', 'important');
    }
  }

  function banner(text, tone) {
    document.getElementById('u2-filler-banner')?.remove();
    const box = document.createElement('div');
    box.id = 'u2-filler-banner';
    box.setAttribute('role', 'status');
    box.textContent = text;
    Object.assign(box.style, { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647', padding: '10px 16px', font: '14px/1.4 system-ui, sans-serif', color: '#fff', background: COLORS[tone] ?? COLORS.filled, cursor: 'pointer' });
    box.addEventListener('click', () => box.remove());
    document.documentElement.append(box);
  }

  async function fill({ plan, files: encoded }) {
    const schema = readFormSchema();
    const stopped = Core.stopReason(schema, plan.schemaHash, await Core.schemaHash(schema.fields));
    if (stopped) { banner(`U2OS stopped: ${stopped.message}`, 'unfilled'); return { stopped }; }

    const files = {};
    for (const file of plan.files ?? []) if (encoded?.[file.kind]) files[file.kind] = { bytes: bytesOf(encoded[file.kind]), sha256: file.sha256 };
    const byKey = new Map(schema.fields.map((field) => [field.key, field]));
    const uncertain = [];
    const unfilled = [];
    let filled = 0;
    for (const entry of plan.fields) {
      if (!byKey.has(entry.key)) continue;
      const state = await setField(entry, byKey.get(entry.key), files);
      const label = clean(entry.label || entry.key).slice(0, 120);
      mark(byKey.get(entry.key).type === 'buttons' ? buttonsFor(entry.key) : elementsFor(entry.key), state);
      if (state === 'filled') filled += 1; else if (state === 'uncertain') uncertain.push(label); else unfilled.push(label);
    }
    const after = readFormSchema();
    const missing = after.fields.filter((field) => field.required && !field.filled);
    for (const field of missing) mark(elementsFor(field.key), 'unfilled');
    const missingRequired = missing.map((field) => clean(field.label || field.key).slice(0, 120));
    const form = [...document.forms].sort((a, b) => b.elements.length - a.elements.length)[0];
    const report = { filled, uncertain, unfilled, missingRequired, valid: form ? form.checkValidity() : true };
    const left = new Set([...unfilled, ...missingRequired]).size;
    banner(`U2OS filled ${filled} field${filled === 1 ? '' : 's'}. ${uncertain.length ? `${uncertain.length} to check (amber). ` : ''}${left ? `${left} for you (red). ` : ''}Review the form, then press submit yourself.`, left ? 'unfilled' : uncertain.length ? 'uncertain' : 'filled');
    return report;
  }

  /** Mirrors findSubmit() in form/apply.js. */
  function findSubmit() {
    const forms = [...document.forms].sort((a, b) => b.elements.length - a.elements.length);
    const scope = forms[0] ?? document.body;
    const buttons = [...scope.querySelectorAll('button, input[type="submit"]')];
    const text = (button) => button.innerText || button.value || '';
    return buttons.find((button) => button.matches('button[type="submit"], input[type="submit"]')) || buttons.find((button) => /submit/i.test(text(button))) || buttons.find((button) => /apply/i.test(text(button))) || null;
  }

  /** With check: only say whether a click is possible. Otherwise click. */
  function clickSubmit(check) {
    if (document.querySelector(Core.CAPTCHA_SELECTOR)) return check ? { ready: false, reason: 'a CAPTCHA is showing' } : { clicked: false, reason: 'captcha' };
    const button = findSubmit();
    if (!button || button.disabled) return check ? { ready: false, reason: 'no submit button was found' } : { clicked: false, reason: 'no_submit_button' };
    if (check) return { ready: true };
    banner('U2OS is submitting this application (you enabled "submit when complete").', 'uncertain');
    button.click();
    return { clicked: true };
  }

  /** What the page shows now; the side panel polls this after the click (the page may reload in between). */
  function observe(formUrl) {
    const errors = [...document.querySelectorAll('[role="alert"], .error, .field-error, .error-message, [aria-invalid="true"]')]
      .map((element) => (element.getAttribute('aria-invalid') === 'true' ? `invalid: ${element.name || element.id}` : element.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 5);
    return {
      submitted: Core.confirmed(document.body?.innerText, location.pathname),
      captcha: !!document.querySelector(Core.CAPTCHA_SELECTOR),
      errors,
      stillOnForm: location.href === formUrl && document.forms.length > 0,
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false; // only this extension talks to us
    const reply = (work) => { Promise.resolve().then(work).then((value) => respond({ ok: true, value }), (error) => respond({ ok: false, error: String(error?.message ?? error).slice(0, 200) })); return true; };
    if (message?.type === 'u2-fill') return reply(() => fill(message));
    if (message?.type === 'u2-submit') return reply(() => clickSubmit(message.check === true));
    if (message?.type === 'u2-observe') return reply(() => observe(String(message.formUrl ?? '')));
    return false;
  });
})();
