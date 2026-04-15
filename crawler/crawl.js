const puppeteer = require('puppeteer');
const cheerio   = require('cheerio');
const fs        = require('fs');
const path      = require('path');

// ── Configuration ──────────────────────────────────────────
const BASE_URL    = process.env.STAFF_SITE_URL || 'https://staff.port.ac.uk';
const USERNAME    = process.env.STAFF_USERNAME;
const PASSWORD    = process.env.STAFF_PASSWORD;
const OUTPUT_FILE = path.join(__dirname, '..', 'public', 'search-index.json');
const MAX_PAGES   = 2000;   // safety limit — increase if needed
const DELAY_MS    = 500;    // polite delay between page visits

// ── SSO Login (UoP NetIQ Access Manager) ───────────────────
// Navigates directly to the non-MFA 'ct-id-vault-all-users' route,
// which renders a standard username/password form via AJAX.
// The default SSO page tries Kerberos first — this bypasses that.
async function login(page) {
  console.log('Navigating to SSO login (ct-id-vault-all-users route)...');

  // Go directly to the non-MFA credential form
  const loginUrl =
    'https://sso.port.ac.uk/nidp/jsp/main.jsp' +
    '?id=ct-id-vault-all-users&sid=0&target=' +
    encodeURIComponent(BASE_URL + '/');

  await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });

  // The form is injected into #theNidpContent via AJAX after page load.
  // Wait for the username field to appear inside that container.
  console.log('Waiting for credential form to load...');
  await page.waitForSelector('#theNidpContent input[name="Ecom_User_ID"]',
    { timeout: 15000 }
  );

  // Fill in credentials
  await page.type('input[name="Ecom_User_ID"]', USERNAME);
  await page.type('input[name="Ecom_Password"]', PASSWORD);

  // Submit the form and wait for redirect back to staff.port.ac.uk
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
    page.click('input[type="submit"]'),
  ]);

  // Confirm we landed on the staff site, not back on SSO
  const currentUrl = page.url();
  if (!currentUrl.startsWith(BASE_URL)) {
    throw new Error(`Login may have failed. Expected ${BASE_URL}, got: ${currentUrl}`);
  }
  console.log('Login successful. Current URL:', currentUrl);
}

// ── Page Content Extraction ────────────────────────────────
// Extracts title and body text from a loaded page.
function extractContent(html, url) {
  const $ = cheerio.load(html);

  // Remove navigation, header, footer — keep main content only
  $('nav, header, footer, script, style, [role=navigation]').remove();

  const title = $('h1').first().text().trim()
    || $('title').text().trim()
    || url;

  // Prefer a main content area — update selector to match T4 layout
  const bodyEl = $('main, [id*=content], body').first();
  const body = bodyEl.text().replace(/\s+/g, ' ').trim().slice(0, 2000);

  return { title, body };
}

// ── Link Discovery ─────────────────────────────────────────
// Collects all internal links from a page.
function discoverLinks(html, currentUrl) {
  const $ = cheerio.load(html);
  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    try {
      const abs = new URL(href, currentUrl).href;
      if (abs.startsWith(BASE_URL)) {
        // Strip query strings and fragments
        links.add(abs.split('?')[0].split('#')[0]);
      }
    } catch { /* ignore malformed hrefs */ }
  });
  return links;
}

// ── Main Crawl ─────────────────────────────────────────────
async function crawl() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'] // required in GitHub Actions
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  await login(page);

  const visited = new Set();
  const queue   = [BASE_URL];
  const index   = [];

  while (queue.length > 0 && index.length < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      console.log(`[${index.length + 1}] Visiting: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

      // If the page redirected back to SSO, session has expired — re-login
      if (page.url().includes('sso.port.ac.uk')) {
        console.log('Session expired — re-authenticating...');
        await login(page);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      }

      await new Promise(r => setTimeout(r, DELAY_MS));

      const html = await page.content();
      const { title, body } = extractContent(html, url);

      if (title && body) {
        index.push({ url, title, body });
      }

      const links = discoverLinks(html, url);
      for (const link of links) {
        if (!visited.has(link)) queue.push(link);
      }
    } catch (err) {
      console.warn(`  Skipped (error): ${url} — ${err.message}`);
    }
  }

  await browser.close();

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(index, null, 2));
  console.log(`\nDone. ${index.length} pages indexed -> ${OUTPUT_FILE}`);
}

crawl().catch(err => { console.error(err); process.exit(1); });
