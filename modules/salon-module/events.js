module.exports = async function registerSalonEvents({ eventBus, logger }) {
  eventBus.subscribe('appointment.booked', async ({ payload }) => {
    logger.info(`Booked appointment ${payload.appointmentId} for ${payload.scheduledAt || 'unscheduled time'}`);
  });

  eventBus.subscribe('payment.received', async ({ payload }) => {
    logger.info(`Payment received event observed: ${payload.id || 'unknown id'}`);
  });
};
