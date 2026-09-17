/**
 * Base Tool class. Every concrete tool declares a name, a domain (matching a
 * top-level policies.yaml key), a category ('read' | 'draft' | 'consequential'),
 * a JSON Schema for its arguments, and an execute(args, context) method.
 *
 * Tools never call the LLM and never call each other -- only the agent
 * orchestrator calls tools, and only through the ToolRegistry.
 */
export class Tool {
  get name() {
    throw new Error('Tool.name not implemented');
  }

  get domain() {
    throw new Error('Tool.domain not implemented');
  }

  get category() {
    throw new Error('Tool.category not implemented');
  }

  get schema() {
    return { type: 'object', properties: {}, required: [] };
  }

  // context: { eventBus, correlationId, actor }
  async execute(_args, _context) {
    throw new Error(`Tool.execute not implemented for ${this.name}`);
  }
}
