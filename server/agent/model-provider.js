/**
 * Provider-agnostic interface a model provider (real or mock) must implement.
 * The agent orchestrator (agent.js) only ever talks to this interface, never
 * to a vendor SDK directly, so the LLM stays swappable infrastructure per
 * PROMPT.md ("The agent is not the model.").
 *
 * @typedef {Object} PlanContext
 * @property {import('../tools/registry.js').ToolRegistry} toolRegistry
 * @property {import('../events/event-bus.js').EventBus} eventBus
 * @property {string} correlationId
 * @property {{type: string, id: string}} actor
 *
 * @typedef {Object} Plan
 * @property {string} reasoning_summary
 * @property {Array<{tool: string, arguments: object}>} actions
 */
export class ModelProvider {
  id = 'model-provider';
  /** @returns {Promise<Plan>} */
  async plan(_context, _objective) {
    throw new Error('plan() not implemented');
  }

  /** @returns {Promise<string>} */
  async respond(_context, _message) {
    throw new Error('respond() not implemented');
  }

  /** @returns {Promise<object>} */
  async evaluateEvent(_event, _context) {
    throw new Error('evaluateEvent() not implemented');
  }

  /** @returns {Promise<string>} */
  async summarize(_items) {
    throw new Error('summarize() not implemented');
  }

  /** @returns {Promise<object[]>} */
  async extractEntities(_content) {
    throw new Error('extractEntities() not implemented');
  }
}
