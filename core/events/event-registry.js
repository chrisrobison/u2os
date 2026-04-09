/**
 * Canonical cross-system event registry for U2OS and MindGraph.
 *
 * Source of truth for U2OS publish/subscribe names: /Users/cdr/Projects/u2os/core/events/event-registry.js
 */

/**
 * @typedef {Object} EntityCreatedPayload
 * @property {string} entity - Entity table name used by the generic router.
 * @property {string} id - Internal UUID identifier for the created record.
 * @property {string|null} public_id - Public identifier when configured; otherwise null.
 * @property {Object<string, any>} record - Full created record as returned by the repository.
 */

/**
 * @typedef {Object} EntityUpdatedPayload
 * @property {string} entity - Entity table name used by the generic router.
 * @property {string} id - Internal UUID identifier for the updated record.
 * @property {string|null} public_id - Public identifier when configured; otherwise null.
 * @property {Object<string, any>} record - Full updated record as returned by the repository.
 */

/**
 * @typedef {Object} EntityDeletedPayload
 * @property {string} entity - Entity table name used by the generic router.
 * @property {string} id - Internal UUID identifier for the deleted record.
 * @property {string|null} public_id - Public identifier when configured; otherwise null.
 */

/**
 * @typedef {Object} ClampCreatedPayload
 * @property {string} id - Clamp UUID identifier.
 * @property {Object<string, any>} record - Clamp record payload.
 * @property {string=} entity - Present for generic CRUD emits (`clamps`), omitted for link endpoint emits.
 * @property {string|null=} public_id - Present for generic CRUD emits when available.
 */

/**
 * @typedef {Object} AppointmentBookedPayload
 * @property {string} appointmentId - Appointment UUID identifier.
 * @property {string|null} customerId - Related customer UUID when present.
 * @property {string|null} startAt - Appointment start time in ISO-8601 format.
 * @property {string|null} scheduledAt - Publish timestamp in ISO-8601 format.
 * @property {Object<string, any>} record - Hydrated appointment record returned to the API caller.
 */

/**
 * @typedef {Object} TransportationRequestLifecycleCreatedPayload
 * @property {string} requestId - Transportation request UUID identifier.
 * @property {string|null} requestPublicId - Public request identifier when available.
 * @property {string|null} tripDate - Requested trip date (`YYYY-MM-DD`) when known.
 * @property {number|null} requestedHeadCount - Passenger head-count request when known.
 */

/**
 * @typedef {Object} TransportationTripScheduledPayload
 * @property {string} tripId - Transportation trip UUID identifier.
 * @property {string|null} tripPublicId - Public trip identifier when available.
 * @property {string|null} tripDate - Scheduled trip date (`YYYY-MM-DD`) when known.
 * @property {string|null} plannedDepartureAt - Planned departure timestamp in ISO-8601 format.
 */

/**
 * @typedef {Object} TransportationTripStartedPayload
 * @property {string} tripId - Transportation trip UUID identifier.
 * @property {string|null} tripPublicId - Public trip identifier when available.
 * @property {string} startedAt - Actual trip start timestamp in ISO-8601 format.
 */

/**
 * @typedef {Object} TransportationTripCompletedPayload
 * @property {string} tripId - Transportation trip UUID identifier.
 * @property {string|null} tripPublicId - Public trip identifier when available.
 * @property {string} resultId - Transportation trip result UUID identifier.
 * @property {string} completionStatus - Completion status (`completed` by default).
 */

/**
 * @typedef {Object} PaymentReceivedPayload
 * @property {string=} id - Payment identifier when provided by publisher.
 * @property {Object<string, any>=} payment - Optional payment object snapshot.
 * @property {Object<string, any>} [extra] - Additional source-specific metadata.
 */

