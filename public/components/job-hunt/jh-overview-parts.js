import { el, monogram, relTime } from './jh-util.js';
import { EXECUTION_LABELS, METRIC_TONES, MODE_LABELS, STAGE_NOTE, STAGE_TONES, filterHref, formatCount, jobHref, until } from './jh-overview-model.js';
import './jh-all.js';

// The sections of the Job Hunt Overview (#629), each a function from the
// /api/job-hunt/overview payload to DOM. Every string from the data is written
// with textContent (through el()) and every link is built from a validated id,
// so a hostile company or role name cannot become markup.

const card = (title, ...children) => el('section', { class: 'jh-panel jh-ov__panel', 'aria-label': title }, ...children);

export function summaryBar(overview) {
  return el('div', { class: 'jh-ov__summary', role: 'group', 'aria-label': 'Job hunt summary' }, overview.metrics.map((metric) => {
    const node = el('jh-summary-card', { label: metric.label, value: formatCount(metric.value), sublabel: metric.sub ?? '', href: filterHref(metric), tone: METRIC_TONES[metric.id] ?? 'neutral', 'data-metric': metric.id });
    return node;
  }));
}

export function autopilotBar(overview) {
  const state = overview.autopilot;
  const controls = el('a', { class: 'jh-link', href: '#/job-hunt/leads', text: 'Autopilot controls' });
  if (!state) {
    return el('div', { class: 'jh-ov__autopilot', 'data-autopilot': 'unavailable' }, el('strong', { class: 'jh-ov__autopilot-title', text: 'Autopilot' }), el('span', { class: 'jh-ov__muted', text: '— not available' }), controls);
  }
  const [modeTone, modeText] = MODE_LABELS[state.mode] ?? ['neutral', '—'];
  const [execTone, execText] = EXECUTION_LABELS[state.execution] ?? ['neutral', '—'];
  return el('div', { class: 'jh-ov__autopilot', 'data-autopilot': state.mode, 'data-execution': state.execution },
    el('strong', { class: 'jh-ov__autopilot-title', text: 'Autopilot' }),
    el('span', { class: 'jh-ov__autopilot-item' }, el('span', { class: 'jh-ov__muted', text: 'Mode' }), el('jh-status-label', { tone: modeTone, label: modeText, 'data-part': 'mode' })),
    el('span', { class: 'jh-ov__autopilot-item' }, el('span', { class: 'jh-ov__muted', text: 'Status' }), el('jh-status-label', { tone: execTone, label: execText, 'data-part': 'execution' })),
    state.lastRunAt ? el('span', { class: 'jh-ov__muted', text: `Last cycle ${relTime(state.lastRunAt)}` }) : el('span', { class: 'jh-ov__muted', text: 'No cycle has run yet' }),
    state.detail ? el('span', { class: 'jh-ov__muted', 'data-part': 'detail', text: state.detail }) : null,
    controls);
}

export function pipeline(overview) {
  const total = overview.stages.filter((stage) => !stage.flag).reduce((n, stage) => n + stage.count, 0);
  return card('Application pipeline',
    el('div', { class: 'jh-panel__head' }, el('h2', { class: 'jh-panel__title', text: 'Application Pipeline' }), el('span', { class: 'jh-panel__meta', text: `${formatCount(total)} in pipeline` })),
    el('ol', { class: 'jh-ov__stages' }, overview.stages.map((stage) => el('li', { class: 'jh-ov__stage', 'data-stage': stage.id, 'data-tone': STAGE_TONES[stage.id] ?? 'neutral', 'data-flag': stage.flag ? '' : null },
      el('a', { class: 'jh-ov__stage-link', href: filterHref(stage), 'aria-label': `${stage.label}: ${formatCount(stage.count)}${stage.flag ? ' (flag, overlaps the other stages)' : ''}` },
        el('span', { class: 'jh-ov__stage-count', text: formatCount(stage.count) }), el('span', { class: 'jh-ov__stage-label', text: stage.label }))))),
    el('p', { class: 'jh-note', text: overview.offPipeline ? `${STAGE_NOTE} ${formatCount(overview.offPipeline)} more are rejected, withdrawn, closed, skipped, errored or of unknown outcome.` : STAGE_NOTE }));
}

function attentionItem(item, now) {
  const href = jobHref(item.jobId, item.question);
  const when = item.deadline ? `Interview ${until(item.deadline, now)}` : relTime(item.since, now);
  return el('li', { class: 'jh-ov__item', 'data-job': item.jobId, 'data-kind': item.kind },
    monogram(item.company, 'md'),
    el('div', { class: 'jh-ov__item-body' },
      el('div', { class: 'jh-ov__item-who' }, el('strong', { text: item.company }), item.role ? el('span', { class: 'jh-ov__muted', text: ` ${item.role}` }) : null),
      el('div', { class: 'jh-ov__item-why', 'data-part': 'explanation', text: item.question ? `${item.explanation}: ${item.question.label}` : item.explanation }),
      el('div', { class: 'jh-ov__muted' }, `${item.score == null ? '—' : `${item.score} fit`} · ${when}`.replace(/ · $/, ''))),
    href ? el('a', { class: 'btn jh-ov__review', href, 'data-part': 'review', 'aria-label': `Review ${item.company}${item.role ? `, ${item.role}` : ''}`, text: 'Review' }) : null);
}

export function attention(overview, now = Date.now()) {
  const { count, items } = overview.attention;
  return card('Needs your attention',
    el('div', { class: 'jh-panel__head' },
      el('h2', { class: 'jh-panel__title' }, 'Needs Your Attention ', el('span', { class: 'jh-ov__badge', 'data-part': 'attention-count', text: formatCount(count) })),
      count ? el('a', { class: 'jh-link', href: filterHref({ filter: 'needs_input' }), text: 'View all' }) : null),
    items.length
      ? el('ul', { class: 'jh-ov__list' }, items.map((item) => attentionItem(item, now)))
      : el('jh-state', { kind: 'empty', title: 'Nothing needs you right now', message: 'Questions, reviews and decisions that block an application appear here.' }),
    count > items.length ? el('p', { class: 'jh-note', text: `Showing the top ${items.length} of ${formatCount(count)}.` }) : null);
}

export function activity(overview, now = Date.now()) {
  return card('Recent activity',
    el('div', { class: 'jh-panel__head' }, el('h2', { class: 'jh-panel__title', text: 'Recent Activity' }), el('a', { class: 'jh-link', href: '#/applications', text: 'Application ledger' })),
    overview.activity.length
      ? el('ul', { class: 'jh-ov__list jh-ov__timeline' }, overview.activity.map((event) => {
        const href = jobHref(event.jobId);
        const who = [event.company, event.role].filter(Boolean).join(' — ');
        return el('li', { class: 'jh-ov__event', 'data-event': event.id },
          el('jh-status-label', { tone: event.tone, label: event.label }),
          href ? el('a', { class: 'jh-link jh-ov__event-job', href, text: who }) : el('span', { text: who }),
          el('span', { class: 'jh-ov__muted', text: relTime(event.at, now) }));
      }))
      : el('jh-state', { kind: 'empty', title: 'No activity yet', message: 'Applications sent, replies and interviews show up here as they happen.' }));
}
