import { Tool } from './tool.js';
import * as contactsProvider from '../integrations/mock-contacts-provider.js';

export class ContactsSearchTool extends Tool {
  get name() { return 'contacts.search'; }
  get domain() { return 'contacts'; }
  get category() { return 'read'; }
  get schema() {
    return { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
  }
  async execute(args) {
    return contactsProvider.searchContacts(args);
  }
}
