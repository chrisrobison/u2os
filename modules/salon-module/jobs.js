module.exports = async function registerSalonJobs({ scheduler, db, logger }) {
  scheduler.addJob('salon-upcoming-appointments', async () => {
    const items = await db.list('appointments', { limit: 20 });
    const upcoming = items.filter((item) => item.status === 'booked');
    logger.info(`Upcoming booked appointments: ${upcoming.length}`);
  }, 60 * 1000);
};
