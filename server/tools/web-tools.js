import { Tool } from './tool.js';
import { getProvider } from '../integrations/provider-registry.js';

export class WebSearchTool extends Tool {
  get name() { return 'web.search'; }
  get domain() { return 'web'; }
  get category() { return 'read'; }
  get schema() {
    return { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
  }
  async execute(args) {
    const provider = getProvider('web');
    return provider.search(args);
  }
}
