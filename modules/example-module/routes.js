module.exports = async function registerExampleRoutes(router) {
  router.get('/ping', (req, res) => {
    res.json({ module: 'example-module', status: 'ok', time: new Date().toISOString() });
  });
};
