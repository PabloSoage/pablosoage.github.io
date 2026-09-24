# pablosoage.github.io

A portfolio page, and the Android App Links verification for
[Rustify](https://github.com/PabloSoage/Rustify).

## Files

- **`index.html`** — the whole site. One file, no framework and no build step. Everything it
  shows about the GitHub account — repositories, the language bar, the counters, the
  contribution calendar and the monthly activity — is read from `data.json` beside it. The
  page never calls the GitHub API: unauthenticated, that allows sixty requests an hour per
  address, and asking it on every visit broke the page after a few visits from one network.
- **`data.json`** — generated; do not edit by hand. `scripts/refresh.mjs` writes it and
  `.github/workflows/refresh.yml` runs that every six hours, committing only when something
  changed. Run it on demand from the Actions tab (*Refresh GitHub data → Run workflow*). The
  script drops every private repository itself rather than trusting the token not to see them,
  because it is also run by hand with a personal token that can.
- **`.well-known/assetlinks.json`** — declares `com.varuna.rustify` as the verified handler for
  `https://pablosoage.github.io/r/...` wrapper links, with the SHA-256 fingerprints of the debug
  and release signing keys. Android reads this at install time to auto-verify App Links without
  asking the user.
- **`.nojekyll`** — **do not remove.** Jekyll ignores directories whose name starts with a dot,
  so without this file `.well-known/` stops being served and App Links verification fails
  silently on every future install.
- **`oauth2redirect/index.html`** — the OAuth redirect target.

## If you touch this

The site is decoration; the asset links are load-bearing. After any change, check that the
JSON is still served at the exact path, as JSON, with no redirect:

```
curl -s -o /dev/null -w "%{http_code} %{content_type} redirects=%{num_redirects}\n" \
  -L https://pablosoage.github.io/.well-known/assetlinks.json
```

It must answer `200 application/json redirects=0`. Google's own view of it:

```
https://digitalassetlinks.googleapis.com/v1/statements:list\
?source.web.site=https://pablosoage.github.io&relation=delegate_permission/common.handle_all_urls
```
