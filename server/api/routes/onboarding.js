import { sendJson } from '../router.js';
import { getOnboardingStatus, completeOnboarding } from '../../onboarding/onboarding-config.js';

// Owner-only (router default). u2-app.js gates the dashboard shell on
// GET's `completed` right after auth succeeds; the wizard (u2-onboarding.js)
// calls POST on its finish step. Reopening the wizard later (e.g. from
// Settings) never calls POST again, so it never re-gates an already
// onboarded owner.
export function registerOnboardingRoutes(router) {
  router.get('/api/onboarding', async (_req, res) => {
    sendJson(res, 200, getOnboardingStatus());
  });

  router.post('/api/onboarding', async (_req, res) => {
    sendJson(res, 200, completeOnboarding());
  });
}
