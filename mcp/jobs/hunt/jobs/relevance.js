import { NON_US, US, scoreLocation } from './scorer.js';

// A cheap, deterministic filter applied as listings are discovered from large
// sources (a company board can list hundreds of jobs, nearly all irrelevant).
// It only decides what is worth storing and scoring; it never decides what to
// apply to. `--all` on the CLI turns it off.

const ENGINEERING = /\b(engineer|engineering|developer|architect|cto|sre|devops|programmer|swe|software|technical|tech lead|platform|infrastructure|member of technical staff|mts|founding|head of eng|vp of eng|director of eng|machine learning|ml|ai)\b/i;
const EXCLUDED = /\b(intern|internship|junior|jr\.?|entry[\s-]level|new grad|graduate|apprentice|sales|account executive|account manager|marketing|recruiter|recruiting|support specialist|customer success|designer|finance|accountant|legal|counsel|people partner|hr\b|office manager|writer|copywriter|data entry|sdr|bdr|business development|talent|payroll|paralegal|executive assistant)\b/i;
const GTM = /\b(gtm|go[\s-]to[\s-]market|growth|operator|operations? manager|business operations|biz ?ops|partnerships?|community|content|brand|events?|product marketing|chief of staff)\b/i;
// Hardware, mechanical and similar disciplines: only relevant when the title also says software.
const HARDWARE = /\b(mechanical|electrical|electronics?|avionics|optical|optics|mechanisms?|manufacturing|structural|propulsion|thermal|rf|analog|asic|fpga|civil|chemical|biomedical|materials|aerospace|spacecraft|hardware|mission assurance|test technician|reliability)\b/i;
const SOFTWARE_CUE = /\b(software|firmware|embedded|ml|machine learning|ai|data|platform|backend|back[\s-]end|front[\s-]end|full[\s-]?stack|cloud|devops|sre|infrastructure|security software|autonomy software|developer)\b/i;
const NOT_THIS_KIND = /\b(sales engineer|solutions? (?:engineer|architect|consultant)|customer engineer|support engineer|field engineer|forward deployed.*sales)\b/i;

/** Returns null when the listing is worth keeping, otherwise a short reason it was skipped. */
export function skipReason(sighting, preferences) {
  const role = sighting.role ?? '';
  if (!role) return 'no role stated';
  if (EXCLUDED.test(role)) return 'not an engineering role at the right level';
  if (NOT_THIS_KIND.test(role)) return 'sales or support engineering';
  // GTM, growth, content and similar titles are business roles unless the title also names engineering work.
  if (GTM.test(role) && !/\b(engineer|engineering|developer|architect|software)\b/i.test(role)) return 'not an engineering role';
  if (HARDWARE.test(role) && !SOFTWARE_CUE.test(role)) return 'hardware or non-software engineering';
  if (!ENGINEERING.test(role)) return 'not an engineering role';
  // A job outside the US that does not say it is remote is on-site there, whatever the posting forgot to say.
  const places = (sighting.locations ?? []).join(' ; ');
  if (sighting.remote !== true && NON_US.test(places) && !US.test(places)) return 'location not workable (on-site elsewhere or a non-US region)';
  const location = scoreLocation({ locations: sighting.locations, remote: sighting.remote }, preferences);
  if (location.points <= 2) return 'location not workable (on-site elsewhere or a non-US region)';
  return null;
}

const FILTERED_SOURCES = new Set(['greenhouse', 'lever', 'ashby', 'hnjobs', 'remoteok', 'weworkremotely']);

/**
 * Applies the relevance filter to jobs already stored: unscored jobs that
 * every source for came from a board or aggregator, and that fail the filter,
 * are marked skipped (with the reason in the event). HN-thread jobs, scored
 * jobs and anything acted on are never touched.
 */
export function refilterStored({ store, preferences, dryRun = false, now = new Date() }) {
  const result = { examined: 0, skipped: {}, changed: 0 };
  for (const job of store.listJobs({ status: 'discovered', limit: 20000 })) {
    const sources = store.listSources(job.id);
    if (!sources.length || !sources.every((source) => FILTERED_SOURCES.has(source.source)) || store.getScore(job.id)) continue;
    result.examined += 1;
    const reason = skipReason(job, preferences);
    if (!reason) continue;
    result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
    result.changed += 1;
    if (!dryRun) store.transition(job.id, 'skipped', { reason, by: 'refilter' }, now);
  }
  return result;
}
