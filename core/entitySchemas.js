const { hasPublicId } = require('./publicIds');

const schemas = {
  users: {
    singular: 'user',
    fields: [
      { name: 'first_name', type: 'string' },
      { name: 'last_name', type: 'string' },
      { name: 'email', type: 'email' },
      { name: 'phone', type: 'phone' },
      { name: 'cell', type: 'phone' },
      { name: 'sms', type: 'boolean' },
      { name: 'role', type: 'string' },
      { name: 'status', type: 'string' }
    ]
  },
  organizations: {
    singular: 'organization',
    fields: [
      { name: 'legal_name', type: 'string' },
      { name: 'email', type: 'email' },
      { name: 'phone', type: 'phone' },
      { name: 'cell', type: 'phone' },
      { name: 'website', type: 'url' },
      { name: 'address_line1', type: 'string' },
      { name: 'address_line2', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'state', type: 'string' },
      { name: 'postal_code', type: 'string' },
      { name: 'country', type: 'string' },
      { name: 'status', type: 'string' }
    ]
  },
  customers: {
    singular: 'customer',
    fields: [
      { name: 'organization_id', type: 'id' },
      { name: 'first_name', type: 'string' },
      { name: 'last_name', type: 'string' },
      { name: 'email', type: 'email' },
      { name: 'phone', type: 'phone' },
      { name: 'cell', type: 'phone' },
      { name: 'sms', type: 'boolean' },
      { name: 'status', type: 'string' },
      { name: 'notes', type: 'text' }
    ]
  },
  contacts: {
    singular: 'contact',
    fields: [
      { name: 'organization_id', type: 'id' },
      { name: 'first_name', type: 'string' },
      { name: 'last_name', type: 'string' },
      { name: 'email', type: 'email' },
      { name: 'phone', type: 'phone' },
      { name: 'cell', type: 'phone' },
      { name: 'sms', type: 'boolean' },
      { name: 'title', type: 'string' },
      { name: 'company', type: 'string' },
      { name: 'notes', type: 'text' }
    ]
  },
  products: {
    singular: 'product',
    fields: [
      { name: 'sku', type: 'string' },
      { name: 'description', type: 'text' },
      { name: 'price', type: 'money' },
      { name: 'currency', type: 'string' },
      { name: 'stock_quantity', type: 'integer' },
      { name: 'status', type: 'string' }
    ]
  },
  services: {
    singular: 'service',
    fields: [
      { name: 'description', type: 'text' },
      { name: 'duration_minutes', type: 'integer' },
      { name: 'rate', type: 'money' },
      { name: 'currency', type: 'string' },
      { name: 'status', type: 'string' }
    ]
  },
  orders: {
    singular: 'order',
    fields: [
      { name: 'customer_id', type: 'id' },
      { name: 'organization_id', type: 'id' },
      { name: 'status', type: 'string' },
      { name: 'total', type: 'money' },
      { name: 'currency', type: 'string' },
      { name: 'ordered_at', type: 'datetime' },
      { name: 'due_at', type: 'datetime' },
      { name: 'notes', type: 'text' }
    ]
  },
  appointments: {
    singular: 'appointment',
    fields: [
      { name: 'customer_id', type: 'id' },
      { name: 'staff_user_id', type: 'id' },
      { name: 'start_at', type: 'datetime' },
      { name: 'end_at', type: 'datetime' },
      { name: 'status', type: 'string' },
      { name: 'location', type: 'string' },
      { name: 'notes', type: 'text' }
    ]
  },
  invoices: {
    singular: 'invoice',
    fields: [
      { name: 'customer_id', type: 'id' },
      { name: 'organization_id', type: 'id' },
      { name: 'invoice_number', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'issue_date', type: 'date' },
      { name: 'due_date', type: 'date' },
      { name: 'subtotal', type: 'money' },
      { name: 'tax', type: 'money' },
      { name: 'total', type: 'money' },
      { name: 'currency', type: 'string' },
      { name: 'notes', type: 'text' }
    ]
  },
  payments: {
    singular: 'payment',
    fields: [
      { name: 'invoice_id', type: 'id' },
      { name: 'customer_id', type: 'id' },
      { name: 'amount', type: 'money' },
      { name: 'currency', type: 'string' },
      { name: 'method', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'paid_at', type: 'datetime' },
      { name: 'reference', type: 'string' }
    ]
  },
  documents: {
    singular: 'document',
    fields: [
      { name: 'customer_id', type: 'id' },
      { name: 'organization_id', type: 'id' },
      { name: 'document_type', type: 'string' },
      { name: 'file_url', type: 'url' },
      { name: 'status', type: 'string' },
      { name: 'notes', type: 'text' }
    ]
  },
  tasks: {
    singular: 'task',
    fields: [
      { name: 'customer_id', type: 'id' },
      { name: 'assigned_user_id', type: 'id' },
      { name: 'status', type: 'string' },
      { name: 'priority', type: 'string' },
      { name: 'due_at', type: 'datetime' },
      { name: 'details', type: 'text' }
    ]
  },
  events: {
    singular: 'event',
    fields: [
      { name: 'event_type', type: 'string' },
      { name: 'subject_type', type: 'string' },
      { name: 'subject_id', type: 'id' },
      { name: 'payload', type: 'json' },
      { name: 'occurred_at', type: 'datetime' }
    ]
  },
  clamps: {
    singular: 'clamp',
    fields: [
      { name: 'local', type: 'string' },
      { name: 'local_id', type: 'id' },
      { name: 'remote', type: 'string' },
      { name: 'remote_id', type: 'id' },
      { name: 'context', type: 'string' }
    ]
  }
};

function buildSchema(entity) {
  const def = schemas[entity];
  if (!def) {
    return null;
  }

  const hasPublicIdentifier = hasPublicId(entity);
  const publicIdColumns = hasPublicIdentifier
    ? [{ name: 'public_id', type: 'string', nullable: true }]
    : [];

  return {
    singular: def.singular,
    columns: [
      { name: 'id', type: 'id', primary: true, nullable: false },
      ...publicIdColumns,
      { name: def.singular, type: 'string', nullable: true },
      ...def.fields,
      { name: 'created', type: 'datetime', nullable: false, defaultNow: true, readOnly: true },
      { name: 'modified', type: 'timestamp', nullable: false, defaultNow: true, readOnly: true }
    ]
  };
}

module.exports = {
  schemas,
  buildSchema
};
