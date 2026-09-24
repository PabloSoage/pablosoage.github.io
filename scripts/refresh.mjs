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

// ── contribution calendars ──────────────────────────────────────────────
// One view for the last twelve months, as the profile opens with, and one per
// calendar year the account has contributions in, as its year list offers.
const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };
const TODAY = new Date().toISOString().slice(0, 10);

async function calendarFor(from, to) {
  const q = await graphql(`query($login: String!, $from: DateTime, $to: DateTime) {
    user(login: $login) { contributionsCollection(from: $from, to: $to) {
      contributionYears
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
    } }
  }`, { login: LOGIN, from, to });
  const c = q.user.contributionsCollection;
  // A calendar year that is still running comes back through 31 December;
  // the days that have not happened yet are dropped.
  const days = c.contributionCalendar.weeks.flatMap((w) => w.contributionDays)
    .filter((d) => d.date <= TODAY)
    .map((d) => ({ date: d.date, count: d.contributionCount, level: LEVEL[d.contributionLevel] ?? 0 }));
  return { years: c.contributionYears, total: c.contributionCalendar.totalContributions, days };
}

// ── commits per repository, month by month ──────────────────────────────
// The API answers this per time window, so it is asked once per month of a
// view, the window clipped to the days the view covers: the rolling year
// starts mid-month. Identical windows are asked once across views.
const asked = new Map();

async function commitsBetween(from, to) {
  const key = from + '|' + to;
  if (!asked.has(key)) {
    const q = await graphql(`query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) { contributionsCollection(from: $from, to: $to) {
        commitContributionsByRepository(maxRepositories: 100) {
          repository { name url isPrivate }
          contributions(first: 100) { nodes { commitCount } }
        }
      } }
    }`, { login: LOGIN, from, to });
    asked.set(key, q.user.contributionsCollection.commitContributionsByRepository
      .filter((x) => !x.repository.isPrivate)
      .map((x) => ({
        name: x.repository.name, url: x.repository.url,
        commits: x.contributions.nodes.reduce((n, k) => n + k.commitCount, 0),
      }))
      .filter((x) => x.commits > 0)
      .sort((a, b) => b.commits - a.commits));
  }
  return asked.get(key);
}

async function view(id, label, from, to) {
  const cal = await calendarFor(from, to);
  const commits = {};
  for (const m of [...new Set(cal.days.map((d) => d.date.slice(0, 7)))]) {
    const inMonth = cal.days.filter((d) => d.date.startsWith(m));
    const first = inMonth[0].date, last = inMonth[inMonth.length - 1].date;
    commits[m] = { public: await commitsBetween(first + 'T00:00:00Z', last + 'T23:59:59Z') };
  }
  return { id, label, total: cal.total, days: cal.days, commits, years: cal.years };
}

const rolling = await view('last', 'Last 12 months', null, null);
const views = [rolling];
for (const y of rolling.years) {
  views.push(await view(String(y), String(y), `${y}-01-01T00:00:00Z`, `${y}-12-31T23:59:59Z`));
}
for (const v of views) delete v.years;

const data = { repos, languages, views };
writeFileSync(OUT, JSON.stringify(data) + '\n');
console.log(`${OUT}: ${repos.length} repos; ` +
  views.map((v) => `${v.id} ${v.total} over ${v.days.length} days`).join(', '));
