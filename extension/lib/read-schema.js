// Reads the application form exactly as mcp/jobs/hunt/applications/form/schema.js does in the Playwright
// driver: the same data-u2 keys, labels, options and blockers, so the same schema hash. The body below is a
// verbatim copy of that file's page.evaluate() callback; tests/extension.test.js runs both on the same pages
// and fails if they ever differ. Change the two together. Page text is untrusted data.
(() => {
  function readFormSchema() {
    const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0);
    };
    const labelOf = (element) => {
      const byFor = element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      const byledby = element.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      const group = element.closest('fieldset')?.querySelector('legend')?.innerText || element.closest('[role="group"],[role="radiogroup"]')?.getAttribute('aria-label');
      const container = element.closest('.application-question, .field, .form-field, [class*="question"], [class*="field"], li, .form-group');
      const nearby = container?.querySelector('label, .application-label, .label, legend, h3, h4')?.innerText;
      return clean(byFor?.innerText || element.closest('label')?.innerText || element.getAttribute('aria-label') || byledby || group || nearby || element.getAttribute('placeholder') || '').slice(0, 400);
    };
    // The application form: the largest <form>, or (single-page apps such as Ashby render none) the page itself.
    const forms = [...document.forms].sort((a, b) => b.elements.length - a.elements.length);
    const root = forms[0] ?? document.body;
    const fileInputs = root.querySelectorAll('input[type="file"]').length;
    const inputCount = root.querySelectorAll('input:not([type="hidden"]), textarea, select').length;
    const password = !!root.querySelector('input[type="password"]');
    const challenge = [...document.querySelectorAll('iframe, .h-captcha, .g-recaptcha')].some((element) => {
      const src = element.getAttribute('src') || '';
      if (/recaptcha\/(api2|enterprise)\/bframe|challenges\.cloudflare/.test(src)) return visible(element);
      if (/hcaptcha/.test(src) && !/size=invisible/.test(src)) return true;
      if (element.matches('.h-captcha')) return true;
      if (element.matches('.g-recaptcha')) return element.getAttribute('data-size') !== 'invisible' && visible(element) && element.offsetHeight > 20;
      if (/recaptcha\/(api2|enterprise)\/anchor/.test(src)) return /size=(normal|compact)/.test(src) && visible(element);
      return /challenge/i.test(element.getAttribute('title') || '') && visible(element);
    });
    // A page with nothing to fill (a landing page, a search box) is not an application form.
    if (!forms[0] && inputCount < 2 && !fileInputs) return { hasForm: false, fields: [], blockers: { password, captcha: challenge }, title: document.title, text: clean(document.body.innerText).slice(0, 400) };

    const groups = new Map();
    let counter = 0;
    for (const element of root.querySelectorAll('input, textarea, select')) {
      const type = element.tagName === 'INPUT' ? (element.type || 'text') : element.tagName.toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      if (element.name === 'g-recaptcha-response' || /^g-recaptcha-response/.test(element.id || '')) continue;
      const buttons = type === 'checkbox' ? [...(element.parentElement?.querySelectorAll(':scope > button') ?? [])] : [];
      const buttonGroup = buttons.length >= 2;
      if (type !== 'file' && !buttonGroup && !visible(element) && !(type === 'radio' || type === 'checkbox')) continue;
      const base = element.name || element.id || `field_${counter}`;
      counter += 1;
      const key = base;
      if (!groups.has(key)) groups.set(key, { key, type: buttonGroup ? 'buttons' : element.getAttribute('role') === 'combobox' ? 'combobox' : type, label: '', required: false, filled: false, options: [], maxLength: element.maxLength > 0 ? element.maxLength : null, accept: element.accept || null });
      const entry = groups.get(key);
      const label = labelOf(element);
      element.setAttribute('data-u2', key);
      if (buttonGroup) {
        // Yes/No style buttons that drive a hidden checkbox (Ashby): the buttons are the options.
        buttons.forEach((button) => button.setAttribute('data-u2-btn', key));
        entry.options = buttons.map((button) => clean(button.innerText));
        entry.filled = buttons.some((button) => button.getAttribute('aria-pressed') === 'true') || element.checked;
        let node = element.parentElement;
        for (let i = 0; i < 5 && node && !entry.label; i += 1, node = node.parentElement) {
          const text = node.querySelector(':scope > label, :scope > legend, :scope > [class*="label"]');
          if (text && !text.contains(element)) entry.label = clean(text.innerText);
        }
        if (!entry.label) { const prev = element.parentElement?.previousElementSibling; entry.label = clean(prev?.innerText ?? ''); }
      } else if (type === 'radio' || type === 'checkbox') {
        const own = clean(element.closest('label')?.innerText || (element.id && document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.innerText) || element.value);
        entry.options.push(own);
        entry.label ||= clean(element.closest('fieldset')?.querySelector('legend')?.innerText || element.closest('[role="group"],[role="radiogroup"]')?.getAttribute('aria-label') || element.closest('.application-question, .field, .form-field, [class*="question"], li, .form-group')?.querySelector('label:not(:has(input)), legend, .label, h3, h4')?.innerText || label);
        entry.filled ||= element.checked;
      } else {
        entry.label ||= label;
        if (type === 'select') entry.options = [...element.options].filter((option) => option.value !== '' && !/^select\b/i.test(option.text.trim())).map((option) => clean(option.text));
        entry.filled = type === 'file' ? element.files.length > 0 : clean(element.value) !== '';
      }
      entry.required ||= element.required || element.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label) || /\(required\)/i.test(label);
    }
    const fields = [...groups.values()].map((field) => ({ ...field, label: field.label.replace(/\s*\*+\s*$/, '').replace(/\s*\(required\)\s*$/i, '').trim() }));
    const scope = forms[0] ?? document;
    const submit = [...scope.querySelectorAll('button, input[type="submit"]')].find((button) => /submit|apply|send/i.test(button.innerText || button.value || '') && !/^apply with|autofill|upload/i.test(button.innerText || '')) || scope.querySelector('button[type="submit"]');
    return {
      hasForm: true, fields, title: document.title,
      submitLabel: clean(submit?.innerText || submit?.value || ''),
      blockers: { password, captcha: challenge },
      text: clean(document.body.innerText).slice(0, 400),
    };
  }
  globalThis.U2Schema = { readFormSchema };
})();
