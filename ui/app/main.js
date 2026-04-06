import './components/bos-entity-form.js';
import './components/bos-salon-workspace.js';
import './components/bos-transportation-workspace.js';
import './components/bos-settings-panel.js';

// ── Onboarding guard ────────────────────────────────────────────────────────
// Early check: if the tenant hasn't completed onboarding, redirect to the
// wizard. Fires before navigation renders so the user never sees a half-
// loaded app. Errors are silently ignored to avoid blocking a network-down
// scenario.
fetch('/api/system/onboarding')
  .then((r) => r.json())
  .then((onboardingState) => {
    if (onboardingState && onboardingState.completed === false) {
      window.location.href = '/onboarding/';
    }
  })
  .catch(() => { /* fail silently — don't block app load on network error */ });

const state = {
  appId: new URLSearchParams(window.location.search).get('app') || 'default',
  appDefinition: null,
  navById: new Map(),
  openTabs: [],
  activeTabId: null,
  panBus: null
};

const appTitle = document.getElementById('appTitle');
const appMeta = document.getElementById('appMeta');
const navTree = document.getElementById('navTree');
const tabs = document.getElementById('tabs');
const tabPanels = document.getElementById('tabPanels');
const statusLine = document.getElementById('statusLine');

const clientHookRegistry = {
  'client.notifyLoaded': async ({ navItem }) => {
    setStatus(`Loaded ${navItem.title}`);
  },
  'client.notifySaved': async ({ navItem, context }) => {
    const recordId = context?.publicId || context?.id;
    const suffix = recordId ? ` #${recordId}` : '';
    setStatus(`Saved in ${navItem.title}${suffix}`);
  }
};

function setStatus(message) {
  statusLine.textContent = `${message} (${new Date().toLocaleTimeString()})`;
}

function flattenNavigation(items, map, parentId = null) {
  for (const item of items) {
    map.set(item.id, { ...item, parentId });
    if (Array.isArray(item.children) && item.children.length > 0) {
      flattenNavigation(item.children, map, item.id);
    }
  }
}

function createNavNode(item, level = 0) {
  const wrapper = document.createElement('div');
  wrapper.className = 'nav-node';
  wrapper.style.setProperty('--depth', String(level));

  if (Array.isArray(item.children) && item.children.length > 0) {
    const label = document.createElement('p');
    label.className = 'nav-group';
    label.textContent = item.title;
    wrapper.appendChild(label);

    const branch = document.createElement('div');
    branch.className = 'nav-branch';
    for (const child of item.children) {
      branch.appendChild(createNavNode(child, level + 1));
    }
    wrapper.appendChild(branch);
    return wrapper;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav-item';
  btn.dataset.navId = item.id;
  btn.textContent = item.title;
  btn.addEventListener('click', () => {
    state.panBus.publish('runtime.nav.open', {
      appId: state.appId,
      navItemId: item.id
    });
  });
  wrapper.appendChild(btn);
  return wrapper;
}

function renderNavigation() {
  navTree.innerHTML = '';
  for (const item of state.appDefinition.navigation) {
    navTree.appendChild(createNavNode(item));
  }
}

function renderTabs() {
  tabs.innerHTML = '';
  tabPanels.innerHTML = '';

  for (const tab of state.openTabs) {
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.className = `tab-btn${tab.id === state.activeTabId ? ' active' : ''}`;
    tabBtn.textContent = tab.title;
    tabBtn.addEventListener('click', () => {
      state.activeTabId = tab.id;
      renderTabs();
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tab-close';
    closeBtn.textContent = 'x';
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });

    tabBtn.appendChild(closeBtn);
    tabs.appendChild(tabBtn);
    tab.panelEl.classList.toggle('active', tab.id === state.activeTabId);
    tabPanels.appendChild(tab.panelEl);
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.navId === state.activeTabId);
  });
}

function closeTab(tabId) {
  const index = state.openTabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;

  const [tab] = state.openTabs.splice(index, 1);
  tab.panelEl?.remove();
  if (state.activeTabId === tabId) {
    state.activeTabId = state.openTabs[index]?.id || state.openTabs[index - 1]?.id || null;
  }

  renderTabs();
}

