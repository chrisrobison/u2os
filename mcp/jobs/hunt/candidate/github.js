import fs from 'node:fs';
import path from 'node:path';
import { JOB_HUNT_DIR } from '../../profile.js';

// The candidate's public GitHub projects, cached in the vault so scoring and
// materials do not depend on the network. Only public data is read.

const API = 'https://api.github.com';
export const githubCachePath = (vaultDir) => path.join(vaultDir, JOB_HUNT_DIR, 'state', 'github.json');

async function getJson(fetchImpl, url, accept = 'application/vnd.github+json') {
  const response = await fetchImpl(url, { headers: { accept, 'user-agent': 'u2os-job-hunter', 'x-github-api-version': '2022-11-28' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${new URL(url).pathname}`);
  return accept.includes('raw') ? response.text() : response.json();
}

export async function fetchRepos(user, { fetch: fetchImpl = fetch, api = API, readmes = 12, now = new Date() } = {}) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(user)) throw new Error('Invalid GitHub username');
  const list = await getJson(fetchImpl, `${api}/users/${user}/repos?per_page=100&sort=pushed&type=owner`);
  const repos = (list ?? []).filter((repo) => !repo.fork && !repo.archived && !repo.private).map((repo) => ({
    name: repo.name, url: repo.html_url, description: repo.description || '', language: repo.language || null,
    topics: repo.topics ?? [], stars: repo.stargazers_count ?? 0, pushedAt: repo.pushed_at, readme: '',
  }));
  for (const repo of repos.slice(0, readmes)) {
    try {
      const text = await getJson(fetchImpl, `${api}/repos/${user}/${repo.name}/readme`, 'application/vnd.github.raw');
      repo.readme = String(text ?? '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    } catch { /* a missing README is not an error */ }
  }
  return { user, fetchedAt: now.toISOString(), repos };
}

export function saveRepos(vaultDir, data) {
  const file = githubCachePath(vaultDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function loadRepos(vaultDir) {
  try { return JSON.parse(fs.readFileSync(githubCachePath(vaultDir), 'utf8')); } catch { return null; }
}

const STOP = new Set('the and for with that this are you our your from have will into about more team work build building their they what who can all new use using one also but not out per has was its any get'.split(' '));
const tokens = (text) => String(text).toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g)?.filter((word) => !STOP.has(word)) ?? [];

/**
 * Candidate projects for a job, best first: overlap between the job text and
 * each repository's name, description, topics, language and README. This only
 * shortlists; relevance is judged by the scorer (and may be vetoed there).
 */
export function shortlistProjects(repos, jobText, max = 8) {
  const job = new Set(tokens(jobText));
  return (repos ?? []).map((repo) => {
    const words = new Set(tokens(`${repo.name} ${repo.description} ${(repo.topics ?? []).join(' ')} ${repo.language ?? ''} ${repo.readme ?? ''}`));
    let overlap = 0;
    for (const word of words) if (job.has(word)) overlap += 1;
    return { repo, overlap: overlap / Math.sqrt(Math.max(words.size, 1)) };
  }).filter((entry) => entry.overlap > 0).sort((a, b) => b.overlap - a.overlap).slice(0, max).map((entry) => entry.repo);
}
