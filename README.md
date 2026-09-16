# pablosoage.github.io

A portfolio page, and the Android App Links verification for
[Rustify](https://github.com/PabloSoage/Rustify).

## Files

- **`index.html`** — the whole site. One file, no framework and no build step: the layout is
  static, and the repository metadata (language, stars, last push, the language bar, the
  counters) is read from the GitHub API in the browser and cached in `localStorage` for an hour.
  It renders correctly with the API unavailable, which matters because an unauthenticated caller
  gets sixty requests an hour shared with everyone behind the same address.
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
