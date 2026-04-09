const { assertAllowedKeys, validateIdentifier, badRequest } = require('../../core/validation');
const { EVENTS } = require('../../core/events/event-registry');

function parseLimit(value, fallback = 50, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseOffset(value, fallback = 0, max = 5000) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function parseMoney(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  if (Number.isNaN(num)) return null;
  return num;
}

function toIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function dateKey(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 7);
}

function fullName(record, singular) {
  if (!record) return null;
  if (record.first_name || record.last_name) {
    return [record.first_name, record.last_name].filter(Boolean).join(' ').trim();
  }
  return record[singular] || null;
}

function formatAddress(address) {
  if (!address) return null;
  const parts = [
    address.label,
    address.line1,
    address.line2,
    [address.city, address.state, address.postal_code].filter(Boolean).join(' '),
    address.country
  ]
    .filter(Boolean)
    .map((item) => String(item).trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return address.transportation_address || null;
  }

  return parts.join(', ');
}

function summarizeAddress(address) {
  if (!address) return null;
  return {
    id: address.id,
    public_id: address.public_id || null,
    label: address.label || null,
    line1: address.line1 || null,
    line2: address.line2 || null,
    city: address.city || null,
    state: address.state || null,
    postal_code: address.postal_code || null,
    country: address.country || null,
    formatted: formatAddress(address),
    latitude: address.latitude != null ? Number(address.latitude) : null,
    longitude: address.longitude != null ? Number(address.longitude) : null
  };
}

function sanitizeStatus(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized;
}

function sanitizeText(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function sanitizeInteger(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function numericOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDateValue(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  return dateKey(value);
}

function pickupDropoffValue(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value.address_id || value.id || value.public_id || value.address || null;
  }
  return null;
}

function buildFilterRange(fromDate, toDate, dateColumn) {
  return [
    ...(fromDate ? [{ column: dateColumn, op: 'gte', value: fromDate }] : []),
    ...(toDate ? [{ column: dateColumn, op: 'lte', value: toDate }] : [])
  ];
}

function computeRoutePlot(stops) {
  const withCoords = stops
    .map((stop) => ({
      ...stop,
      latitude: numericOrNull(stop.latitude),
      longitude: numericOrNull(stop.longitude)
    }))
    .filter((stop) => stop.latitude != null && stop.longitude != null);

  if (withCoords.length < 2) {
    return {
      points: [],
      polyline: '',
      hasPlot: false
    };
  }

  const lats = withCoords.map((stop) => stop.latitude);
  const lngs = withCoords.map((stop) => stop.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const latSpan = Math.max(maxLat - minLat, 0.001);
  const lngSpan = Math.max(maxLng - minLng, 0.001);

  const points = withCoords.map((stop, index) => {
    const x = 40 + ((stop.longitude - minLng) / lngSpan) * 540;
    const y = 320 - ((stop.latitude - minLat) / latSpan) * 260;
    return {
      ...stop,
      route_index: index,
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2))
    };
  });

  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');
  return {
    points,
    polyline,
    hasPlot: true
  };
}

