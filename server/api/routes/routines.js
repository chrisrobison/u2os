import { sendJson } from '../router.js';
import { listRoutineStatus, runRoutineNow } from '../../routines/routine-runner.js';

// Owner-only (router default). Routines are edited as vault files, not
// through the API; these routes only report and run them.
export function registerRoutineRoutes(router, { eventBus, agent }) {
  router.get('/api/routines', async (_req, res) => {
    sendJson(res, 200, { routines: listRoutineStatus() });
  });

  router.post('/api/routines/run', async (req, res) => {
    const routinePath = req.body?.path;
    if (typeof routinePath !== 'string' || !routinePath) return sendJson(res, 400, { error: 'path is required' });
    const result = await runRoutineNow({ eventBus, agent, routinePath });
    if (result.status === 'not_found') return sendJson(res, 404, { error: 'Not Found' });
    if (result.status === 'invalid') return sendJson(res, 422, { error: result.reason });
    sendJson(res, 200, { result });
  });
}