/**
 * @typedef {EntityCreatedPayload} UserCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} UserUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} UserDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} OrganizationCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} OrganizationUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} OrganizationDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} CustomerCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} CustomerUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} CustomerDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} PetCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} PetUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} PetDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} ContactCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} ContactUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} ContactDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} ProductCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} ProductUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} ProductDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} ServiceCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} ServiceUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} ServiceDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} OrderCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} OrderUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} OrderDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} AppointmentCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} AppointmentUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} AppointmentDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} TransportationAddressCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} TransportationAddressUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} TransportationAddressDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} TransportationRequestRecordCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} TransportationRequestRecordUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} TransportationRequestRecordDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} TransportationTripRecordCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} TransportationTripRecordUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} TransportationTripRecordDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} TransportationWaypointCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} TransportationWaypointUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} TransportationWaypointDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} TransportationDriverCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} TransportationDriverUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} TransportationDriverDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} TransportationBusCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} TransportationBusUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} TransportationBusDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} TransportationInvoiceCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} TransportationInvoiceUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} TransportationInvoiceDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} TransportationPaymentCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} TransportationPaymentUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} TransportationPaymentDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} TransportationTripResultCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} TransportationTripResultUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} TransportationTripResultDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} InvoiceCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} InvoiceUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} InvoiceDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} PaymentCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} PaymentUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} PaymentDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} DocumentCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} DocumentUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} DocumentDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} TaskCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} TaskUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} TaskDeletedPayload
 */

/**
 * @typedef {EntityCreatedPayload} EventCreatedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} EventUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} EventDeletedPayload
 */

/**
 * @typedef {EntityUpdatedPayload} ClampUpdatedPayload
 */

/**
 * @typedef {EntityDeletedPayload} ClampDeletedPayload
 */

