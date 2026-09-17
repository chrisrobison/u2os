// MOCK provider: contacts are just Person entities in the memory store.
// No real Google Contacts/etc connection.
import { findEntities } from '../memory/entity-store.js';

export function searchContacts({ query } = {}) {
  return findEntities({ type: 'Person', query });
}
