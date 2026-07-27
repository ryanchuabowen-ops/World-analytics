#!/usr/bin/env node
// ============================================================================
// Live Conflict Risk layer — ACLED Conflict Index (public, no login required)
//
// Source: https://acleddata.shinyapps.io/index_dash/ — ACLED's own public R
// Shiny dashboard, embedded (via iframe, behind a one-time content-consent
// click) at https://acleddata.com/platform/conflict-index-dashboard. Verified
// by loading it directly: no login gate, full country table renders
// immediately. (ACLED's CAST and Explorer tools, by contrast, DO require a
// myACLED account login and are intentionally not scraped here.)
//
// This dashboard has no stable REST/JSON endpoint — it's a live R Shiny app
// that communicates over a stateful SockJS/WebSocket session, and its
// "Download Full Data" link is session-scoped (expires with the session). So
// unlike every other fetch script in this project, this one drives a real
// headless browser (Playwright) to render the page and read the table
// straight out of the DOM, the same way any human visitor would see it.
//
// Never fatal: if ACLED changes the dashboard's markup or it's temporarily
// unreachable, this script logs a warning and leaves any existing
// data/conflict-index.json in place — the map falls back to it, and beyond
// that to the static RISK_ZONES list already in index.html.
// ============================================================================

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INDEX_HTML = join(ROOT, 'index.html');
const OUT_FILE = join(ROOT, 'data', 'conflict-index.json');
const DASHBOARD_URL = 'https://acleddata.shinyapps.io/index_dash/';

// A handful of ACLED's country names differ from this project's COUNTRIES
// roster (which mostly follows common short names). Matched by exact string
// after this normalization; unmatched entries (small territories not tracked
// by this site, e.g. "Pitcairn") are simply skipped, not an error.
const NAME_ALIASES = {
  'Democratic Republic of Congo': 'DR Congo',
  'Republic of Congo': 'Congo',
  'Bosnia and Herzegovina': 'Bosnia & Herz.',
  'Central African Republic': 'Central African Rep.',
  'Dominican Republic': 'Dominican Rep.',
  'United Arab Emirates': 'UAE',
};

function extractBlock(src, marker, closeToken) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`Could not find "${marker}" in index.html`);
  const exprStart = src.indexOf('=', start) + 1;
  let depth = 0, i = exprStart, end = -1;
  const openToken = closeToken === '}' ? '{' : '[';
  for (; i < src.length; i++) {
    if (src[i] === openToken) depth++;
    else if (src[i] === closeToken) { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error(`Could not find matching "${closeToken}" for "${marker}"`);
  return src.slice(exprStart, end);
}

function loadCountryNameMap() {
  const src = readFileSync(INDEX_HTML, 'utf8');
  const countriesSrc = extractBlock(src, 'const COUNTRIES = [', ']');
  const COUNTRIES = new Function(`return ${countriesSrc}`)();
  const map = new Map();
  COUNTRIES.forEach(c => map.set(c.name.toLowerCase(), c.id));
  return map;
}

function resolveCountryId(acledName, nameMap) {
  const aliased = NAME_ALIASES[acledName] || acledName;
  return nameMap.get(aliased.toLowerCase());
}

async function scrapeConflictIndex() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // Shiny keeps a persistent WebSocket open, so 'networkidle' never fires — wait for the
    // DOM instead, then for the reactable table to actually populate.
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('.rt-tr-group', { timeout: 30000 });
    // Let the reactable finish populating (it renders progressively as data streams in).
    await page.waitForTimeout(2000);

    const rows = await page.$$eval('.rt-tr-group', groups => groups.map(g => {
      const cells = Array.from(g.querySelectorAll('.rt-td-inner')).map(el => el.textContent.trim());
      return cells;
    }));

    // Expect [Country, Level, Total, Deadliness, Diffusion, Danger, Fragmentation] per row;
    // drop anything that doesn't match (header remnants, malformed rows).
    return rows
      .filter(r => r.length >= 7 && r[0])
      .map(r => ({
        name: r[0], level: r[1],
        total: +r[2], deadliness: +r[3], diffusion: +r[4], danger: +r[5], fragmentation: +r[6],
      }));
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log(`Scraping ${DASHBOARD_URL} ...`);
  const rows = await scrapeConflictIndex();
  console.log(`Got ${rows.length} rows from the dashboard.`);

  const nameMap = loadCountryNameMap();
  const countries = {};
  let matched = 0;
  rows.forEach(r => {
    const id = resolveCountryId(r.name, nameMap);
    if (id === undefined) return;
    matched++;
    countries[id] = {
      level: r.level,
      ranks: { total: r.total, deadliness: r.deadliness, diffusion: r.diffusion, danger: r.danger, fragmentation: r.fragmentation },
    };
  });
  console.log(`Matched ${matched}/${rows.length} rows to tracked countries.`);

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      source: 'ACLED Conflict Index (acleddata.shinyapps.io/index_dash) — public dashboard, no auth',
    },
    countries,
  };
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch(e => {
  console.error('[fetch-conflict-index] error (non-fatal — leaving any existing data/conflict-index.json in place):', e);
  process.exitCode = 0;
});