const EVENTS = Object.freeze({
  USER: Object.freeze({
    /** Generic user record creation event. Payload: UserCreatedPayload. */
    CREATED: 'user.created',
    /** Generic user record update event. Payload: UserUpdatedPayload. */
    UPDATED: 'user.updated',
    /** Generic user record deletion event. Payload: UserDeletedPayload. */
    DELETED: 'user.deleted',
  }),
  ORGANIZATION: Object.freeze({
    /** Generic organization record creation event. Payload: OrganizationCreatedPayload. */
    CREATED: 'organization.created',
    /** Generic organization record update event. Payload: OrganizationUpdatedPayload. */
    UPDATED: 'organization.updated',
    /** Generic organization record deletion event. Payload: OrganizationDeletedPayload. */
    DELETED: 'organization.deleted',
  }),
  CUSTOMER: Object.freeze({
    /** Generic customer record creation event. Payload: CustomerCreatedPayload. */
    CREATED: 'customer.created',
    /** Generic customer record update event. Payload: CustomerUpdatedPayload. */
    UPDATED: 'customer.updated',
    /** Generic customer record deletion event. Payload: CustomerDeletedPayload. */
    DELETED: 'customer.deleted',
  }),
  PET: Object.freeze({
    /** Legacy pet creation event name emitted by generic router. Payload: PetCreatedPayload. */
    CREATED: 'pe.created',
    /** Legacy pet update event name emitted by generic router. Payload: PetUpdatedPayload. */
    UPDATED: 'pe.updated',
    /** Legacy pet deletion event name emitted by generic router. Payload: PetDeletedPayload. */
    DELETED: 'pe.deleted',
  }),
  CONTACT: Object.freeze({
    /** Generic contact record creation event. Payload: ContactCreatedPayload. */
    CREATED: 'contact.created',
    /** Generic contact record update event. Payload: ContactUpdatedPayload. */
    UPDATED: 'contact.updated',
    /** Generic contact record deletion event. Payload: ContactDeletedPayload. */
    DELETED: 'contact.deleted',
  }),
  PRODUCT: Object.freeze({
    /** Generic product record creation event. Payload: ProductCreatedPayload. */
    CREATED: 'product.created',
    /** Generic product record update event. Payload: ProductUpdatedPayload. */
    UPDATED: 'product.updated',
    /** Generic product record deletion event. Payload: ProductDeletedPayload. */
    DELETED: 'product.deleted',
  }),
  SERVICE: Object.freeze({
    /** Generic service record creation event. Payload: ServiceCreatedPayload. */
    CREATED: 'service.created',
    /** Generic service record update event. Payload: ServiceUpdatedPayload. */
    UPDATED: 'service.updated',
    /** Generic service record deletion event. Payload: ServiceDeletedPayload. */
    DELETED: 'service.deleted',
  }),
  ORDER: Object.freeze({
    /** Generic order record creation event. Payload: OrderCreatedPayload. */
    CREATED: 'order.created',
    /** Generic order record update event. Payload: OrderUpdatedPayload. */
    UPDATED: 'order.updated',
    /** Generic order record deletion event. Payload: OrderDeletedPayload. */
    DELETED: 'order.deleted',
  }),
  APPOINTMENT: Object.freeze({
    /** Generic appointment record creation event. Payload: AppointmentCreatedPayload. */
    CREATED: 'appointment.created',
    /** Generic appointment record update event. Payload: AppointmentUpdatedPayload. */
    UPDATED: 'appointment.updated',
    /** Generic appointment record deletion event. Payload: AppointmentDeletedPayload. */
    DELETED: 'appointment.deleted',
    /** Salon booking event emitted by the salon module. Payload: AppointmentBookedPayload. */
    BOOKED: 'appointment.booked',
  }),
  TRANSPORTATION_ADDRESS: Object.freeze({
    /** Legacy transportation address creation event name emitted by generic router. Payload: TransportationAddressCreatedPayload. */
    CREATED: 'transportation_addresse.created',
    /** Legacy transportation address update event name emitted by generic router. Payload: TransportationAddressUpdatedPayload. */
    UPDATED: 'transportation_addresse.updated',
    /** Legacy transportation address deletion event name emitted by generic router. Payload: TransportationAddressDeletedPayload. */
    DELETED: 'transportation_addresse.deleted',
  }),
  TRANSPORTATION_REQUEST_RECORD: Object.freeze({
    /** Generic transportation request record creation event. Payload: TransportationRequestRecordCreatedPayload. */
    CREATED: 'transportation_request.created',
    /** Generic transportation request record update event. Payload: TransportationRequestRecordUpdatedPayload. */
    UPDATED: 'transportation_request.updated',
    /** Generic transportation request record deletion event. Payload: TransportationRequestRecordDeletedPayload. */
    DELETED: 'transportation_request.deleted',
  }),
  TRANSPORTATION_TRIP_RECORD: Object.freeze({
    /** Generic transportation trip record creation event. Payload: TransportationTripRecordCreatedPayload. */
    CREATED: 'transportation_trip.created',
    /** Generic transportation trip record update event. Payload: TransportationTripRecordUpdatedPayload. */
    UPDATED: 'transportation_trip.updated',
    /** Generic transportation trip record deletion event. Payload: TransportationTripRecordDeletedPayload. */
    DELETED: 'transportation_trip.deleted',
  }),
  TRANSPORTATION_WAYPOINT: Object.freeze({
    /** Generic transportation waypoint record creation event. Payload: TransportationWaypointCreatedPayload. */
    CREATED: 'transportation_waypoint.created',
    /** Generic transportation waypoint record update event. Payload: TransportationWaypointUpdatedPayload. */
    UPDATED: 'transportation_waypoint.updated',
    /** Generic transportation waypoint record deletion event. Payload: TransportationWaypointDeletedPayload. */
    DELETED: 'transportation_waypoint.deleted',
  }),
  TRANSPORTATION_DRIVER: Object.freeze({
    /** Generic transportation driver record creation event. Payload: TransportationDriverCreatedPayload. */
    CREATED: 'transportation_driver.created',
    /** Generic transportation driver record update event. Payload: TransportationDriverUpdatedPayload. */
    UPDATED: 'transportation_driver.updated',
    /** Generic transportation driver record deletion event. Payload: TransportationDriverDeletedPayload. */
    DELETED: 'transportation_driver.deleted',
  }),
  TRANSPORTATION_BUS: Object.freeze({
    /** Legacy transportation bus creation event name emitted by generic router. Payload: TransportationBusCreatedPayload. */
    CREATED: 'transportation_buse.created',
    /** Legacy transportation bus update event name emitted by generic router. Payload: TransportationBusUpdatedPayload. */
    UPDATED: 'transportation_buse.updated',
    /** Legacy transportation bus deletion event name emitted by generic router. Payload: TransportationBusDeletedPayload. */
    DELETED: 'transportation_buse.deleted',
  }),
  TRANSPORTATION_INVOICE: Object.freeze({
    /** Generic transportation invoice record creation event. Payload: TransportationInvoiceCreatedPayload. */
    CREATED: 'transportation_invoice.created',
    /** Generic transportation invoice record update event. Payload: TransportationInvoiceUpdatedPayload. */
    UPDATED: 'transportation_invoice.updated',
    /** Generic transportation invoice record deletion event. Payload: TransportationInvoiceDeletedPayload. */
    DELETED: 'transportation_invoice.deleted',
  }),
  TRANSPORTATION_PAYMENT: Object.freeze({
    /** Generic transportation payment record creation event. Payload: TransportationPaymentCreatedPayload. */
    CREATED: 'transportation_payment.created',
    /** Generic transportation payment record update event. Payload: TransportationPaymentUpdatedPayload. */
    UPDATED: 'transportation_payment.updated',
    /** Generic transportation payment record deletion event. Payload: TransportationPaymentDeletedPayload. */
    DELETED: 'transportation_payment.deleted',
  }),
  TRANSPORTATION_TRIP_RESULT: Object.freeze({
    /** Generic transportation trip result record creation event. Payload: TransportationTripResultCreatedPayload. */
    CREATED: 'transportation_trip_result.created',
    /** Generic transportation trip result record update event. Payload: TransportationTripResultUpdatedPayload. */
    UPDATED: 'transportation_trip_result.updated',
    /** Generic transportation trip result record deletion event. Payload: TransportationTripResultDeletedPayload. */
    DELETED: 'transportation_trip_result.deleted',
  }),
  INVOICE: Object.freeze({
    /** Generic invoice record creation event. Payload: InvoiceCreatedPayload. */
    CREATED: 'invoice.created',
    /** Generic invoice record update event. Payload: InvoiceUpdatedPayload. */
    UPDATED: 'invoice.updated',
    /** Generic invoice record deletion event. Payload: InvoiceDeletedPayload. */
    DELETED: 'invoice.deleted',
  }),
  PAYMENT: Object.freeze({
    /** Generic payment record creation event. Payload: PaymentCreatedPayload. */
    CREATED: 'payment.created',
    /** Generic payment record update event. Payload: PaymentUpdatedPayload. */
    UPDATED: 'payment.updated',
    /** Generic payment record deletion event. Payload: PaymentDeletedPayload. */
    DELETED: 'payment.deleted',
    /** Payment receipt lifecycle event consumed by salon module workflows. Payload: PaymentReceivedPayload. */
    RECEIVED: 'payment.received',
  }),
  DOCUMENT: Object.freeze({
    /** Generic document record creation event. Payload: DocumentCreatedPayload. */
    CREATED: 'document.created',
    /** Generic document record update event. Payload: DocumentUpdatedPayload. */
    UPDATED: 'document.updated',
    /** Generic document record deletion event. Payload: DocumentDeletedPayload. */
    DELETED: 'document.deleted',
  }),
  TASK: Object.freeze({
    /** Generic task record creation event. Payload: TaskCreatedPayload. */
    CREATED: 'task.created',
    /** Generic task record update event. Payload: TaskUpdatedPayload. */
    UPDATED: 'task.updated',
    /** Generic task record deletion event. Payload: TaskDeletedPayload. */
    DELETED: 'task.deleted',
  }),
  EVENT: Object.freeze({
    /** Generic event record creation event. Payload: EventCreatedPayload. */
    CREATED: 'event.created',
    /** Generic event record update event. Payload: EventUpdatedPayload. */
    UPDATED: 'event.updated',
    /** Generic event record deletion event. Payload: EventDeletedPayload. */
    DELETED: 'event.deleted',
  }),
  CLAMP: Object.freeze({
    /** Clamp record/link creation event; payload varies by route. Payload: ClampCreatedPayload. */
    CREATED: 'clamp.created',
    /** Generic clamp record update event. Payload: ClampUpdatedPayload. */
    UPDATED: 'clamp.updated',
    /** Generic clamp record deletion event. Payload: ClampDeletedPayload. */
    DELETED: 'clamp.deleted',
  }),
  TRANSPORTATION: Object.freeze({
    REQUEST: Object.freeze({
      /** Transportation request lifecycle event emitted by transportation module. Payload: TransportationRequestLifecycleCreatedPayload. */
      CREATED: 'transportation.request.created',
    }),
    TRIP: Object.freeze({
      /** Transportation trip scheduling lifecycle event. Payload: TransportationTripScheduledPayload. */
      SCHEDULED: 'transportation.trip.scheduled',
      /** Transportation trip start lifecycle event. Payload: TransportationTripStartedPayload. */
      STARTED: 'transportation.trip.started',
      /** Transportation trip completion lifecycle event. Payload: TransportationTripCompletedPayload. */
      COMPLETED: 'transportation.trip.completed',
    }),
  }),
});

