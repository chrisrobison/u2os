module.exports = async function registerSalonRoutes(router, { db, eventBus }) {
  router.get('/appointments', async (req, res, next) => {
    try {
      const rows = await db.list('appointments', {
        q: req.query.q,
        limit: req.query.limit ? Number.parseInt(req.query.limit, 10) : 50,
        offset: req.query.offset ? Number.parseInt(req.query.offset, 10) : 0
      });
      res.json(rows);
    } catch (error) {
      next(error);
    }
  });

  router.post('/appointments', async (req, res, next) => {
    try {
      const payload = {
        ...req.body,
        appointment: req.body.appointment || req.body.name || 'Salon Appointment',
        start_at: req.body.start_at || req.body.scheduled_at || null,
        status: req.body.status || 'booked'
      };

      const appointment = await db.create('appointments', payload);
      await eventBus.publish('appointment.booked', {
        appointmentId: appointment.id,
        customerId: appointment.customer_id || null,
        startAt: appointment.start_at || null,
        record: appointment
      });

      res.status(201).json(appointment);
    } catch (error) {
      next(error);
    }
  });

  router.get('/calendar', async (req, res, next) => {
    try {
      const rows = await db.list('appointments', { limit: 200, offset: 0 });
      const events = rows
        .filter((item) => item.start_at)
        .map((item) => ({
          id: item.id,
          title: item.appointment || 'Appointment',
          startsAt: item.start_at,
          status: item.status,
          customerId: item.customer_id || null
        }));

      res.json({ events });
    } catch (error) {
      next(error);
    }
  });
};
