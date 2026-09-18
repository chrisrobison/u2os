import { sendJson } from '../router.js';
import { getVoiceEnrollment, saveVoiceEnrollment, clearVoiceEnrollment } from '../../voice/enrollment-store.js';

// Phase 5 voice enrollment persistence (docs/voice.md). The vector stored
// here is a lightweight spectral/DSP fingerprint computed client-side
// (public/services/voiceprint.js) -- NOT a trained neural
// speaker-embedding model; see that module's header comment for the full
// honesty note. This route only stores/returns it.
export function registerVoiceRoutes(router) {
  router.get('/api/voice/enrollment', (_req, res) => {
    const { enrolled, enrolledAt, vector } = getVoiceEnrollment();
    sendJson(res, 200, { enrolled, enrolledAt, vector });
  });

  router.post('/api/voice/enrollment', (req, res) => {
    const vector = req.body?.vector;
    if (!Array.isArray(vector) || !vector.length) {
      return sendJson(res, 400, { error: 'vector (a non-empty array of numbers) is required' });
    }
    try {
      const { enrolled, enrolledAt } = saveVoiceEnrollment(vector);
      sendJson(res, 200, { enrolled, enrolledAt });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  router.delete('/api/voice/enrollment', (_req, res) => {
    const { enrolled, enrolledAt } = clearVoiceEnrollment();
    sendJson(res, 200, { enrolled, enrolledAt });
  });
}
