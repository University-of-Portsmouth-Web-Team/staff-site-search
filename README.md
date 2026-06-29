# Staff Site Search

A zero-cost, automated search index for the University of Portsmouth staff intranet
(`staff.port.ac.uk`). This repository crawls the staff site on a schedule, extracts
structured content from every page, and publishes a JSON index that a lightweight
client-side search front-end (Fuse.js) queries directly in the browser.

It exists as a temporary, no-budget solution to provide staff with usable search
until the planned SharePoint migration completes. There is nothing to buy, no T4
module to install, and no editor involvement — the crawler indexes the live site
automatically.

## How it works

```
                 weekly (cron) or manual
                         │
                         ▼
   ┌──────────────────────────────────────────┐
   │  GitHub Actions runner                     │
   │                                            │
   │  1. npm install (deps only)                │
   │  2. Install Chrome for Puppeteer           │
   │  3. node crawl.js                          │
   │       ├─ SSO login (NetIQ Access Manager)  │
   │       ├─ crawl + extract every page        │
   │       └─ write docs/search-index.json      │
   │  4. commit & push the updated index        │
   └──────────────────────────────────────────┘
                         │
                         ▼
        docs/search-index.json  (served via GitHub Pages)
                         │
                         ▼
        Fuse.js client-side search front-end (in the browser)
```

The crawler logs into the staff site through the University's SSO
(Novell/NetIQ Access Manager), walks the site following internal links, and
extracts each page's title, headings, body text, link text, and last-modified
metadata. The result is written to `docs/search-index.json`, which is published
via GitHub Pages and consumed by the search front-end.

## Repository structure

```
.
├── .github/workflows/
│   └── crawl.yml            # Weekly automation: crawl, rebuild, commit the index
├── crawler/
│   ├── crawl.js             # Puppeteer crawler + content extraction
│   ├── package.json         # Dependencies (puppeteer, cheerio)
│   └── package-lock.json
├── docs/
│   └── search-index.json    # Generated index (served via GitHub Pages)
└── README.md
```

> **Note:** The search front-end (the floating widget, the standalone search page,
> and the Fuse.js configuration) is maintained separately. This repository's job is
> to produce and publish `search-index.json`; the front-end fetches that file at
> runtime.

## The crawler

`crawler/crawl.js` does the following:

1. **SSO login** — Navigates directly to the non-MFA `ct-id-vault-all-users`
   route, which renders a standard username/password form. This deliberately
   bypasses the default page's Kerberos-first flow. The form fields are
   `Ecom_User_ID` and `Ecom_Password`, and the sign-in control is a `<span>` with
   id `loginButton2` (not a standard button/input). If NetIQ redirects to its
   portal instead of the target URL, the crawler navigates directly to the staff
   site — the session cookie is already set, so it passes through.
2. **Crawl** — Starts at the base URL and follows internal links breadth-first,
   skipping query strings and fragments, with a polite delay between requests. If
   a page bounces back to SSO mid-crawl (session expiry), it re-authenticates and
   retries.
3. **Extract** — For each page, strips navigation/header/footer/script/style, then
   captures the fields below.
4. **Write** — Saves the full index to `docs/search-index.json`.

### Index schema

Each record in `search-index.json` looks like:

```json
{
  "url": "https://staff.port.ac.uk/some-page",
  "title": "Page title (site-name suffix stripped)",
  "headings": "Concatenated h1–h5 text",
  "body": "Concatenated paragraph / list / table-cell text",
  "links": "Concatenated link text from the page",
  "lastModified": "Raw date string parsed from an HTML comment, or null",
  "lastModifiedBy": "Author parsed from an HTML comment, or null"
}
```

Title, headings, body, and links are stored as **separate** fields so the front-end
can weight them independently in Fuse.js. `lastModified` / `lastModifiedBy` are
parsed from the page's HTML comments, which appear in several different formats —
the parser tries each known pattern in order.

### Configuration

Adjust these constants at the top of `crawl.js`:

