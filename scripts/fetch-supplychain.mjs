#!/usr/bin/env node
// ============================================================================
// Supply Chain Intelligence — UN Comtrade refresh (free, no API key)
//
// Uses the public "preview" tier at comtradeapi.un.org, which requires no
// registration or key. Verified behavior of this tier:
//   - Single-year `period` only — comma-separated multi-year requests 400.
//   - Omitting `partnerCode` on a reporter+commodity+flow query returns one
//     row per trading partner (confirmed: reporterCode=156&cmdCode=2606&
//     flowCode=X, no partnerCode, returned 19 real destination-country rows).
// That single call gives us BOTH:
//   - a real total export value per producer → re-ranks "top sellers"
//   - a real per-destination breakdown → aggregated across producers into
//     "top buyers" for that stage
//
// Because this tier is rate-limited and single-year-only, this script:
//   - paces requests (~1/sec) and retries once on failure/429
//   - fetches only the latest available year (falls back one year if the
//     newest year comes back empty — annual trade stats usually lag)
//   - APPENDS that year's totals to a small rolling history file so trend
//     charts (Phase 4) build up real multi-year history over successive
//     scheduled runs, instead of needing a multi-year API call that doesn't
//     exist on this free tier
//
// Never fatal: if Comtrade is unreachable or a query fails, the site falls
// back to the curated production-share estimates already in MINERALS.
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INDEX_HTML = join(ROOT, 'index.html');
const OUT_FILE = join(ROOT, 'data', 'supply-chain-data.json');

const TIMEOUT_MS = 20000;

// UN Comtrade uses a handful of legacy reporter/partner codes that differ from the modern
// ISO-3166-1 numeric codes this project's COUNTRIES roster uses (a long-standing quirk of
// Comtrade's own coding history). Normalize the ones significant enough to matter here —
// otherwise these countries' real trade values silently vanish from the buyer/seller tables.
const COMTRADE_ID_ALIAS = { 842: 840, 251: 250, 579: 578, 757: 756, 699: 356, 490: 158 };
function normalizeId(id) { return COMTRADE_ID_ALIAS[id] || id; }
const CANDIDATE_YEARS = [new Date().getFullYear() - 1, new Date().getFullYear() - 2, new Date().getFullYear() - 3];

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function getJSON(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await withTimeout(fetch(url), TIMEOUT_MS);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 1500)); }
  }
  throw lastErr;
}

// Sequential with a fixed pace — this free tier is rate-limited (observed 429s on bursts).
async function paced(items, worker) {
  const out = [];
  for (const item of items) {
    out.push(await worker(item));
    await new Promise(res => setTimeout(res, 1100));
  }
  return out;
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

function loadMinerals() {
  const src = readFileSync(INDEX_HTML, 'utf8');
  const mineralsSrc = extractBlock(src, 'const MINERALS = [', ']');
  return new Function(`return ${mineralsSrc}`)();
}

// Exports of `hsCode` from `reporterId`, broken down by destination partner, for one year.
// Country ids in this project are already ISO-3166-1 numeric / UN M49 codes, which is what
// Comtrade expects for reporterCode/partnerCode — no translation needed.
async function fetchExportBreakdown(reporterId, hsCode, year) {
  const url = `https://comtradeapi.un.org/public/v1/preview/C/A/HS` +
    `?reporterCode=${reporterId}&period=${year}&cmdCode=${hsCode}&flowCode=X`;
  const j = await getJSON(url);
  return j?.data || [];
}

async function fetchLatestAvailable(reporterId, hsCode) {
  for (const year of CANDIDATE_YEARS) {
    const rows = await fetchExportBreakdown(reporterId, hsCode, year);
    if (rows.length) return { year, rows };
  }
  return { year: null, rows: [] };
}

function loadHistory() {
  const p = join(ROOT, 'data', 'supply-chain-history.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

async function main() {
  const minerals = loadMinerals();
  const history = loadHistory(); // { [mineralId]: { [stageId]: { [year]: totalExportValue } } }
  const out = { meta: { generatedAt: new Date().toISOString(), source: 'UN Comtrade (public preview tier)' }, minerals: {} };

  for (const m of minerals) {
    if (!m.stages) continue;
    out.minerals[m.id] = { stages: {} };
    if (!history[m.id]) history[m.id] = {};

    for (const stage of m.stages) {
      console.log(`Fetching ${m.id} / ${stage.id} (HS ${stage.hs}) for ${m.producers.length} producer(s)...`);
      const results = await paced(m.producers, async p => {
        try { return { reporterId: p.id, ...(await fetchLatestAvailable(p.id, stage.hs)) }; }
        catch (e) { console.warn(`  [Comtrade] ${m.id}/${stage.id} reporter=${p.id} failed:`, e.message); return { reporterId: p.id, year: null, rows: [] }; }
      });

      const sellers = [];
      const buyerTotals = {}; // stage-wide aggregate, across all producers
      let stageYear = null;
      results.forEach(({ reporterId, year, rows }) => {
        if (!rows.length) return;
        stageYear = stageYear || year;
        let total = 0;
        const perSellerBuyers = {}; // this specific reporter's own destination breakdown
        rows.forEach(r => {
          const v = r.primaryValue ?? r.fobvalue ?? 0;
          total += v;
          if (r.partnerCode && r.partnerCode !== 0) {
            const pid = normalizeId(r.partnerCode);
            buyerTotals[pid] = (buyerTotals[pid] || 0) + v;
            perSellerBuyers[pid] = (perSellerBuyers[pid] || 0) + v;
          }
        });
        if (total > 0) {
          const topBuyers = Object.entries(perSellerBuyers)
            .map(([countryId, value]) => ({ countryId: +countryId, importValue: Math.round(value) }))
            .sort((a, b) => b.importValue - a.importValue)
            .slice(0, 8);
          sellers.push({ countryId: reporterId, exportValue: Math.round(total), topBuyers });
        }
      });
      sellers.sort((a, b) => b.exportValue - a.exportValue);
      const buyers = Object.entries(buyerTotals)
        .map(([countryId, value]) => ({ countryId: +countryId, importValue: Math.round(value) }))
        .sort((a, b) => b.importValue - a.importValue)
        .slice(0, 15);

      out.minerals[m.id].stages[stage.id] = { year: stageYear, sellers, buyers };

      // Append this run's total (summed across producers) to the rolling history,
      // so repeated scheduled runs build up a real multi-year series over time.
      if (stageYear && sellers.length) {
        if (!history[m.id][stage.id]) history[m.id][stage.id] = {};
        history[m.id][stage.id][stageYear] = sellers.reduce((s, x) => s + x.exportValue, 0);
      }
    }
  }

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(out));
  writeFileSync(join(ROOT, 'data', 'supply-chain-history.json'), JSON.stringify(history));
  console.log(`Wrote ${OUT_FILE} and supply-chain-history.json`);
}

main().catch(e => {
  console.error('[fetch-supplychain] error (non-fatal — leaving any existing data files in place):', e);
  process.exitCode = 0;
});
