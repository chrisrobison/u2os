# GitHub Development Workflow

Use GitHub Issues and Pull Requests as the normal development workflow for this repository.

The purpose is not to introduce human approval bottlenecks. The coding agent is authorized to create, review, merge, and close its own work when all required checks pass.

## General rule

Do not make substantial changes directly on `main`.

For each coherent piece of work:

```text
Issue
  ↓
Working branch
  ↓
Implementation + tests
  ↓
Pull Request
  ↓
Automated/self review
  ↓
CI passes
  ↓
Merge
  ↓
Issue closes
  ↓
Delete branch
```

Small typo/documentation fixes may be committed directly only when creating a PR would add no meaningful value. Prefer PRs when uncertain.

---

# Issues

Before starting a significant task, create a GitHub Issue describing the work.

Use issues for:

* features
* bugs
* security improvements
* architecture changes
* refactors
* migrations
* testing initiatives
* documentation work spanning multiple files

Do not create one giant issue for an entire milestone.

Break milestones into independently useful, reviewable issues.

A good issue should include:

```markdown
## Problem

What is missing, incorrect, unsafe, or difficult today?

## Goal

What should be true when this issue is complete?

## Scope

What is included?

## Non-goals

What is explicitly not being changed?

## Acceptance criteria

- [ ] Observable requirement
- [ ] Tests added
- [ ] Existing tests remain green
- [ ] Documentation updated where necessary

## Relevant files / architecture

Optional notes about likely implementation areas.
```

Use concise titles such as:

```text
privacy: classify event-derived context

queue: persist consequential action execution

ui: expose action explainability

test: add browser coverage for approval workflow
```

---

# Branches

Create a dedicated branch for each issue.

Use names such as:

```text
feature/123-action-explainability
fix/145-sse-reconnect-duplicates
security/151-context-classification
test/162-browser-approval-flow
docs/174-model-config-docs
```

Include the issue number when practical.

Never reuse an old merged branch for unrelated work.

---

# Pull Requests

Once the issue's implementation is complete, push the branch and open a PR.

PR titles should be concise and correspond closely to the issue.

Example:

```text
privacy: classify all model-bound context
```

PR body:

```markdown
Closes #123

## Summary

Brief explanation of the implementation.

## Changes

- ...
- ...
- ...

## Testing

- Added ...
- Ran ...
- Full suite: PASS

## Security / privacy impact

Explain relevant trust-boundary changes, or write "None."

## Known limitations

Anything deliberately deferred.
```

Always use GitHub's automatic issue linkage:

```text
Closes #123
```

so the issue closes automatically when the PR is merged.

---

# Self-review before merge

The coding agent is explicitly authorized to review and merge its own PRs.

Before merging, perform a separate review pass as though reviewing another developer's work.

Review:

1. Correctness
2. Security boundaries
3. Privacy/data leakage
4. Error handling
5. Backwards compatibility
6. Database migration safety
7. Idempotency where relevant
8. Tests
9. Documentation
10. Unnecessary complexity
11. Dead code
12. Accidental secrets or generated artifacts
13. Whether the implementation actually satisfies the linked issue

Inspect the complete diff, not merely the files you remember changing.

If problems are found:

```text
fix them on the same branch
→ push
→ rerun tests
→ review again
```

Do not merge known broken work merely to move on.

---

# Required merge conditions

A PR may be automatically merged when all of the following are true:

* The linked issue's acceptance criteria are satisfied.
* Required automated tests pass.
* The complete existing test suite passes.
* Any new behavior has appropriate tests.
* Database migrations have been checked for existing installations where applicable.
* No secrets or credentials are present.
* No unresolved security/privacy regression is known.
* Documentation matches the implementation.
* The final diff has been self-reviewed.
* The branch is current enough with `main` that there are no unresolved conflicts.

No human approval is required unless the task explicitly says otherwise.

---

# Merge policy

Prefer **squash merge** for normal feature/fix PRs so `main` retains a readable history.

The squash commit should use a useful conventional-style message such as:

```text
privacy: classify all model-bound context (#123)
```

For a PR containing intentionally meaningful separate commits, a normal merge may be used when preserving those commits provides real value.

Do not use force pushes against `main`.

After successful merge:

1. Verify the merge succeeded.
2. Verify the linked issue closed.
3. Delete the remote feature branch.
4. Return to/update local `main`.
5. Pull the merged result.
6. Run any appropriate quick sanity check.
7. Proceed to the next issue.

---

# CI failures

Do not merge a PR with failing required checks.

When CI fails:

```text
inspect failure
→ reproduce locally if possible
→ fix root cause
→ push
→ wait for/recheck CI
```

Do not bypass a legitimate failing check just to complete the workflow.

If a test itself is incorrect, fix the test only after establishing why its expectation no longer represents intended behavior.

---

# PR size

Prefer small and reviewable PRs.

A PR should generally implement one coherent idea.

Bad:

```text
Implement privacy, queues, new dashboards, voice changes, and connector framework
```

Good:

```text
#201 Add classification metadata to event context
#202 Enforce privacy policy across event context
#203 Add regression tests for remote event leakage
```

Related tiny changes may be combined when separating them would create artificial or broken intermediate states.

---

# Milestones and parent issues

For large development phases, create a tracking issue.

Example:

```text
Milestone: Complete model-bound privacy enforcement
```

with child issues:

```text
- [ ] #201 Define common context classification metadata
- [ ] #202 Classify events and commitments
- [ ] #203 Apply filtering across all context types
- [ ] #204 Add privacy regression coverage
- [ ] #205 Reconcile privacy documentation
```

Do not implement the entire parent issue in one branch.

Complete the child issues individually through PRs.

Close the parent issue when all child work is complete.

---

# Autonomous authority

You are authorized to perform the entire GitHub lifecycle without requesting confirmation for routine repository work:

```text
create issue
create branch
implement
commit
push
open PR
review PR
fix findings
run tests
merge PR
close issue
delete branch
continue
```

Do not stop merely because a pull request has been opened.

Opening the PR is an intermediate step, not task completion.

Do not ask the user to merge a PR that satisfies the automatic merge criteria above.

Escalate instead of automatically merging only when:

* the change would knowingly weaken an existing security boundary
* data loss or irreversible migration risk remains unresolved
* requirements materially conflict
* required CI cannot be made to pass without changing intended behavior
* credentials/secrets appear compromised
* the repository's branch protection prevents the authorized merge

Otherwise, continue through merge automatically.

---

# Definition of done

A development issue is not complete when code has merely been written.

It is complete when:

```text
Issue created
✓

Implementation finished
✓

Tests written
✓

Full test suite passes
✓

Documentation updated
✓

PR opened
✓

PR self-reviewed
✓

CI passes
✓

PR merged
✓

Issue closed
✓

Branch deleted
✓

main updated
✓
```

Only then proceed to the next issue.