function buildGoogleDirections(stops) {
  if (!Array.isArray(stops) || stops.length < 2) return null;

  const stopStrings = stops
    .map((stop) => stop.formatted || stop.label)
    .filter(Boolean);

  if (stopStrings.length < 2) return null;

  const origin = stopStrings[0];
  const destination = stopStrings[stopStrings.length - 1];
  const waypoints = stopStrings.slice(1, -1);

  const params = new URLSearchParams({
    api: '1',
    origin,
    destination,
    travelmode: 'driving'
  });

  if (waypoints.length > 0) {
    params.set('waypoints', waypoints.join('|'));
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

module.exports = async function registerTransportationRoutes(router, { db, eventBus }) {
  async function resolveEntityId(entity, identifier) {
    if (!identifier) return null;
    const value = String(identifier).trim();
    if (!value) return null;
    return db.resolveId(entity, value);
  }

  async function listBy(entity, filters, options = {}) {
    if (typeof db.listByFilters === 'function') {
      return db.listByFilters(entity, {
        filters,
        limit: options.limit || 500,
        offset: options.offset || 0,
        orderBy: options.orderBy,
        orderDirection: options.orderDirection || 'DESC'
      });
    }

    return db.list(entity, {
      limit: options.limit || 500,
      offset: options.offset || 0
    });
  }

  async function resolveOrCreateAddress(input, defaults = {}) {
    if (!input) return null;

    if (typeof input === 'string') {
      return resolveEntityId('transportation_addresses', input);
    }

    if (typeof input !== 'object' || Array.isArray(input)) {
      throw badRequest('Address payload must be an object or identifier string');
    }

    assertAllowedKeys(input, new Set([
      'address_id',
      'id',
      'public_id',
      'label',
      'location_type',
      'line1',
      'line2',
      'city',
      'state',
      'postal_code',
      'country',
      'latitude',
      'longitude',
      'place_id',
      'notes'
    ]), 'address payload');

    const lookup = input.address_id || input.id || input.public_id;
    if (lookup) {
      const resolved = await resolveEntityId('transportation_addresses', lookup);
      if (resolved) return resolved;
      throw badRequest(`Address '${lookup}' not found`);
    }

    const payload = {
      transportation_address: sanitizeText(input.label) || defaults.name || 'Location',
      label: sanitizeText(input.label) || defaults.name || null,
      location_type: sanitizeText(input.location_type) || defaults.locationType || null,
      line1: sanitizeText(input.line1),
      line2: sanitizeText(input.line2),
      city: sanitizeText(input.city),
      state: sanitizeText(input.state),
      postal_code: sanitizeText(input.postal_code),
      country: sanitizeText(input.country) || 'US',
      latitude: numericOrNull(input.latitude),
      longitude: numericOrNull(input.longitude),
      place_id: sanitizeText(input.place_id),
      notes: sanitizeText(input.notes)
    };

    if (!payload.line1 && !payload.label) {
      throw badRequest('Address payload requires line1 or label when creating a new address');
    }

    const created = await db.create('transportation_addresses', payload);
    return created.id;
  }

  async function resolveDriverId(value) {
    if (!value) return null;
    const byDriver = await resolveEntityId('transportation_drivers', value);
    if (byDriver) return byDriver;

    const userId = await resolveEntityId('users', value);
    if (!userId) return null;

    const rows = await listBy('transportation_drivers', [{ column: 'user_id', op: 'eq', value: userId }], {
      limit: 1,
      offset: 0
    });

    return rows[0] ? rows[0].id : null;
  }

  async function fetchTripReferences({ includeWaypoints = false } = {}) {
    const [
      customers,
      users,
      addresses,
      requests,
      drivers,
      buses,
      results,
      waypoints
    ] = await Promise.all([
      db.list('customers', { limit: 1000, offset: 0 }),
      db.list('users', { limit: 1000, offset: 0 }),
      db.list('transportation_addresses', { limit: 2000, offset: 0 }),
      db.list('transportation_requests', { limit: 2000, offset: 0 }),
      db.list('transportation_drivers', { limit: 1000, offset: 0 }),
      db.list('transportation_buses', { limit: 1000, offset: 0 }),
      db.list('transportation_trip_results', { limit: 2000, offset: 0 }),
      includeWaypoints ? db.list('transportation_waypoints', { limit: 5000, offset: 0 }) : Promise.resolve([])
    ]);

    const byId = (rows) => new Map((rows || []).map((row) => [row.id, row]));

    const waypointsByTripId = new Map();
    if (includeWaypoints) {
      for (const waypoint of waypoints) {
        if (!waypoint.trip_id) continue;
        const list = waypointsByTripId.get(waypoint.trip_id) || [];
        list.push(waypoint);
        waypointsByTripId.set(waypoint.trip_id, list);
      }
      for (const list of waypointsByTripId.values()) {
        list.sort((a, b) => (Number(a.waypoint_order) || 0) - (Number(b.waypoint_order) || 0));
      }
    }

    const resultsByTripId = new Map();
    for (const result of results) {
      if (!result.trip_id || resultsByTripId.has(result.trip_id)) continue;
      resultsByTripId.set(result.trip_id, result);
    }

    return {
      customersById: byId(customers),
      usersById: byId(users),
      addressesById: byId(addresses),
      requestsById: byId(requests),
      driversById: byId(drivers),
      busesById: byId(buses),
      resultsByTripId,
      waypointsByTripId
    };
  }

  function summarizeDriver(driver, usersById) {
    if (!driver) return null;
    const user = driver.user_id ? usersById.get(driver.user_id) : null;
    const name = fullName(user, 'user') || driver.transportation_driver || null;
    return {
      id: driver.id,
      public_id: driver.public_id || null,
      name,
      phone: driver.phone || user?.phone || user?.cell || null,
      status: driver.status || null,
      license_number: driver.license_number || null
    };
  }

  function summarizeBus(bus) {
    if (!bus) return null;
    return {
      id: bus.id,
      public_id: bus.public_id || null,
      bus_number: bus.bus_number || null,
      plate_number: bus.plate_number || null,
      capacity: bus.capacity != null ? Number(bus.capacity) : null,
      wheelchair_accessible: Boolean(bus.wheelchair_accessible),
      status: bus.status || null,
      make: bus.make || null,
      model: bus.model || null
    };
  }

  function hydrateRequest(request, refs) {
    const customer = request.customer_id ? refs.customersById.get(request.customer_id) : null;
    const pickup = request.pickup_address_id ? refs.addressesById.get(request.pickup_address_id) : null;
    const dropoff = request.dropoff_address_id ? refs.addressesById.get(request.dropoff_address_id) : null;

    return {
      ...request,
      customer_name: fullName(customer, 'customer'),
      customer_public_id: customer?.public_id || null,
      pickup_address: summarizeAddress(pickup),
      dropoff_address: summarizeAddress(dropoff)
    };
  }

  function hydrateTrip(trip, refs) {
    const customer = trip.customer_id ? refs.customersById.get(trip.customer_id) : null;
    const request = trip.request_id ? refs.requestsById.get(trip.request_id) : null;
    const driver = trip.driver_id ? refs.driversById.get(trip.driver_id) : null;
    const bus = trip.bus_id ? refs.busesById.get(trip.bus_id) : null;
    const pickup = trip.pickup_address_id ? refs.addressesById.get(trip.pickup_address_id) : null;
    const dropoff = trip.dropoff_address_id ? refs.addressesById.get(trip.dropoff_address_id) : null;
    const result = refs.resultsByTripId.get(trip.id) || null;
    const waypoints = refs.waypointsByTripId.get(trip.id) || [];

    return {
      ...trip,
      customer_name: fullName(customer, 'customer'),
      customer_public_id: customer?.public_id || null,
      request_public_id: request?.public_id || null,
      request_status: request?.status || null,
      driver: summarizeDriver(driver, refs.usersById),
      bus: summarizeBus(bus),
      pickup_address: summarizeAddress(pickup),
      dropoff_address: summarizeAddress(dropoff),
      waypoint_count: waypoints.length,
      result: result
        ? {
          id: result.id,
          public_id: result.public_id || null,
          actual_head_count: result.actual_head_count != null ? Number(result.actual_head_count) : null,
          actual_departure_at: result.actual_departure_at || null,
          actual_arrival_at: result.actual_arrival_at || null,
          actual_miles: result.actual_miles != null ? Number(result.actual_miles) : null,
          completion_status: result.completion_status || null
        }
        : null
    };
  }

  async function hydrateRequests(rows) {
    const [customers, addresses] = await Promise.all([
      db.list('customers', { limit: 1000, offset: 0 }),
      db.list('transportation_addresses', { limit: 2000, offset: 0 })
    ]);

    const refs = {
      customersById: new Map(customers.map((row) => [row.id, row])),
      addressesById: new Map(addresses.map((row) => [row.id, row]))
    };

    return rows.map((request) => hydrateRequest(request, refs));
  }

  async function hydrateTrips(rows, { includeWaypoints = false } = {}) {
    const refs = await fetchTripReferences({ includeWaypoints });
    return rows.map((trip) => hydrateTrip(trip, refs));
  }

  async function createTripWaypoints(tripId, waypoints = []) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) return [];

    const created = [];
    for (let index = 0; index < waypoints.length; index += 1) {
      const waypoint = waypoints[index];
      if (!waypoint || typeof waypoint !== 'object') continue;

      const addressInput = waypoint.address || waypoint.location || waypoint.address_id || waypoint.addressId || waypoint.id || null;
      const addressId = await resolveOrCreateAddress(addressInput, {
        name: sanitizeText(waypoint.label) || `Stop ${index + 1}`,
        locationType: 'waypoint'
      });

      if (!addressId) continue;

      const payload = {
        transportation_waypoint: sanitizeText(waypoint.label) || `Stop ${index + 1}`,
        trip_id: tripId,
        address_id: addressId,
        waypoint_order: sanitizeInteger(waypoint.waypoint_order ?? waypoint.order ?? index + 1) || (index + 1),
        planned_arrival_at: toIso(waypoint.planned_arrival_at || waypoint.arrival_at),
        planned_departure_at: toIso(waypoint.planned_departure_at || waypoint.departure_at),
        status: sanitizeStatus(waypoint.status, 'scheduled'),
        notes: sanitizeText(waypoint.notes)
      };

      created.push(await db.create('transportation_waypoints', payload));
    }

    return created;
  }

  router.get('/requests', async (req, res, next) => {
    try {
      assertAllowedKeys(req.query || {}, new Set(['q', 'status', 'from', 'to', 'limit', 'offset']), 'requests query');
      const q = sanitizeText(req.query.q);
      const status = sanitizeText(req.query.status);
      const fromDate = toDateValue(req.query.from);
      const toDate = toDateValue(req.query.to);
      const limit = parseLimit(req.query.limit, 100, 500);
      const offset = parseOffset(req.query.offset, 0, 5000);

      let rows;
      if (q) {
        rows = await db.list('transportation_requests', { q, limit, offset });
      } else {
        const filters = [
          ...(status ? [{ column: 'status', op: 'eq', value: status }] : []),
          ...buildFilterRange(fromDate, toDate, 'trip_date')
        ];
        rows = await listBy('transportation_requests', filters, {
          limit,
          offset,
          orderBy: 'trip_date',
          orderDirection: 'ASC'
        });
      }

      const hydrated = await hydrateRequests(rows);
      res.json(hydrated);
    } catch (error) {
      next(error);
    }
  });

  router.get('/requests/:identifier', async (req, res, next) => {
    try {
      const identifier = validateIdentifier(req.params.identifier);
      const request = await db.getByIdentifier('transportation_requests', identifier);
      if (!request) {
        return res.status(404).json({ error: 'transportation request not found' });
      }

      const [hydrated] = await hydrateRequests([request]);
      const trips = await listBy('transportation_trips', [{ column: 'request_id', op: 'eq', value: request.id }], {
        limit: 200,
        offset: 0,
        orderBy: 'trip_date',
        orderDirection: 'ASC'
      });
      const hydratedTrips = await hydrateTrips(trips, { includeWaypoints: true });

      return res.json({
        request: hydrated,
        trips: hydratedTrips
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/requests', async (req, res, next) => {
    try {
      assertAllowedKeys(req.body || {}, new Set([
        'request',
        'transportation_request',
        'customer_id',
        'customerId',
        'customer_public_id',
        'customerPublicId',
        'trip_date',
        'tripDate',
        'requested_head_count',
        'head_count',
        'pickup_address',
        'pickupAddress',
        'pickup_address_id',
        'pickupAddressId',
        'dropoff_address',
        'dropoffAddress',
        'dropoff_address_id',
        'dropoffAddressId',
        'school_name',
        'trip_type',
        'requested_departure_at',
        'requestedDepartureAt',
        'requested_return_at',
        'requestedReturnAt',
        'status',
        'quoted_amount',
        'currency',
        'notes'
      ]), 'request payload');

      const customerId = await resolveEntityId('customers',
        req.body.customer_id || req.body.customerId || req.body.customer_public_id || req.body.customerPublicId
      );

      const pickupInput = req.body.pickup_address || req.body.pickupAddress || pickupDropoffValue(req.body.pickup_address_id || req.body.pickupAddressId);
      const dropoffInput = req.body.dropoff_address || req.body.dropoffAddress || pickupDropoffValue(req.body.dropoff_address_id || req.body.dropoffAddressId);

      const pickupAddressId = await resolveOrCreateAddress(pickupInput, {
        name: 'Pickup',
        locationType: 'pickup'
      });
      const dropoffAddressId = await resolveOrCreateAddress(dropoffInput, {
        name: 'Dropoff',
        locationType: 'dropoff'
      });

      const requestedDepartureAt = toIso(req.body.requested_departure_at || req.body.requestedDepartureAt);
      const requestedReturnAt = toIso(req.body.requested_return_at || req.body.requestedReturnAt);
      const tripDate = toDateValue(req.body.trip_date || req.body.tripDate || requestedDepartureAt);

      const payload = {
        transportation_request: sanitizeText(req.body.transportation_request)
          || sanitizeText(req.body.request)
          || `Trip Request ${tripDate || todayKey()}`,
        customer_id: customerId || null,
        trip_date: tripDate,
        pickup_address_id: pickupAddressId || null,
        dropoff_address_id: dropoffAddressId || null,
        requested_head_count: sanitizeInteger(req.body.requested_head_count ?? req.body.head_count),
        school_name: sanitizeText(req.body.school_name),
        trip_type: sanitizeText(req.body.trip_type) || 'local-tour',
        requested_departure_at: requestedDepartureAt,
        requested_return_at: requestedReturnAt,
        status: sanitizeStatus(req.body.status, 'requested'),
        quoted_amount: parseMoney(req.body.quoted_amount),
        currency: sanitizeText(req.body.currency) || 'USD',
        notes: sanitizeText(req.body.notes)
      };

      const created = await db.create('transportation_requests', payload);
      const [hydrated] = await hydrateRequests([created]);

      await eventBus.publish(EVENTS.TRANSPORTATION.REQUEST.CREATED, {
        requestId: created.id,
        requestPublicId: created.public_id || null,
        tripDate: created.trip_date || null,
        requestedHeadCount: created.requested_head_count || null
      });

      return res.status(201).json(hydrated);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/trips', async (req, res, next) => {
    try {
      assertAllowedKeys(req.query || {}, new Set(['q', 'status', 'from', 'to', 'limit', 'offset']), 'trips query');
      const q = sanitizeText(req.query.q);
      const status = sanitizeText(req.query.status);
      const fromDate = toDateValue(req.query.from);
      const toDate = toDateValue(req.query.to);
      const limit = parseLimit(req.query.limit, 100, 500);
      const offset = parseOffset(req.query.offset, 0, 5000);

      let rows;
      if (q) {
        rows = await db.list('transportation_trips', { q, limit, offset });
      } else {
        const filters = [
          ...(status ? [{ column: 'status', op: 'eq', value: status }] : []),
          ...buildFilterRange(fromDate, toDate, 'trip_date')
        ];

        rows = await listBy('transportation_trips', filters, {
          limit,
          offset,
          orderBy: 'planned_departure_at',
          orderDirection: 'ASC'
        });
      }

      const hydrated = await hydrateTrips(rows, { includeWaypoints: true });
      return res.json(hydrated);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/trips/:identifier', async (req, res, next) => {
    try {
      const identifier = validateIdentifier(req.params.identifier);
      const trip = await db.getByIdentifier('transportation_trips', identifier);
      if (!trip) {
        return res.status(404).json({ error: 'trip not found' });
      }

      const refs = await fetchTripReferences({ includeWaypoints: true });
      const hydratedTrip = hydrateTrip(trip, refs);
      const tripWaypoints = refs.waypointsByTripId.get(trip.id) || [];
      const waypoints = tripWaypoints.map((waypoint) => ({
        ...waypoint,
        address: summarizeAddress(refs.addressesById.get(waypoint.address_id))
      }));

      const invoices = await listBy('transportation_invoices', [{ column: 'trip_id', op: 'eq', value: trip.id }], {
        limit: 100,
        offset: 0,
        orderBy: 'issue_date',
        orderDirection: 'DESC'
      });

      const invoiceIds = invoices.map((item) => item.id);
      const payments = invoiceIds.length === 0
        ? []
        : await listBy('transportation_payments', [{ column: 'transportation_invoice_id', op: 'in', value: invoiceIds }], {
          limit: 300,
          offset: 0,
          orderBy: 'paid_at',
          orderDirection: 'DESC'
        });

      return res.json({
        trip: hydratedTrip,
        waypoints,
        invoices,
        payments
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/trips', async (req, res, next) => {
    try {
      assertAllowedKeys(req.body || {}, new Set([
        'transportation_trip',
        'route_name',
        'name',
        'request_id',
        'requestId',
        'request_public_id',
        'requestPublicId',
        'customer_id',
        'customerId',
        'customer_public_id',
        'customerPublicId',
        'driver_id',
        'driverId',
        'driver_public_id',
        'driverPublicId',
        'bus_id',
        'busId',
        'bus_public_id',
        'busPublicId',
        'trip_date',
        'tripDate',
        'pickup_address',
        'pickupAddress',
        'pickup_address_id',
        'pickupAddressId',
        'dropoff_address',
        'dropoffAddress',
        'dropoff_address_id',
        'dropoffAddressId',
        'planned_head_count',
        'head_count',
        'planned_departure_at',
        'plannedDepartureAt',
        'planned_arrival_at',
        'plannedArrivalAt',
        'status',
        'trip_type',
        'route_notes',
        'notes',
        'waypoints'
      ]), 'trip payload');

      const requestId = await resolveEntityId('transportation_requests',
        req.body.request_id || req.body.requestId || req.body.request_public_id || req.body.requestPublicId
      );

      const request = requestId
        ? await db.getByIdentifier('transportation_requests', requestId)
        : null;

      const customerId = await resolveEntityId('customers',
        req.body.customer_id || req.body.customerId || req.body.customer_public_id || req.body.customerPublicId || request?.customer_id
      );

      const driverId = await resolveDriverId(
        req.body.driver_id || req.body.driverId || req.body.driver_public_id || req.body.driverPublicId
      );

      const busId = await resolveEntityId('transportation_buses',
        req.body.bus_id || req.body.busId || req.body.bus_public_id || req.body.busPublicId
      );

      const pickupInput = req.body.pickup_address || req.body.pickupAddress
        || pickupDropoffValue(req.body.pickup_address_id || req.body.pickupAddressId)
        || request?.pickup_address_id;
      const dropoffInput = req.body.dropoff_address || req.body.dropoffAddress
        || pickupDropoffValue(req.body.dropoff_address_id || req.body.dropoffAddressId)
        || request?.dropoff_address_id;

      const pickupAddressId = await resolveOrCreateAddress(pickupInput, {
        name: 'Pickup',
        locationType: 'pickup'
      });
      const dropoffAddressId = await resolveOrCreateAddress(dropoffInput, {
        name: 'Dropoff',
        locationType: 'dropoff'
      });

      const plannedDepartureAt = toIso(req.body.planned_departure_at || req.body.plannedDepartureAt || request?.requested_departure_at);
      const plannedArrivalAt = toIso(req.body.planned_arrival_at || req.body.plannedArrivalAt || request?.requested_return_at);
      const tripDate = toDateValue(req.body.trip_date || req.body.tripDate || request?.trip_date || plannedDepartureAt);

      const payload = {
        transportation_trip: sanitizeText(req.body.transportation_trip)
          || sanitizeText(req.body.route_name)
          || sanitizeText(req.body.name)
          || `Trip ${tripDate || todayKey()}`,
        request_id: requestId || null,
        customer_id: customerId || null,
        driver_id: driverId || null,
        bus_id: busId || null,
        trip_date: tripDate,
        pickup_address_id: pickupAddressId || null,
        dropoff_address_id: dropoffAddressId || null,
        planned_head_count: sanitizeInteger(req.body.planned_head_count ?? req.body.head_count ?? request?.requested_head_count),
        planned_departure_at: plannedDepartureAt,
        planned_arrival_at: plannedArrivalAt,
        status: sanitizeStatus(req.body.status, 'scheduled'),
        route_name: sanitizeText(req.body.route_name) || sanitizeText(req.body.trip_type) || null,
        route_notes: sanitizeText(req.body.route_notes) || sanitizeText(req.body.notes)
      };

      const created = await db.create('transportation_trips', payload);
      await createTripWaypoints(created.id, req.body.waypoints || []);

      const [hydrated] = await hydrateTrips([created], { includeWaypoints: true });

      await eventBus.publish(EVENTS.TRANSPORTATION.TRIP.SCHEDULED, {
        tripId: created.id,
        tripPublicId: created.public_id || null,
        tripDate: created.trip_date || null,
        plannedDepartureAt: created.planned_departure_at || null
      });

      return res.status(201).json(hydrated);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/trips/:identifier/start', async (req, res, next) => {
    try {
      const identifier = validateIdentifier(req.params.identifier);
      const trip = await db.getByIdentifier('transportation_trips', identifier);
      if (!trip) {
        return res.status(404).json({ error: 'trip not found' });
      }

      const updated = await db.update('transportation_trips', trip.id, {
        status: 'in_progress'
      });

      await eventBus.publish(EVENTS.TRANSPORTATION.TRIP.STARTED, {
        tripId: trip.id,
        tripPublicId: trip.public_id || null,
        startedAt: new Date().toISOString()
      });

      const [hydrated] = await hydrateTrips([updated], { includeWaypoints: true });
      return res.json(hydrated);
    } catch (error) {
      return next(error);
    }
  });

  router.post('/trips/:identifier/complete', async (req, res, next) => {
    try {
      assertAllowedKeys(req.body || {}, new Set([
        'actual_head_count',
        'actual_departure_at',
        'actual_arrival_at',
        'actual_miles',
        'fuel_cost',
        'toll_cost',
        'completion_status',
        'incident_notes',
        'recorded_by_driver_id',
        'recorded_by_driver_public_id',
        'notes'
      ]), 'trip completion payload');

      const identifier = validateIdentifier(req.params.identifier);
      const trip = await db.getByIdentifier('transportation_trips', identifier);
      if (!trip) {
        return res.status(404).json({ error: 'trip not found' });
      }

      const recordedByDriverId = await resolveDriverId(
        req.body.recorded_by_driver_id || req.body.recorded_by_driver_public_id || trip.driver_id
      );

      const resultPayload = {
        transportation_trip_result: `Result ${trip.public_id || trip.id}`,
        trip_id: trip.id,
        actual_head_count: sanitizeInteger(req.body.actual_head_count),
        actual_departure_at: toIso(req.body.actual_departure_at),
        actual_arrival_at: toIso(req.body.actual_arrival_at),
        actual_miles: parseMoney(req.body.actual_miles),
        fuel_cost: parseMoney(req.body.fuel_cost),
        toll_cost: parseMoney(req.body.toll_cost),
        completion_status: sanitizeStatus(req.body.completion_status, 'completed'),
        incident_notes: sanitizeText(req.body.incident_notes),
        recorded_by_driver_id: recordedByDriverId || null,
        notes: sanitizeText(req.body.notes)
      };

      const existingResults = await listBy('transportation_trip_results', [{ column: 'trip_id', op: 'eq', value: trip.id }], {
        limit: 1,
        offset: 0
      });

      const result = existingResults[0]
        ? await db.update('transportation_trip_results', existingResults[0].id, resultPayload)
        : await db.create('transportation_trip_results', resultPayload);

      const updatedTrip = await db.update('transportation_trips', trip.id, {
        status: 'completed'
      });

      await eventBus.publish(EVENTS.TRANSPORTATION.TRIP.COMPLETED, {
        tripId: trip.id,
        tripPublicId: trip.public_id || null,
        resultId: result.id,
        completionStatus: result.completion_status || 'completed'
      });

      const [hydrated] = await hydrateTrips([updatedTrip], { includeWaypoints: true });
      return res.json({
        trip: hydrated,
        result
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/calendar', async (req, res, next) => {
    try {
      assertAllowedKeys(req.query || {}, new Set(['month', 'date']), 'calendar query');
      const selectedMonth = sanitizeText(req.query.month) || monthKey(new Date()) || monthKey(Date.now());
      const selectedDate = sanitizeText(req.query.date) || todayKey();

      const rows = await listBy('transportation_trips', [{ column: 'trip_date', op: 'like', value: `${selectedMonth}%` }], {
        limit: 2000,
        offset: 0,
        orderBy: 'planned_departure_at',
        orderDirection: 'ASC'
      });

      const hydrated = await hydrateTrips(rows, { includeWaypoints: true });

      const events = hydrated
        .map((trip) => {
          const startsAt = toIso(trip.planned_departure_at) || (trip.trip_date ? `${trip.trip_date}T08:00:00.000Z` : null);
          const endsAt = toIso(trip.planned_arrival_at) || (trip.trip_date ? `${trip.trip_date}T10:00:00.000Z` : null);
          return {
            id: trip.id,
            public_id: trip.public_id || null,
            title: trip.route_name || trip.transportation_trip || 'Scheduled Trip',
            startsAt,
            endsAt,
            status: trip.status || null,
            driverName: trip.driver?.name || null,
            busNumber: trip.bus?.bus_number || null,
            customerName: trip.customer_name || null,
            pickup: trip.pickup_address?.formatted || null,
            dropoff: trip.dropoff_address?.formatted || null
          };
        })
        .filter((event) => event.startsAt && event.startsAt.slice(0, 7) === selectedMonth)
        .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));

      const dailyCounts = {};
      for (const event of events) {
        const day = event.startsAt.slice(0, 10);
        dailyCounts[day] = (dailyCounts[day] || 0) + 1;
      }

      const daySchedule = events.filter((event) => event.startsAt.slice(0, 10) === selectedDate);

      return res.json({
        month: selectedMonth,
        selectedDate,
        events,
        dailyCounts,
        daySchedule
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/map', async (req, res, next) => {
    try {
      assertAllowedKeys(req.query || {}, new Set(['trip_id']), 'map query');
      const rows = await listBy('transportation_trips', [], {
        limit: 500,
        offset: 0,
        orderBy: 'planned_departure_at',
        orderDirection: 'ASC'
      });

      const refs = await fetchTripReferences({ includeWaypoints: true });
      const hydratedTrips = rows.map((trip) => hydrateTrip(trip, refs));

      const selectedTripId = req.query.trip_id
        ? await resolveEntityId('transportation_trips', req.query.trip_id)
        : null;

      const selectedTripRaw = rows.find((trip) => trip.id === selectedTripId)
        || rows.find((trip) => ['in_progress', 'scheduled'].includes(String(trip.status || '').toLowerCase()))
        || rows[0]
        || null;

      if (!selectedTripRaw) {
        return res.json({
          trips: [],
          selectedTrip: null,
          stops: [],
          mapLinks: {},
          routePlot: { points: [], polyline: '', hasPlot: false }
        });
      }

      const selectedTrip = hydrateTrip(selectedTripRaw, refs);
      const waypoints = refs.waypointsByTripId.get(selectedTripRaw.id) || [];
      const stops = [];

      const pickupAddress = refs.addressesById.get(selectedTripRaw.pickup_address_id);
      if (pickupAddress) {
        stops.push({
          type: 'pickup',
          order: 0,
          label: pickupAddress.label || 'Pickup',
          ...summarizeAddress(pickupAddress)
        });
      }

      for (const waypoint of waypoints) {
        const address = refs.addressesById.get(waypoint.address_id);
        if (!address) continue;
        stops.push({
          type: 'waypoint',
          order: Number(waypoint.waypoint_order) || 0,
          waypoint_id: waypoint.id,
          label: waypoint.transportation_waypoint || address.label || `Stop ${waypoint.waypoint_order || ''}`.trim(),
          planned_arrival_at: waypoint.planned_arrival_at || null,
          planned_departure_at: waypoint.planned_departure_at || null,
          ...summarizeAddress(address)
        });
      }

      const dropoffAddress = refs.addressesById.get(selectedTripRaw.dropoff_address_id);
      if (dropoffAddress) {
        stops.push({
          type: 'dropoff',
          order: 999,
          label: dropoffAddress.label || 'Dropoff',
          ...summarizeAddress(dropoffAddress)
        });
      }

      const orderedStops = stops
        .slice()
        .sort((a, b) => {
          if (a.type === 'pickup' && b.type !== 'pickup') return -1;
          if (b.type === 'pickup' && a.type !== 'pickup') return 1;
          if (a.type === 'dropoff' && b.type !== 'dropoff') return 1;
          if (b.type === 'dropoff' && a.type !== 'dropoff') return -1;
          return (a.order || 0) - (b.order || 0);
        });

      const routePlot = computeRoutePlot(orderedStops);
      const googleDirections = buildGoogleDirections(orderedStops);

      const firstStop = orderedStops[0] || null;
      const mapLinks = {
        googleDirections,
        staticSearch: firstStop && firstStop.formatted
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(firstStop.formatted)}`
          : null
      };

      return res.json({
        trips: hydratedTrips,
        selectedTrip,
        stops: orderedStops,
        mapLinks,
        routePlot
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/dashboard', async (req, res, next) => {
    try {
      assertAllowedKeys(req.query || {}, new Set(['date']), 'dashboard query');
      const selectedDate = toDateValue(req.query.date) || todayKey();
      const selectedMonth = selectedDate.slice(0, 7);
      const nowIso = new Date().toISOString();

      const [requests, trips, buses, drivers, invoices, payments, results] = await Promise.all([
        db.list('transportation_requests', { limit: 3000, offset: 0 }),
        db.list('transportation_trips', { limit: 3000, offset: 0 }),
        db.list('transportation_buses', { limit: 500, offset: 0 }),
        db.list('transportation_drivers', { limit: 500, offset: 0 }),
        db.list('transportation_invoices', { limit: 3000, offset: 0 }),
        db.list('transportation_payments', { limit: 3000, offset: 0 }),
        db.list('transportation_trip_results', { limit: 3000, offset: 0 })
      ]);

      const hydratedTrips = await hydrateTrips(trips, { includeWaypoints: true });
      const hydratedRequests = await hydrateRequests(requests);

      const todayTrips = hydratedTrips
        .filter((trip) => {
          const tripDay = trip.trip_date || dateKey(trip.planned_departure_at);
          return tripDay === selectedDate;
        })
        .sort((a, b) => String(a.planned_departure_at || '').localeCompare(String(b.planned_departure_at || '')));

      const upcomingTrips = hydratedTrips
        .filter((trip) => {
          const status = String(trip.status || '').toLowerCase();
          if (!['scheduled', 'in_progress'].includes(status)) return false;
          const departure = toIso(trip.planned_departure_at) || (trip.trip_date ? `${trip.trip_date}T00:00:00.000Z` : null);
          return departure && departure >= nowIso;
        })
        .sort((a, b) => String(a.planned_departure_at || '').localeCompare(String(b.planned_departure_at || '')))
        .slice(0, 12);

      const openRequests = hydratedRequests
        .filter((request) => ['requested', 'pending', 'quoted'].includes(String(request.status || '').toLowerCase()))
        .sort((a, b) => String(a.trip_date || '').localeCompare(String(b.trip_date || '')))
        .slice(0, 12);

      const monthlyRevenue = payments
        .filter((payment) => ['received', 'paid'].includes(String(payment.status || '').toLowerCase()))
        .filter((payment) => monthKey(payment.paid_at || payment.modified || payment.created) === selectedMonth)
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);

      const outstandingInvoiceAmount = invoices
        .filter((invoice) => !['paid', 'void', 'cancelled'].includes(String(invoice.status || '').toLowerCase()))
        .reduce((sum, invoice) => sum + Number(invoice.total || 0), 0);

      const completedToday = results.filter((result) => dateKey(result.actual_arrival_at || result.modified || result.created) === selectedDate).length;

      const metrics = {
        openRequests: openRequests.length,
        todayTrips: todayTrips.length,
        activeTrips: hydratedTrips.filter((trip) => String(trip.status || '').toLowerCase() === 'in_progress').length,
        completedToday,
        busesAvailable: buses.filter((bus) => ['active', 'available', 'ready'].includes(String(bus.status || '').toLowerCase())).length,
        driversAvailable: drivers.filter((driver) => ['active', 'available', 'ready'].includes(String(driver.status || '').toLowerCase())).length,
        monthlyRevenue: Number(monthlyRevenue.toFixed(2)),
        outstandingInvoiceAmount: Number(outstandingInvoiceAmount.toFixed(2))
      };

      return res.json({
        date: selectedDate,
        month: selectedMonth,
        metrics,
        todayTrips,
        upcomingTrips,
        openRequests
      });
    } catch (error) {
      return next(error);
    }
  });
};