const EVENT_PAYLOAD_TYPEDEFS = Object.freeze({
  'user.created': 'UserCreatedPayload',
  'user.updated': 'UserUpdatedPayload',
  'user.deleted': 'UserDeletedPayload',
  'organization.created': 'OrganizationCreatedPayload',
  'organization.updated': 'OrganizationUpdatedPayload',
  'organization.deleted': 'OrganizationDeletedPayload',
  'customer.created': 'CustomerCreatedPayload',
  'customer.updated': 'CustomerUpdatedPayload',
  'customer.deleted': 'CustomerDeletedPayload',
  'pe.created': 'PetCreatedPayload',
  'pe.updated': 'PetUpdatedPayload',
  'pe.deleted': 'PetDeletedPayload',
  'contact.created': 'ContactCreatedPayload',
  'contact.updated': 'ContactUpdatedPayload',
  'contact.deleted': 'ContactDeletedPayload',
  'product.created': 'ProductCreatedPayload',
  'product.updated': 'ProductUpdatedPayload',
  'product.deleted': 'ProductDeletedPayload',
  'service.created': 'ServiceCreatedPayload',
  'service.updated': 'ServiceUpdatedPayload',
  'service.deleted': 'ServiceDeletedPayload',
  'order.created': 'OrderCreatedPayload',
  'order.updated': 'OrderUpdatedPayload',
  'order.deleted': 'OrderDeletedPayload',
  'appointment.created': 'AppointmentCreatedPayload',
  'appointment.updated': 'AppointmentUpdatedPayload',
  'appointment.deleted': 'AppointmentDeletedPayload',
  'appointment.booked': 'AppointmentBookedPayload',
  'transportation_addresse.created': 'TransportationAddressCreatedPayload',
  'transportation_addresse.updated': 'TransportationAddressUpdatedPayload',
  'transportation_addresse.deleted': 'TransportationAddressDeletedPayload',
  'transportation_request.created': 'TransportationRequestRecordCreatedPayload',
  'transportation_request.updated': 'TransportationRequestRecordUpdatedPayload',
  'transportation_request.deleted': 'TransportationRequestRecordDeletedPayload',
  'transportation_trip.created': 'TransportationTripRecordCreatedPayload',
  'transportation_trip.updated': 'TransportationTripRecordUpdatedPayload',
  'transportation_trip.deleted': 'TransportationTripRecordDeletedPayload',
  'transportation_waypoint.created': 'TransportationWaypointCreatedPayload',
  'transportation_waypoint.updated': 'TransportationWaypointUpdatedPayload',
  'transportation_waypoint.deleted': 'TransportationWaypointDeletedPayload',
  'transportation_driver.created': 'TransportationDriverCreatedPayload',
  'transportation_driver.updated': 'TransportationDriverUpdatedPayload',
  'transportation_driver.deleted': 'TransportationDriverDeletedPayload',
  'transportation_buse.created': 'TransportationBusCreatedPayload',
  'transportation_buse.updated': 'TransportationBusUpdatedPayload',
  'transportation_buse.deleted': 'TransportationBusDeletedPayload',
  'transportation_invoice.created': 'TransportationInvoiceCreatedPayload',
  'transportation_invoice.updated': 'TransportationInvoiceUpdatedPayload',
  'transportation_invoice.deleted': 'TransportationInvoiceDeletedPayload',
  'transportation_payment.created': 'TransportationPaymentCreatedPayload',
  'transportation_payment.updated': 'TransportationPaymentUpdatedPayload',
  'transportation_payment.deleted': 'TransportationPaymentDeletedPayload',
  'transportation_trip_result.created': 'TransportationTripResultCreatedPayload',
  'transportation_trip_result.updated': 'TransportationTripResultUpdatedPayload',
  'transportation_trip_result.deleted': 'TransportationTripResultDeletedPayload',
  'invoice.created': 'InvoiceCreatedPayload',
  'invoice.updated': 'InvoiceUpdatedPayload',
  'invoice.deleted': 'InvoiceDeletedPayload',
  'payment.created': 'PaymentCreatedPayload',
  'payment.updated': 'PaymentUpdatedPayload',
  'payment.deleted': 'PaymentDeletedPayload',
  'payment.received': 'PaymentReceivedPayload',
  'document.created': 'DocumentCreatedPayload',
  'document.updated': 'DocumentUpdatedPayload',
  'document.deleted': 'DocumentDeletedPayload',
  'task.created': 'TaskCreatedPayload',
  'task.updated': 'TaskUpdatedPayload',
  'task.deleted': 'TaskDeletedPayload',
  'event.created': 'EventCreatedPayload',
  'event.updated': 'EventUpdatedPayload',
  'event.deleted': 'EventDeletedPayload',
  'clamp.created': 'ClampCreatedPayload',
  'clamp.updated': 'ClampUpdatedPayload',
  'clamp.deleted': 'ClampDeletedPayload',
  'transportation.request.created': 'TransportationRequestLifecycleCreatedPayload',
  'transportation.trip.scheduled': 'TransportationTripScheduledPayload',
  'transportation.trip.started': 'TransportationTripStartedPayload',
  'transportation.trip.completed': 'TransportationTripCompletedPayload',
});

