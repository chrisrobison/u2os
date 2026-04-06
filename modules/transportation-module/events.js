module.exports = async function registerTransportationEvents({ eventBus, logger }) {
  eventBus.subscribe('transportation.request.created', async ({ payload }) => {
    logger.info(`Request created ${payload.requestPublicId || payload.requestId}`);
  });

  eventBus.subscribe('transportation.trip.scheduled', async ({ payload }) => {
    logger.info(`Trip scheduled ${payload.tripPublicId || payload.tripId}`);
  });

  eventBus.subscribe('transportation.trip.completed', async ({ payload }) => {
    logger.info(`Trip completed ${payload.tripPublicId || payload.tripId}`);
  });
};
