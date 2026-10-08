import { NON_US, US, scoreLocation } from './scorer.js';

// A cheap, deterministic filter applied as listings are discovered from large
// sources (a company board can list hundreds of jobs, nearly all irrelevant).
// It only decides what is worth storing and scoring; it never decides what to
// apply to. `--all` on the CLI turns it off.

const ENGINEERING = /\b(engineer|engineering|developer|architect|cto|sre|devops|programmer|swe|software|technical|tech lead|platform|infrastructure|member of technical staff|mts|founding|head of eng|vp of eng|director of eng|machine learning|ml|ai)\b/i;
const EXCLUDED = /\b(intern|internship|junior|jr\.?|entry[\s-]level|new grad|graduate|apprentice|sales|account executive|account manager|marketing|recruiter|recruiting|support specialist|customer success|designer|finance|accountant|legal|counsel|people partner|hr\b|office manager|writer|copywriter|data entry|sdr|bdr|business development|talent|payroll|paralegal|executive assistant)\b/i;
const NOT_THIS_KIND = /\b(sales engineer|solutions? (?:engineer|architect|consultant)|customer engineer|support engineer|field engineer|forward deployed.*sales)\b/i;

/** Returns null when the listing is worth keeping, otherwise a short reason it was skipped. */
export function skipReason(sighting, preferences) {
  const role = sighting.role ?? '';
  if (!role) return 'no role stated';
  if (EXCLUDED.test(role)) return 'not an engineering role at the right level';
  if (NOT_THIS_KIND.test(role)) return 'sales or support engineering';
  if (!ENGINEERING.test(role)) return 'not an engineering role';
  // A job outside the US that does not say it is remote is on-site there, whatever the posting forgot to say.
  const places = (sighting.locations ?? []).join(' ; ');
  if (sighting.remote !== true && NON_US.test(places) && !US.test(places)) return 'location not workable (on-site elsewhere or a non-US region)';
  const location = scoreLocation({ locations: sighting.locations, remote: sighting.remote }, preferences);
  if (location.points <= 2) return 'location not workable (on-site elsewhere or a non-US region)';
  return null;
}