const ENTITY_EVENT_DOMAINS = Object.freeze({
  users: EVENTS.USER,
  organizations: EVENTS.ORGANIZATION,
  customers: EVENTS.CUSTOMER,
  pet: EVENTS.PET,
  contacts: EVENTS.CONTACT,
  products: EVENTS.PRODUCT,
  services: EVENTS.SERVICE,
  orders: EVENTS.ORDER,
  appointments: EVENTS.APPOINTMENT,
  transportation_addresses: EVENTS.TRANSPORTATION_ADDRESS,
  transportation_requests: EVENTS.TRANSPORTATION_REQUEST_RECORD,
  transportation_trips: EVENTS.TRANSPORTATION_TRIP_RECORD,
  transportation_waypoints: EVENTS.TRANSPORTATION_WAYPOINT,
  transportation_drivers: EVENTS.TRANSPORTATION_DRIVER,
  transportation_buses: EVENTS.TRANSPORTATION_BUS,
  transportation_invoices: EVENTS.TRANSPORTATION_INVOICE,
  transportation_payments: EVENTS.TRANSPORTATION_PAYMENT,
  transportation_trip_results: EVENTS.TRANSPORTATION_TRIP_RESULT,
  invoices: EVENTS.INVOICE,
  payments: EVENTS.PAYMENT,
  documents: EVENTS.DOCUMENT,
  tasks: EVENTS.TASK,
  events: EVENTS.EVENT,
  clamps: EVENTS.CLAMP,
});

function getEntityEventName(entity, action) {
  const normalizedEntity = String(entity || "").trim();
  const normalizedAction = String(action || "").trim().toUpperCase();
  const domain = ENTITY_EVENT_DOMAINS[normalizedEntity];

  if (!domain || !domain[normalizedAction]) {
    throw new Error(`No registered event for entity ${normalizedEntity} action ${normalizedAction}`);
  }

  return domain[normalizedAction];
}

function collectEventNames(node, bucket = []) {
  for (const value of Object.values(node || {})) {
    if (typeof value === "string") {
      bucket.push(value);
      continue;
    }

    collectEventNames(value, bucket);
  }
  return bucket;
}

const EVENT_NAMES = Object.freeze(collectEventNames(EVENTS));

module.exports = {
  EVENTS,
  EVENT_PAYLOAD_TYPEDEFS,
  ENTITY_EVENT_DOMAINS,
  EVENT_NAMES,
  getEntityEventName
};
