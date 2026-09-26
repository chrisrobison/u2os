# Job research: bounded passes with retained evidence

This is a read-only research workflow, not an application agent. Automated acceptance uses fictional sources in an isolated demo data directory and a deterministic planner. It has **not** validated a live search provider, current openings, or real-model relevance quality. Existing migration/restart suites cover persisted goals and evidence; the browser scenario covers two useful passes and page reload.

## Personal setup

Start your normal personal installation, authenticate as its owner, and configure a real search connection and a planning model. An unconfigured/failed real service must report unavailable rather than substitute demo results. Historical research and review choices are private: they are sent only to model destinations allowed by your data-processing policy. Withheld context may make a pass less useful; it does not relax policy. Do not connect extra accounts for this walkthrough.

## Owner walkthrough

1. Open **Goals → Job research draft**. This changes only the unsaved form: no search, model call, schedule, or database write. Starting a new draft does not modify a previously saved goal.
2. Add your preferred role, location, experience level, and any other constraints. The starter intentionally invents no personal preferences. Review the three criteria, web-only domain, and cumulative run/model/token budgets. If preferences are missing, the objective asks the planner to clarify them.
3. **Save draft**, then **Run once (read-only)**. A saved draft alone starts nothing. Inspect the linked run, actual tool statuses, source previews, and response. Expect explanations tied to source excerpts and your constraints, explicit missing information, and no claim that a search snippet proves availability. Individual successful reads do not complete the objective.
4. In **Search findings**, mark useful links relevant and unsuitable links dismissed. These are your choices under that goal revision, not established facts. Mock sources say **Demo result**; do not treat them as personal results. Note indexing/coverage limits and observed times.
5. Reload, then run another bounded pass. Previous source-bound reviews can inform planning when privacy permits. **Research update** lists newly indexed links and counts repeats separately. A new indexed link is not necessarily a newly posted job. Refresh local findings if indexing is partial; that refresh does not search again.
6. Inspect cumulative spending and both linked runs. Reported token usage can be incomplete and monetary cost is unavailable. When a cap is reached, another pass is unavailable rather than silently resetting the budget.
7. **Pause goal** to stop new work and invalidate pending wakes/work. To change criteria, edit while paused, save the revision, and explicitly resume. Prior evidence and reviews retain their original revisions. Resume starts nothing and never replays old work. **Cancel goal** is terminal.

Optional: choose **First wake (local time)** and **Schedule one read-only pass** for one future pass. For repeated research, use **Finite web research** to choose 24–720 hours and 2–10 total passes, then **Schedule finite read-only research**. Save your preferences first; review the remaining budget notice. No work starts immediately. The [finite schedule](goals.md#finite-scheduled-web-research) stops on unsuccessful/uncertain work and never catches up missed intervals in a burst. The server must be running; restart picks up a pending overdue wake on a scheduler tick. Inspect its linked run/blocker before explicitly scheduling again. Pause cancels future passes and resume does not rearm them. Browser closure does not cancel an already-started bounded run; inspect persisted evidence after returning. Failed/uncertain prerequisites are not treated as successful findings.

Applications, employer messages, calendar changes and outreach remain separate consequential actions requiring their normal exact-account authorization and approval. The starter cannot authorize them, even if provider text requests them.

## Repeatable fixture acceptance

Run `npm test` and `npm run test:e2e` for the required suites. To focus on this workflow, run `npx playwright test -c tests/e2e/playwright.config.js job-research.spec.js` (Chromium, Firefox and WebKit).

The isolated scenario searches two overlapping result sets, explains remote-role fit and a location mismatch from actual observations, persists an owner relevance choice, passes that choice into the second filtered continuation, reports one new/one repeated link, retains three distinct findings, and proves reload, spending caps and pause do not trigger extra searches. Its deterministic responses prove orchestration and data flow—not a real model's judgment. Evaluate real-model fit quality separately with explicit owner-driven searches before relying on results.
