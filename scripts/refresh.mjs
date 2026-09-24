// Collects what the page shows about the GitHub account into data.json, so the
// page itself never calls the GitHub API. Unauthenticated, that API allows 60
// requests an hour per address; a page asking it on every visit runs out after
// a handful of visits from the same network and shows nothing.
//
//   GITHUB_TOKEN=… node scripts/refresh.mjs [out]
//
// Only public repositories are ever written out. The token in the workflow
// cannot see private ones anyway, but this is also run by hand with a personal
// token, which can — so every list is filtered on visibility here, not trusted
// to the token.

import { writeFileSync } from 'node:fs';

const LOGIN = 'PabloSoage';
const OUT = process.argv[2] ?? 'data.json';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('GITHUB_TOKEN is not set'); process.exit(1); }

const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'pablosoage.github.io refresh',
};

async function rest(path) {
  const r = await fetch(`https://api.github.com/${path}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function graphql(query, variables) {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST', headers: HEADERS, body: JSON.stringify({ query, variables }),
  });
  const body = await r.json();
  if (!r.ok || body.errors) throw new Error(JSON.stringify(body.errors ?? body));
  return body.data;
}

// ── repositories and their languages ────────────────────────────────────
const listed = await rest(`users/${LOGIN}/repos?per_page=100&type=owner&sort=pushed`);
const repos = listed
  .filter((r) => !r.private)
  .map((r) => ({
    name: r.name, html_url: r.html_url, language: r.language,
    stargazers_count: r.stargazers_count, pushed_at: r.pushed_at,
    created_at: r.created_at, fork: r.fork, archived: r.archived,
  }));

const languages = {};
for (const r of repos) {
  if (r.fork) continue;
  languages[r.name] = await rest(`repos/${LOGIN}/${r.name}/languages`);
}

// ── contribution calendar ───────────────────────────────────────────────
const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

const cal = await graphql(`query($login: String!) {
  user(login: $login) { contributionsCollection { contributionCalendar {
    totalContributions
    weeks { contributionDays { date contributionCount contributionLevel } }
  } } }
}`, { login: LOGIN });

const calendar = cal.user.contributionsCollection.contributionCalendar;
const days = calendar.weeks.flatMap((w) => w.contributionDays)
  .map((d) => ({ date: d.date, count: d.contributionCount, level: LEVEL[d.contributionLevel] ?? 0 }));

// ── commits per repository, month by month ──────────────────────────────
// The API answers this per time window, and a window may not span more than
// a year, so it is asked once per calendar month the calendar covers.
const months = [...new Set(days.map((d) => d.date.slice(0, 7)))];
const commits = {};
for (const m of months) {
  const [y, mo] = m.split('-').map(Number);
  const from = new Date(Date.UTC(y, mo - 1, 1));
  const to = new Date(Date.UTC(y, mo, 1) - 1000);
  const q = await graphql(`query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) { contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      commitContributionsByRepository(maxRepositories: 100) {
        repository { name url isPrivate }
        contributions(first: 100) { nodes { commitCount } }
      }
    } }
  }`, { login: LOGIN, from: from.toISOString(), to: to.toISOString() });

  const c = q.user.contributionsCollection;
  const perRepo = c.commitContributionsByRepository
    .filter((x) => !x.repository.isPrivate)
    .map((x) => ({
      name: x.repository.name, url: x.repository.url,
      commits: x.contributions.nodes.reduce((n, k) => n + k.commitCount, 0),
    }))
    .filter((x) => x.commits > 0)
    .sort((a, b) => b.commits - a.commits);
  commits[m] = { total: c.totalCommitContributions, public: perRepo };
}

const data = {
  repos, languages,
  calendar: { total: calendar.totalContributions, days },
  commits,
};
writeFileSync(OUT, JSON.stringify(data) + '\n');
console.log(`${OUT}: ${repos.length} repos, ${days.length} days, ${calendar.totalContributions} contributions`);
