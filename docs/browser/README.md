# Docs browser

A small static app for browsing `docs/*.md` in a real page instead of a
plain-text/rendered-file view: sidebar navigation, per-page table of
contents, full-text search, a raw/rendered toggle, and light/dark themes.

It's plain HTML + CSS + vanilla JS -- `index.html`, `style.css`, `app.js`.
No build step, no framework, no server-side code, no dependencies.

## Running it

The page fetches the markdown files with `fetch()`, which browsers block
from `file://` pages. Serve this directory (or the repo) over plain HTTP
with whatever's on hand, e.g. from the repo root:

```sh
npx serve docs
# or
python3 -m http.server 8000 --directory docs
```

Then open `http://localhost:<port>/browser/`.

## Adding a new doc

Add the filename to the `DOC_FILES` array at the top of `app.js`. That's
the only place the file list is declared (no manifest to regenerate).
