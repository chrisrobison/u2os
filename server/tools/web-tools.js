import { Tool } from './tool.js';
import { getProvider, getProviderForBinding } from '../integrations/provider-registry.js';

export class WebSearchTool extends Tool {
  get name() { return 'web.search'; }
  get domain() { return 'web'; }
  get category() { return 'read'; }
  get requiresAccountBinding() { return true; }
  get schema() {
    return { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
  }
  async execute(args, context) {
    const provider = context?.accountBinding ? getProviderForBinding('web', context.accountBinding) : getProvider('web');
    return provider.search(args);
  }
}
