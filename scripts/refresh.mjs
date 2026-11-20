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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOGIN = 'PabloSoage';
const OUT = process.argv[2] ?? 'data.json';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('GITHUB_TOKEN is not set'); process.exit(1); }

const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'pablosoage.github.io refresh',
};

// A kept-alive connection can be dropped by the far end while the clones run;
// the request is retried on a socket error, never on an HTTP error.
async function get(url, init) {
  for (let i = 0; ; i++) {
    try { return await fetch(url, init); }
    catch (e) { if (i === 2) throw e; await new Promise((ok) => setTimeout(ok, 2000)); }
  }
}

async function rest(path) {
  const r = await get(`https://api.github.com/${path}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function graphql(query, variables) {
  const r = await get('https://api.github.com/graphql', {
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
    description: r.description, topics: r.topics ?? [], homepage: r.homepage || null,
  }));

const languages = {};
for (const r of repos) {
  if (r.fork) continue;
  languages[r.name] = await rest(`repos/${LOGIN}/${r.name}/languages`);
}

// ── lines of source per language ────────────────────────────────────────
// The languages endpoint counts bytes. Lines are what people read, so each
// public repository is cloned at its tip and Linguist — the same classifier
// GitHub uses, with its vendored and generated rules — says which files are
// which language; their non-blank lines are counted here. Needs
// `github-linguist` on the PATH (apt: ruby-github-linguist); without it this
// step is skipped and the page falls back to bytes.
const lines = {};
const hasLinguist = spawnSync('github-linguist', ['--version']).status === 0;
if (hasLinguist) {
  const work = mkdtempSync(join(tmpdir(), 'lines-'));
  for (const r of repos) {
    if (r.fork) continue;
    const dir = join(work, r.name);
    const clone = spawnSync('git', ['clone', '--quiet', '--depth', '1', `https://github.com/${LOGIN}/${r.name}.git`, dir]);
    if (clone.status !== 0) { console.warn(`${r.name}: clone failed, no line count`); continue; }
    const out = spawnSync('github-linguist', ['--breakdown', '--json'], { cwd: dir, maxBuffer: 1 << 28 });
    if (out.status !== 0) { console.warn(`${r.name}: linguist failed, no line count`); continue; }
    const perLang = {};
    for (const [lang, info] of Object.entries(JSON.parse(out.stdout.toString()))) {
      let n = 0;
      for (const f of info.files) {
        try { n += readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).length; }
        catch { /* a file Linguist names but the checkout lacks, e.g. a broken symlink */ }
      }
      if (n) perLang[lang] = n;
    }
    lines[r.name] = perLang;
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(work, { recursive: true, force: true });
} else {
  console.warn('github-linguist not found: lines of source not collected');
}

// ── upstream: issues and pull requests in other people's repositories ───
// Search only ever returns public repositories to an unauthenticated view of
// them, but the repository is checked anyway, as everywhere else here.
const found = await rest(`search/issues?q=${encodeURIComponent(`author:${LOGIN} -user:${LOGIN}`)}&sort=updated&order=desc&per_page=100`);
const upstream = [];
for (const it of found.items) {
  const repo = it.repository_url.replace('https://api.github.com/repos/', '');
  const meta = await rest(`repos/${repo}`);
  if (meta.private) continue;
  upstream.push({
    repo, repo_url: meta.html_url, stars: meta.stargazers_count,
    number: it.number, title: it.title, url: it.html_url,
    kind: it.pull_request ? 'pr' : 'issue',
    state: it.pull_request?.merged_at ? 'merged' : it.state,
    state_reason: it.state_reason ?? null,
    comments: it.comments, created_at: it.created_at, updated_at: it.updated_at,
  });
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

const data = { repos, languages, lines, upstream, views };
writeFileSync(OUT, JSON.stringify(data) + '\n');
console.log(`${OUT}: ${repos.length} repos, ${Object.keys(lines).length} line-counted, ${upstream.length} upstream; ` +
  views.map((v) => `${v.id} ${v.total} over ${v.days.length} days`).join(', '));
