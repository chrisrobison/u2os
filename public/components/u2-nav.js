const ROUTES = [
  ['#/home', 'Home'],
  ['#/briefing', 'Briefing'],
  ['#/memory', 'Memory'],
  ['#/mail', 'Mail'],
  ['#/calendar', 'Calendar'],
  ['#/tasks', 'Tasks'],
  ['#/projects', 'Projects'],
  ['#/dashboards', 'Dashboards'],
  ['#/activity', 'Activity'],
  ['#/operations', 'Operations'],
  ['#/connectors', 'Connectors'],
  ['#/devices', 'Devices'],
  ['#/voice', 'Voice'],
];

// Left navigation. Highlights the current hash route and stays in sync
// with browser back/forward via `hashchange`.
export class U2Nav extends HTMLElement {
  constructor() {
    super();
    this._onHashChange = this._onHashChange.bind(this);
  }

  connectedCallback() {
    this._render();
    window.addEventListener('hashchange', this._onHashChange);
  }

  disconnectedCallback() {
    window.removeEventListener('hashchange', this._onHashChange);
  }

  _onHashChange() {
    this._updateActive();
  }

  _render() {
    const list = document.createElement('ul');
    list.className = 'nav-list';
    for (const [hash, label] of ROUTES) {
      const li = document.createElement('li');
      li.className = 'nav-list__item';
      const a = document.createElement('a');
      a.href = hash;
      a.textContent = label;
      a.dataset.route = hash;
      li.appendChild(a);
      list.appendChild(li);
    }
    this.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'nav-footer';
    footer.textContent = 'local instance';
    this.appendChild(footer);

    this._updateActive();
  }

  _updateActive() {
    const current = (window.location.hash || '#/home').split('?')[0];
    this.querySelectorAll('a[data-route]').forEach((a) => {
      const route = a.dataset.route;
      a.classList.toggle('is-active', current === route || current.startsWith(`${route}/`));
    });
  }
}

customElements.define('u2-nav', U2Nav);
