export class ToolRegistry {
  constructor() {
    this._tools = new Map();
    this._hidden = new Set();
  }

  // `hidden` tools (package capabilities, docs/plugin-architecture.md) can be
  // resolved and executed by the action gate and queue, but are never listed
  // to the planner and are refused by plan validation.
  register(tool, { hidden = false } = {}) {
    if (this._tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this._tools.set(tool.name, tool);
    if (hidden) this._hidden.add(tool.name);
    return tool;
  }

  unregister(name) {
    if (!this._hidden.has(name)) throw new Error(`Only hidden tools can be unregistered: ${name}`);
    this._tools.delete(name);
    this._hidden.delete(name);
  }

  get(name) {
    const tool = this._tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool;
  }

  has(name) {
    return this._tools.has(name);
  }

  isHidden(name) {
    return this._hidden.has(name);
  }

  hiddenNames() {
    return [...this._hidden];
  }

  /** Planner-visible tools only. */
  list() {
    return [...this._tools.values()].filter((tool) => !this._hidden.has(tool.name));
  }
}
