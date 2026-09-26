import { Tool } from './tool.js';
import { getProvider, getProviderForBinding } from '../integrations/provider-registry.js';

export class ContactsSearchTool extends Tool {
  get name() { return 'contacts.search'; }
  get domain() { return 'contacts'; }
  get category() { return 'read'; }
  get requiresAccountBinding() { return true; }
  get schema() {
    return { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
  }
  async execute(args, context) {
    const provider = context?.accountBinding ? getProviderForBinding('contacts', context.accountBinding) : getProvider('contacts');
    return provider.searchContacts(args);
  }
}
