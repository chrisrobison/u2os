module.exports = async function registerExampleEvents({ eventBus, logger }) {
  eventBus.subscribe('customer.created', async ({ payload }) => {
    logger.info(`Observed customer.created for id=${payload.id}`);
  });
};