| Constant     | Default                      | Purpose                                      |
|--------------|------------------------------|----------------------------------------------|
| `BASE_URL`   | `https://staff.port.ac.uk`   | Site to crawl (overridable via env)          |
| `MAX_PAGES`  | `2000`                       | Safety cap on the number of pages indexed    |
| `DELAY_MS`   | `500`                        | Delay between page visits (politeness)       |

### Required secrets / environment variables

The crawler reads credentials from the environment and never hardcodes them. In
GitHub, set these as repository **Actions secrets**:

| Variable          | Description                                    |
|-------------------|------------------------------------------------|
| `STAFF_SITE_URL`  | Base URL of the staff site (optional override) |
| `STAFF_USERNAME`  | SSO username for the crawl account             |
| `STAFF_PASSWORD`  | SSO password for the crawl account             |

Use a dedicated, low-privilege account for crawling rather than a personal login.

## Running locally

```bash
cd crawler
npm install
npx puppeteer browsers install chrome

export STAFF_USERNAME='your-sso-username'
export STAFF_PASSWORD='your-sso-password'
# Optional:
# export STAFF_SITE_URL='https://staff.port.ac.uk'

node crawl.js
```

The crawler logs each page as it visits it and writes the result to
`../docs/search-index.json`. Requires Node.js 24.

## Automation (GitHub Actions)

`.github/workflows/crawl.yml` runs the crawl:

- **On a schedule:** every Sunday at 02:00 UTC (`cron: '0 2 * * 0'`).
- **On demand:** via the **Run workflow** button on the Actions tab
  (`workflow_dispatch`).

The workflow installs dependencies, installs Chrome for Puppeteer, runs the
crawler, and commits the updated `docs/search-index.json` back to the repository
only if it has changed.

### Chrome / Puppeteer install (important)

The full `puppeteer` package normally downloads Chrome during `npm install` via a
postinstall script. The workflow runs `npm install --ignore-scripts` to suppress
that, then installs Chrome explicitly in a separate step. This avoids two install
paths racing to populate the same cache directory, which otherwise produces:

```
Error: All providers failed for chrome <version>:
  - DefaultProvider: The browser folder (...) exists but the executable (...) is missing
```

The explicit install step also clears `~/.cache/puppeteer` first, so a stale or
partial download can never cause the installer to abort.

> **Do not** use `PUPPETEER_SKIP_DOWNLOAD=true` to suppress the postinstall. That
> environment variable is also read by the `puppeteer browsers install` CLI, so it
> makes the explicit install step skip its download too — leaving no browser
> installed and the crawler failing with `Could not find Chrome`. Use
> `--ignore-scripts` on `npm install` instead, which only affects the install
> step, not the browser download.

## How the index is consumed

The front-end loads `search-index.json` (served from GitHub Pages) and searches it
with [Fuse.js](https://www.fusejs.io/) entirely in the browser — no server, no
database. Fields are weighted so that the most meaningful matches surface first
(title highest, then headings, then body, with link text lowest). A tight fuzzy
threshold keeps results relevant; broad thresholds tend to over-match.

## Troubleshooting

- **Action fails at "Install Puppeteer browser" with "executable is missing":**
  see the Chrome/Puppeteer section above — this is the double-install conflict the
  workflow now prevents.
- **Login fails / "Still on SSO after redirect attempt":** the SSO credentials are
  wrong/expired, or the SSO login flow or field names have changed. Check the
  `STAFF_USERNAME` / `STAFF_PASSWORD` secrets and the selectors in `login()`.
- **Far fewer pages than expected:** the crawl may have hit `MAX_PAGES`, or the
  session expired and re-auth failed. Check the run log for skipped-page warnings.
- **Index didn't update:** the commit step only pushes when the file actually
  changes; if the site content is unchanged, no commit is made.

## Roadmap

This is an interim solution. Long-term, search will be replaced by the planned
SharePoint migration, at which point this crawler and index can be retired.
