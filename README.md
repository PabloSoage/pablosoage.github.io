# pablosoage.github.io

GitHub Pages site hosting Android App Links verification for [Rustify](https://github.com/PabloSoage/Rustify), a Spotify client for Android.

## Files

- **`.well-known/assetlinks.json`** — Declares `com.varuna.rustify` as the verified handler for `https://pablosoage.github.io/r/...` wrapper links. Contains SHA256 fingerprints for both debug and release signing keys. Android reads this at install time to auto-verify App Links without user interaction.
- **`.nojekyll`** — Tells GitHub Pages to serve the `.well-known` directory as-is (Jekyll ignores dot-prefixed directories by default).

The only functional file is the asset links JSON; there is no website here.
