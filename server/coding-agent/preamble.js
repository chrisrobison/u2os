// Advisory permission text. Where a CLI can enforce a permission it is mapped
// to that CLI's own flags by the adapter; where it cannot (see
// docs/coding-agents.md "Enforcement gaps") this preamble tells the agent the
// rule in words. It is a request to the model, NOT a security boundary.

/** Lines describing the restrictions that apply to a run, or '' when none. */
export function permissionPreamble(permissions) {
  const rules = [];
  if (permissions.filesystem === 'none') rules.push('Do not read or modify any files.');
  else if (permissions.filesystem === 'read') rules.push('Do not create, modify or delete any files; this is a read-only task.');
  else if (permissions.filesystem === 'project') rules.push('Only read or modify files inside the current working directory.');
  if (!permissions.shell) rules.push('Do not run shell commands.');
  if (!permissions.git) rules.push('Do not run git commands that change the repository (commit, checkout, reset, push, and so on).');
  if (!permissions.network) rules.push('Do not access the network.');
  return rules.length ? `Constraints for this task (set by the owner):\n${rules.map((rule) => `- ${rule}`).join('\n')}\n\n` : '';
}
