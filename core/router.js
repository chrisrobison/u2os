const express = require('express');
const entities = require('./entities');

function createEntityRouter(db, eventBus) {
  const router = express.Router();
  const entitySet = new Set(entities);

  for (const entity of entities) {
    router.post(`/${entity}`, async (req, res, next) => {
      try {
        const created = await db.create(entity, req.body || {});
        await eventBus.publish(`${entity.slice(0, -1)}.created`, { entity, id: created.id, record: created });
        res.status(201).json(created);
      } catch (error) {
        next(error);
      }
    });

    router.get(`/${entity}`, async (req, res, next) => {
      try {
        const { q, limit, offset } = req.query;
        const rows = await db.list(entity, {
          q,
          limit: limit ? Number.parseInt(limit, 10) : undefined,
          offset: offset ? Number.parseInt(offset, 10) : undefined
        });
        res.json(rows);
      } catch (error) {
        next(error);
      }
    });

    router.get(`/${entity}/:id`, async (req, res, next) => {
      try {
        const row = await db.getById(entity, req.params.id);
        if (!row) {
          return res.status(404).json({ error: `${entity} record not found` });
        }
        return res.json(row);
      } catch (error) {
        return next(error);
      }
    });

    router.put(`/${entity}/:id`, async (req, res, next) => {
      try {
        const updated = await db.update(entity, req.params.id, req.body || {});
        if (!updated) {
          return res.status(404).json({ error: `${entity} record not found` });
        }

        await eventBus.publish(`${entity.slice(0, -1)}.updated`, { entity, id: updated.id, record: updated });
        return res.json(updated);
      } catch (error) {
        return next(error);
      }
    });

    router.delete(`/${entity}/:id`, async (req, res, next) => {
      try {
        const deleted = await db.remove(entity, req.params.id);
        if (!deleted) {
          return res.status(404).json({ error: `${entity} record not found` });
        }

        await eventBus.publish(`${entity.slice(0, -1)}.deleted`, { entity, id: req.params.id });
        return res.status(204).send();
      } catch (error) {
        return next(error);
      }
    });
  }

  router.get('/events', async (req, res, next) => {
    try {
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 100;
      const items = await db.listEvents(limit);
      res.json(items);
    } catch (error) {
      next(error);
    }
  });

  router.get('/analytics', async (req, res, next) => {
    try {
      const counts = {};
      await Promise.all(
        entities.map(async (entity) => {
          counts[entity] = await db.count(entity);
        })
      );
      res.json({
        generatedAt: new Date().toISOString(),
        entityCounts: counts
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/schema/:entity', async (req, res, next) => {
    try {
      const schema = await db.describe(req.params.entity);
      res.json({ entity: req.params.entity, columns: schema });
    } catch (error) {
      if (error.message && error.message.startsWith('Unknown entity')) {
        return res.status(404).json({ error: error.message });
      }
      return next(error);
    }
  });

  async function createClampLink(req, res, next) {
    try {
      const { local, local_id, remote, remote_id, context } = req.body || {};
      if (!local || !local_id || !remote || !remote_id) {
        return res.status(400).json({ error: 'local, local_id, remote, and remote_id are required' });
      }
      if (!entitySet.has(local) || !entitySet.has(remote)) {
        return res.status(400).json({ error: 'local and remote must be valid table names' });
      }

      const clamp = await db.create('clamps', {
        clamp: `${local}:${local_id} -> ${remote}:${remote_id}`,
        local,
        local_id,
        remote,
        remote_id,
        context: context || null
      });

      await eventBus.publish('clamp.created', { id: clamp.id, record: clamp });
      return res.status(201).json(clamp);
    } catch (error) {
      return next(error);
    }
  }

  router.post('/links', createClampLink);
  router.post('/clamps/link', createClampLink);

  router.get('/links', async (req, res, next) => {
    try {
      const { local, local_id, remote, remote_id, context, limit } = req.query;
      const rows = await db.list('clamps', {
        limit: limit ? Number.parseInt(limit, 10) : 500,
        offset: 0
      });

      const filtered = rows.filter((row) => {
        if (local && row.local !== local) return false;
        if (local_id && row.local_id !== local_id) return false;
        if (remote && row.remote !== remote) return false;
        if (remote_id && row.remote_id !== remote_id) return false;
        if (context && row.context !== context) return false;
        return true;
      });

      return res.json(filtered);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:entity/:id/links', async (req, res, next) => {
    try {
      const { entity, id } = req.params;
      if (!entitySet.has(entity)) {
        return res.status(404).json({ error: `Unknown entity '${entity}'` });
      }

      const rows = await db.list('clamps', { limit: 1000, offset: 0 });
      const links = rows.filter((row) =>
        (row.local === entity && row.local_id === id) ||
        (row.remote === entity && row.remote_id === id)
      );

      return res.json(links);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = createEntityRouter;
