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
  pet: {
    singular: 'pet',
    fields: [
      { name: 'customer_id', type: 'id' },
      { name: 'species', type: 'string' },
      { name: 'breed', type: 'string' },
      { name: 'sex', type: 'string' },
      { name: 'birth_date', type: 'date' },
      { name: 'weight', type: 'money' },
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
  transportation_addresses: {
    singular: 'transportation_address',
    fields: [
      { name: 'label', type: 'string' },
      { name: 'location_type', type: 'string' },
      { name: 'line1', type: 'string' },
      { name: 'line2', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'state', type: 'string' },
      { name: 'postal_code', type: 'string' },
      { name: 'country', type: 'string' },
      { name: 'latitude', type: 'money' },
      { name: 'longitude', type: 'money' },
      { name: 'place_id', type: 'string' },
      { name: 'notes', type: 'text' }
    ]
  },
  transportation_requests: {
    singular: 'transportation_request',
    fields: [
      { name: 'customer_id', type: 'id' },
      { name: 'trip_date', type: 'date' },
      { name: 'pickup_address_id', type: 'id' },
      { name: 'dropoff_address_id', type: 'id' },
      { name: 'requested_head_count', type: 'integer' },
      { name: 'school_name', type: 'string' },
      { name: 'trip_type', type: 'string' },
      { name: 'requested_departure_at', type: 'datetime' },
      { name: 'requested_return_at', type: 'datetime' },
      { name: 'status', type: 'string' },
      { name: 'quoted_amount', type: 'money' },
      { name: 'currency', type: 'string' },
      { name: 'notes', type: 'text' }
    ]
  },
  transportation_trips: {
    singular: 'transportation_trip',
    fields: [
      { name: 'request_id', type: 'id' },
      { name: 'customer_id', type: 'id' },
      { name: 'driver_id', type: 'id' },
      { name: 'bus_id', type: 'id' },
      { name: 'trip_date', type: 'date' },
      { name: 'pickup_address_id', type: 'id' },
      { name: 'dropoff_address_id', type: 'id' },
      { name: 'planned_head_count', type: 'integer' },
      { name: 'planned_departure_at', type: 'datetime' },
      { name: 'planned_arrival_at', type: 'datetime' },
      { name: 'status', type: 'string' },
      { name: 'route_name', type: 'string' },
      { name: 'route_notes', type: 'text' }
    ]
  },
  transportation_waypoints: {
    singular: 'transportation_waypoint',
    fields: [
      { name: 'trip_id', type: 'id' },
      { name: 'address_id', type: 'id' },
      { name: 'waypoint_order', type: 'integer' },
      { name: 'planned_arrival_at', type: 'datetime' },
      { name: 'planned_departure_at', type: 'datetime' },
      { name: 'status', type: 'string' },
      { name: 'notes', type: 'text' }
    ]
  },
  transportation_drivers: {
    singular: 'transportation_driver',
    fields: [
      { name: 'user_id', type: 'id' },
      { name: 'license_number', type: 'string' },
      { name: 'license_class', type: 'string' },
      { name: 'license_expires_on', type: 'date' },
      { name: 'phone', type: 'phone' },
      { name: 'status', type: 'string' },
      { name: 'home_base_address_id', type: 'id' },
      { name: 'notes', type: 'text' }
    ]
  },
  transportation_buses: {
    singular: 'transportation_bus',
    fields: [
      { name: 'bus_number', type: 'string' },
      { name: 'plate_number', type: 'string' },
      { name: 'make', type: 'string' },
      { name: 'model', type: 'string' },
      { name: 'capacity', type: 'integer' },
      { name: 'wheelchair_accessible', type: 'boolean' },
      { name: 'status', type: 'string' },
      { name: 'depot_address_id', type: 'id' },
      { name: 'odometer_reading', type: 'money' },
      { name: 'notes', type: 'text' }
    ]
  },
  transportation_invoices: {
    singular: 'transportation_invoice',
    fields: [
      { name: 'trip_id', type: 'id' },
      { name: 'request_id', type: 'id' },
      { name: 'customer_id', type: 'id' },
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
  transportation_payments: {
    singular: 'transportation_payment',
    fields: [
      { name: 'transportation_invoice_id', type: 'id' },
      { name: 'customer_id', type: 'id' },
      { name: 'amount', type: 'money' },
      { name: 'currency', type: 'string' },
      { name: 'method', type: 'string' },
      { name: 'status', type: 'string' },
      { name: 'paid_at', type: 'datetime' },
      { name: 'reference', type: 'string' },
      { name: 'notes', type: 'text' }
    ]
  },
  transportation_trip_results: {
    singular: 'transportation_trip_result',
    fields: [
      { name: 'trip_id', type: 'id' },
      { name: 'actual_head_count', type: 'integer' },
      { name: 'actual_departure_at', type: 'datetime' },
      { name: 'actual_arrival_at', type: 'datetime' },
      { name: 'actual_miles', type: 'money' },
      { name: 'fuel_cost', type: 'money' },
      { name: 'toll_cost', type: 'money' },
      { name: 'incident_notes', type: 'text' },
      { name: 'completion_status', type: 'string' },
      { name: 'recorded_by_driver_id', type: 'id' },
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
