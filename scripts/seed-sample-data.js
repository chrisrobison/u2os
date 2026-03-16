const config = require('../core/config');
const { createDataSource } = require('../core/db');

function pick(arr, index) {
  return arr[index % arr.length];
}

function isoOffsetDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function ymdOffsetDays(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function ensureCount(db, table, minCount, createFn) {
  const rows = await db.list(table, { limit: 500, offset: 0 });
  const created = [];
  for (let i = rows.length; i < minCount; i += 1) {
    const payload = await createFn(i, rows.concat(created));
    const record = await db.create(table, payload);
    created.push(record);
  }
  return rows.concat(created);
}

async function ensureBy(db, table, predicate, payloadFactory) {
  const rows = await db.list(table, { limit: 1000, offset: 0 });
  const existing = rows.find(predicate);
  if (existing) {
    return existing;
  }
  const payload = await payloadFactory(rows);
  return db.create(table, payload);
}

async function main() {
  const db = await createDataSource(config.db);
  await db.initSchema();

  const orgNames = ['Northwind Group', 'Blue Harbor Co', 'Summit Works'];
  const firstNames = ['Ava', 'Liam', 'Maya', 'Noah', 'Ivy', 'Ethan', 'Zoe', 'Lucas'];
  const lastNames = ['Stone', 'Parker', 'Reed', 'Santos', 'Nguyen', 'Bennett', 'Flores', 'Khan'];

  const organizations = await ensureCount(db, 'organizations', 3, async (i) => ({
    organization: orgNames[i],
    legal_name: `${orgNames[i]} LLC`,
    email: `hello${i + 1}@example.org`,
    phone: `555-200${i}`,
    cell: `555-210${i}`,
    website: `https://org${i + 1}.example.org`,
    address_line1: `${100 + i} Market St`,
    address_line2: 'Suite 200',
    city: 'San Francisco',
    state: 'CA',
    postal_code: `9410${i}`,
    country: 'US',
    status: 'active'
  }));

  const users = await ensureCount(db, 'users', 8, async (i) => {
    const first = pick(firstNames, i);
    const last = pick(lastNames, i);
    return {
      user: `${first.toLowerCase()}.${last.toLowerCase()}`,
      first_name: first,
      last_name: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@bizos.test`,
      phone: `555-300${i}`,
      cell: `555-310${i}`,
      sms: i % 2 === 0,
      role: i < 2 ? 'admin' : 'staff',
      status: 'active'
    };
  });

  const customers = await ensureCount(db, 'customers', 12, async (i) => {
    const first = pick(firstNames, i + 2);
    const last = pick(lastNames, i + 1);
    const org = pick(organizations, i);
    return {
      customer: `${first} ${last}`,
      organization_id: org.id,
      first_name: first,
      last_name: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}+c${i}@customer.test`,
      phone: `555-400${i}`,
      cell: `555-410${i}`,
      sms: i % 3 === 0,
      status: i % 4 === 0 ? 'lead' : 'active',
      notes: 'Prefers email communication.'
    };
  });

  const showcaseSpecs = [
    {
      firstName: 'Jordan',
      lastName: 'Rivera',
      email: 'jordan.rivera+demo@customer.test',
      salonLocation: 'Mission Studio',
      paymentMethod: 'card'
    },
    {
      firstName: 'Priya',
      lastName: 'Patel',
      email: 'priya.patel+demo@customer.test',
      salonLocation: 'Sunset Studio',
      paymentMethod: 'bank_transfer'
    }
  ];

  const showcaseCustomers = [];
  for (let i = 0; i < showcaseSpecs.length; i += 1) {
    const spec = showcaseSpecs[i];
    const org = pick(organizations, i);
    const staff = pick(users, i);

    const customer = await ensureBy(
      db,
      'customers',
      (row) => String(row.email || '').toLowerCase() === spec.email.toLowerCase(),
      async () => ({
        customer: `${spec.firstName} ${spec.lastName}`,
        organization_id: org.id,
        first_name: spec.firstName,
        last_name: spec.lastName,
        email: spec.email,
        phone: `555-770${i}`,
        cell: `555-780${i}`,
        sms: true,
        status: 'active',
        notes: 'Showcase customer seeded for end-to-end module testing.'
      })
    );
    showcaseCustomers.push(customer);

    const order = await ensureBy(
      db,
      'orders',
      (row) => String(row.order || '').toUpperCase() === `ORD-DEMO-${i + 1}`,
      async () => ({
        order: `ORD-DEMO-${i + 1}`,
        customer_id: customer.id,
        organization_id: org.id,
        status: 'open',
        total: 199 + i * 49,
        currency: 'USD',
        ordered_at: isoOffsetDays(-(i + 1)),
        due_at: isoOffsetDays(7 + i),
        notes: 'Showcase order for integration testing.'
      })
    );

    const invoice = await ensureBy(
      db,
      'invoices',
      (row) => String(row.invoice_number || '').toUpperCase() === `INV-DEMO-${i + 1}`,
      async () => ({
        invoice: `INV-DEMO-${i + 1}`,
        customer_id: customer.id,
        organization_id: org.id,
        invoice_number: `INV-DEMO-${i + 1}`,
        status: 'sent',
        issue_date: ymdOffsetDays(-i),
        due_date: ymdOffsetDays(14 + i),
        subtotal: 199 + i * 49,
        tax: Number(((199 + i * 49) * 0.085).toFixed(2)),
        total: Number(((199 + i * 49) * 1.085).toFixed(2)),
        currency: 'USD',
        notes: 'Showcase invoice tied to seeded demo customer.'
      })
    );

    await ensureBy(
      db,
      'payments',
      (row) => String(row.reference || '').toUpperCase() === `PAY-DEMO-${i + 1}`,
      async () => ({
        payment: `PAY-DEMO-${i + 1}`,
        invoice_id: invoice.id,
        customer_id: customer.id,
        amount: Number((60 + i * 15).toFixed(2)),
        currency: 'USD',
        method: spec.paymentMethod,
        status: 'received',
        paid_at: isoOffsetDays(-i),
        reference: `PAY-DEMO-${i + 1}`
      })
    );

    await ensureBy(
      db,
      'appointments',
      (row) => String(row.appointment || '').toUpperCase() === `DEMO APPOINTMENT ${i + 1}`,
      async () => {
        const start = new Date(Date.now() + (i + 1) * 2 * 60 * 60 * 1000);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        return {
          appointment: `Demo Appointment ${i + 1}`,
          customer_id: customer.id,
          staff_user_id: staff.id,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          status: 'booked',
          location: spec.salonLocation,
          notes: 'Showcase appointment for salon module testing.'
        };
      }
    );

    await ensureBy(
      db,
      'tasks',
      (row) => String(row.task || '').toUpperCase() === `DEMO FOLLOW-UP ${i + 1}`,
      async () => ({
        task: `Demo Follow-up ${i + 1}`,
        customer_id: customer.id,
        assigned_user_id: staff.id,
        status: 'open',
        priority: i % 2 === 0 ? 'high' : 'medium',
        due_at: isoOffsetDays(2 + i),
        details: 'Showcase follow-up task linked to demo customer activity.'
      })
    );

    await ensureBy(
      db,
      'documents',
      (row) => String(row.document || '').toUpperCase() === `DEMO DOCUMENT ${i + 1}`,
      async () => ({
        document: `Demo Document ${i + 1}`,
        customer_id: customer.id,
        organization_id: org.id,
        document_type: 'consent_form',
        file_url: `https://files.example.org/demo/customers/${i + 1}/consent.pdf`,
        status: 'active',
        notes: 'Showcase customer document for retrieval and linking tests.'
      })
    );

    await ensureBy(
      db,
      'events',
      (row) => String(row.event || '').toUpperCase() === `DEMO EVENT ${i + 1}`,
      async () => ({
        event: `Demo Event ${i + 1}`,
        event_type: 'showcase.seeded',
        subject_type: 'customers',
        subject_id: customer.id,
        payload: {
          customer_email: spec.email,
          type: 'demo_seed'
        },
        occurred_at: new Date().toISOString()
      })
    );

    await ensureBy(
      db,
      'clamps',
      (row) => String(row.clamp || '').startsWith(`showcase:${customer.id}:`),
      async () => ({
        clamp: `showcase:${customer.id}:${order.id}`,
        local: 'customers',
        local_id: customer.id,
        remote: 'orders',
        remote_id: order.id,
        context: 'showcase'
      })
    );
  }

  const contacts = await ensureCount(db, 'contacts', 8, async (i) => {
    const first = pick(firstNames, i + 3);
    const last = pick(lastNames, i + 5);
    const org = pick(organizations, i);
    return {
      contact: `${first} ${last}`,
      organization_id: org.id,
      first_name: first,
      last_name: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}+ct${i}@contact.test`,
      phone: `555-500${i}`,
      cell: `555-510${i}`,
      sms: i % 2 === 1,
      title: i % 2 === 0 ? 'Manager' : 'Coordinator',
      company: org.organization,
      notes: 'Key external contact.'
    };
  });

  const products = await ensureCount(db, 'products', 10, async (i) => ({
    product: `Product ${i + 1}`,
    sku: `SKU-${1000 + i}`,
    description: `Sample product ${i + 1}`,
    price: 9.99 + i * 3,
    currency: 'USD',
    stock_quantity: 50 - i,
    status: i % 5 === 0 ? 'inactive' : 'active'
  }));

  const services = await ensureCount(db, 'services', 8, async (i) => ({
    service: `Service ${i + 1}`,
    description: `Professional service package ${i + 1}`,
    duration_minutes: 30 + i * 15,
    rate: 45 + i * 10,
    currency: 'USD',
    status: 'active'
  }));

  const orders = await ensureCount(db, 'orders', 12, async (i) => {
    const customer = pick(customers, i);
    const org = pick(organizations, i);
    return {
      order: `ORD-${2000 + i}`,
      customer_id: customer.id,
      organization_id: org.id,
      status: i % 3 === 0 ? 'paid' : 'open',
      total: 120 + i * 17.5,
      currency: 'USD',
      ordered_at: isoOffsetDays(-i - 2),
      due_at: isoOffsetDays(7 - i),
      notes: 'Generated sample order.'
    };
  });

  const appointments = await ensureCount(db, 'appointments', 12, async (i) => {
    const customer = pick(customers, i);
    const staff = pick(users, i);
    const start = new Date(Date.now() + (i - 6) * 3 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return {
      appointment: `Appointment ${i + 1}`,
      customer_id: customer.id,
      staff_user_id: staff.id,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      status: i % 4 === 0 ? 'completed' : 'booked',
      location: i % 2 === 0 ? 'Downtown Studio' : 'Remote',
      notes: 'Auto-generated appointment.'
    };
  });

  const invoices = await ensureCount(db, 'invoices', 12, async (i) => {
    const customer = pick(customers, i);
    const org = pick(organizations, i);
    const subtotal = 100 + i * 12;
    const tax = Number((subtotal * 0.085).toFixed(2));
    return {
      invoice: `INV-${3000 + i}`,
      customer_id: customer.id,
      organization_id: org.id,
      invoice_number: `INV-${3000 + i}`,
      status: i % 3 === 0 ? 'paid' : 'sent',
      issue_date: ymdOffsetDays(-i - 1),
      due_date: ymdOffsetDays(14 - i),
      subtotal,
      tax,
      total: subtotal + tax,
      currency: 'USD',
      notes: 'Generated sample invoice.'
    };
  });

  const payments = await ensureCount(db, 'payments', 10, async (i) => {
    const invoice = pick(invoices, i);
    const customer = pick(customers, i);
    return {
      payment: `PAY-${4000 + i}`,
      invoice_id: invoice.id,
      customer_id: customer.id,
      amount: 60 + i * 14,
      currency: 'USD',
      method: i % 2 === 0 ? 'card' : 'bank_transfer',
      status: i % 3 === 0 ? 'pending' : 'received',
      paid_at: isoOffsetDays(-i),
      reference: `PMT-${7000 + i}`
    };
  });

  const documents = await ensureCount(db, 'documents', 10, async (i) => {
    const customer = pick(customers, i);
    const org = pick(organizations, i);
    return {
      document: `Document ${i + 1}`,
      customer_id: customer.id,
      organization_id: org.id,
      document_type: i % 2 === 0 ? 'contract' : 'receipt',
      file_url: `https://files.example.org/documents/${5000 + i}.pdf`,
      status: 'active',
      notes: 'Generated sample document.'
    };
  });

  const tasks = await ensureCount(db, 'tasks', 12, async (i) => {
    const customer = pick(customers, i);
    const assignee = pick(users, i);
    return {
      task: `Task ${i + 1}`,
      customer_id: customer.id,
      assigned_user_id: assignee.id,
      status: i % 4 === 0 ? 'done' : 'open',
      priority: ['low', 'medium', 'high'][i % 3],
      due_at: isoOffsetDays(i - 2),
      details: 'Follow up with customer and update status.'
    };
  });

  const events = await ensureCount(db, 'events', 16, async (i) => {
    const subjectTable = pick(['customers', 'orders', 'invoices', 'payments', 'appointments', 'tasks'], i);
    const subjects = {
      customers,
      orders,
      invoices,
      payments,
      appointments,
      tasks
    };
    const subject = pick(subjects[subjectTable], i);

    return {
      event: `Event ${i + 1}`,
      event_type: pick(['created', 'updated', 'status.changed', 'notified'], i),
      subject_type: subjectTable,
      subject_id: subject.id,
      payload: {
        table: subjectTable,
        seedIndex: i,
        note: 'Seeded timeline event'
      },
      occurred_at: isoOffsetDays(-i)
    };
  });

  const clamps = await ensureCount(db, 'clamps', 20, async (i) => {
    const pairings = [
      { local: 'customers', localRows: customers, remote: 'orders', remoteRows: orders, context: 'parent' },
      { local: 'orders', localRows: orders, remote: 'invoices', remoteRows: invoices, context: 'billing' },
      { local: 'invoices', localRows: invoices, remote: 'payments', remoteRows: payments, context: 'applied_payment' },
      { local: 'customers', localRows: customers, remote: 'appointments', remoteRows: appointments, context: 'booking' },
      { local: 'customers', localRows: customers, remote: 'tasks', remoteRows: tasks, context: 'follow_up' },
      { local: 'organizations', localRows: organizations, remote: 'contacts', remoteRows: contacts, context: 'contact' }
    ];

    const pair = pick(pairings, i);
    const localRec = pick(pair.localRows, i);
    const remoteRec = pick(pair.remoteRows, i + 1);

    return {
      clamp: `${pair.local}:${localRec.id} -> ${pair.remote}:${remoteRec.id}`,
      local: pair.local,
      local_id: localRec.id,
      remote: pair.remote,
      remote_id: remoteRec.id,
      context: pair.context
    };
  });

  const summary = {
    organizations: organizations.length,
    users: users.length,
    customers: customers.length,
    contacts: contacts.length,
    products: products.length,
    services: services.length,
    orders: orders.length,
    appointments: appointments.length,
    invoices: invoices.length,
    payments: payments.length,
    documents: documents.length,
    tasks: tasks.length,
    events: events.length,
    clamps: clamps.length
  };
  summary.showcase_customers = showcaseCustomers.length;

  console.log('Seed complete:', summary);
  await db.close();
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