function ensureTab(navItem) {
  const existing = state.openTabs.find((tab) => tab.id === navItem.id);
  if (existing) {
    state.activeTabId = existing.id;
    renderTabs();
    return existing;
  }

  const tab = {
    id: navItem.id,
    title: navItem.title,
    item: navItem,
    componentEl: null,
    panelEl: null
  };

  const panel = document.createElement('section');
  panel.className = 'tab-panel';
  panel.dataset.tabId = tab.id;

  const componentTag = tab.item.componentTag || 'bos-entity-form';
  if (!customElements.get(componentTag)) {
    panel.innerHTML = `<div class="panel-fallback">Unknown component '${componentTag}' for ${tab.title}</div>`;
  } else {
    const component = document.createElement(componentTag);
    component.config = {
      ...(tab.item.componentProps || {}),
      navItemId: tab.item.id
    };

    component.addEventListener('bos:runtime-event', (event) => {
      state.panBus.publish('runtime.event', {
        appId: state.appId,
        navItemId: tab.item.id,
        eventName: event.detail.event,
        context: event.detail.context || {}
      });
    });

    panel.appendChild(component);
    tab.componentEl = component;
  }

  tab.panelEl = panel;
  state.openTabs.push(tab);
  state.activeTabId = tab.id;
  renderTabs();
  return tab;
}

async function executeServerHook(hook, navItem, context) {
  const response = await fetch(`/api/apps/${encodeURIComponent(state.appId)}/hooks/${encodeURIComponent(hook.name)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      navItemId: navItem.id,
      options: hook.options || {},
      context
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Hook call failed (${response.status})`);
  }

  return response.json();
}

async function executeHooks(navItem, eventName, context) {
  const hooks = navItem.hooks?.[eventName] || [];
  for (const hook of hooks) {
    if (hook.type === 'client') {
      const handler = clientHookRegistry[hook.name];
      if (!handler) {
        console.warn(`Missing client hook '${hook.name}'`);
        continue;
      }
      await handler({ navItem, context, options: hook.options || {} });
      continue;
    }

    if (hook.type === 'server') {
      await executeServerHook(hook, navItem, {
        ...context,
        event: eventName
      });
    }
  }
}

async function handleNavOpen(message) {
  if (message.appId !== state.appId) return;
  const navItem = state.navById.get(message.navItemId);
  if (!navItem) return;

  if (Array.isArray(navItem.children) && navItem.children.length > 0) {
    return;
  }

  ensureTab(navItem);
  setStatus(`Opened ${navItem.title}`);
}

async function handleRuntimeEvent(message) {
  if (message.appId !== state.appId) return;
  const navItem = state.navById.get(message.navItemId);
  if (!navItem) return;
  await executeHooks(navItem, message.eventName, message.context || {});
}

async function loadAppDefinition() {
  const response = await fetch(`/api/apps/${encodeURIComponent(state.appId)}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Could not load app '${state.appId}'`);
  }

  state.appDefinition = await response.json();
  state.navById.clear();
  flattenNavigation(state.appDefinition.navigation, state.navById);
}

async function initPan() {
  await customElements.whenDefined('pan-bus');
  state.panBus = document.getElementById('appBus');

  state.panBus.subscribe('runtime.nav.open', async (message) => {
    try {
      await handleNavOpen(message.data || message.payload || {});
    } catch (error) {
      console.error(error);
      setStatus(error.message);
    }
  });

  state.panBus.subscribe('runtime.event', async (message) => {
    try {
      await handleRuntimeEvent(message.data || message.payload || {});
    } catch (error) {
      console.error(error);
      setStatus(error.message);
    }
  });
}

function firstLeafNavigationItem(items) {
  for (const item of items) {
    if (Array.isArray(item.children) && item.children.length > 0) {
      const found = firstLeafNavigationItem(item.children);
      if (found) return found;
      continue;
    }
    return item;
  }
  return null;
}

(async function init() {
  try {
    await initPan();
    await loadAppDefinition();

    appTitle.textContent = state.appDefinition.app.name;
    appMeta.textContent = `App ID: ${state.appDefinition.app.id} | Schema: ${state.appDefinition.version}`;

    renderNavigation();

    const firstLeaf = firstLeafNavigationItem(state.appDefinition.navigation);
    if (firstLeaf) {
      state.panBus.publish('runtime.nav.open', {
        appId: state.appId,
        navItemId: firstLeaf.id
      });
    }
  } catch (error) {
    appMeta.textContent = error.message;
  }
})();
