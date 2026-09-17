export class ToolRegistry {
  constructor() {
    this._tools = new Map();
  }

  register(tool) {
    if (this._tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this._tools.set(tool.name, tool);
    return tool;
  }

  get(name) {
    const tool = this._tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool;
  }

  has(name) {
    return this._tools.has(name);
  }

  list() {
    return [...this._tools.values()];
  }
}
