#!/usr/bin/env node
// ============================================================================
// Live per-country news — Google News RSS (public, no API key required)
//
// The "Recent News" section previously showed only hand-curated 2025 blurbs
// with no links — accurate as analytical context, but never actually "latest."
// This script fetches each country's public Google News RSS feed server-side
// (avoids CORS/rate-limit issues a browser would hit) and keeps the newest
// few real, sourced, linked headlines per country. The client (index.html)
// shows these ahead of the curated blurbs, clearly labeled "Live".
//
// Endpoint: https://news.google.com/rss/search?q=<country>&hl=en-US&gl=US&ceid=US:en
// No key, no auth — same public feed format news readers have used for years.
// Google's own relevance+recency ranking tends to surface major/breaking
// stories first, which is what keeps this "critical" without an artificial
// crisis-keyword filter that would return nothing for stable countries.
//
// Never fatal: any country that fails to fetch/parse is skipped (its curated
// blurbs + a live search link still show client-side), and if this script
// fails entirely, index.html falls back to curated news only, same as before
// this feature existed.
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INDEX_HTML = join(ROOT, 'index.html');
const OUT_FILE = join(ROOT, 'data', 'news-data.json');

const TIMEOUT_MS = 15000;
const ITEMS_PER_COUNTRY = 5;
const PACE_MS = 700;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

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

function loadCountries() {
  const src = readFileSync(INDEX_HTML, 'utf8');
  const countriesSrc = extractBlock(src, 'const COUNTRIES = [', ']');
  return new Function(`return ${countriesSrc}`)();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function formatDate(pubDate) {
  const d = new Date(pubDate);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Lightweight regex parse — the feed's structure is simple/stable enough that a
// full XML parser dependency isn't worth adding for a handful of tag types.
function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];
    if (!title || !link) continue;
    let clean = decodeEntities(title.replace(/<!\[CDATA\[|\]\]>/g, '').trim());
    const sourceClean = source ? decodeEntities(source.replace(/<!\[CDATA\[|\]\]>/g, '').trim()) : null;
    // Titles are usually "Headline - Source" with the same source repeated in
    // <source> — strip the redundant suffix so it isn't shown twice client-side.
    if (sourceClean && clean.endsWith(' - ' + sourceClean)) {
      clean = clean.slice(0, -(' - ' + sourceClean).length);
    }
    items.push({
      title: clean,
      url: link.trim(),
      date: formatDate(pubDate),
      source: sourceClean,
      _pubDate: pubDate ? new Date(pubDate).getTime() : 0,
    });
  }
  return items;
}

async function fetchCountryNews(name) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(name)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await withTimeout(fetch(url), TIMEOUT_MS);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const xml = await r.text();
  return parseRssItems(xml)
    .sort((a, b) => b._pubDate - a._pubDate)
    .slice(0, ITEMS_PER_COUNTRY)
    .map(({ _pubDate, ...rest }) => rest);
}

async function main() {
  const countries = loadCountries();
  const out = { meta: { generatedAt: new Date().toISOString(), source: 'Google News RSS (public, no API key)' }, countries: {} };
  let ok = 0, failed = 0;

  for (const c of countries) {
    try {
      const items = await fetchCountryNews(c.name);
      if (items.length) { out.countries[c.id] = items; ok++; }
    } catch (e) {
      failed++;
      console.warn(`  [news] ${c.name} failed:`, e.message);
    }
    await new Promise(res => setTimeout(res, PACE_MS));
  }

  console.log(`Fetched news for ${ok} countries (${failed} failed/empty) of ${countries.length}.`);
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch(e => {
  console.error('[fetch-news] error (non-fatal — leaving any existing data/news-data.json in place):', e);
  process.exitCode = 0;
});
