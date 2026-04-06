module.exports = async function registerTransportationJobs({ scheduler, db, logger }) {
  scheduler.addJob('transportation-dispatch-snapshot', async () => {
    const rows = typeof db.listByFilters === 'function'
      ? await db.listByFilters('transportation_trips', {
        filters: [{ column: 'status', op: 'in', value: ['scheduled', 'in_progress'] }],
        limit: 100,
        offset: 0
      })
      : await db.list('transportation_trips', { limit: 100, offset: 0 });

    logger.info(`Dispatch board snapshot: ${rows.length} active or scheduled trips`);
  }, 5 * 60 * 1000);
};
