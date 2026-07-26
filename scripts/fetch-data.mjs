#!/usr/bin/env node
// ============================================================================
// World Atlas — scheduled data refresh
//
// Pulls the same real-world indicators the in-browser live loader uses
// (World Bank, IMF, WHO, Eurostat, OECD) but runs server-side on a GitHub
// Actions schedule, so CORS/rate-limit/firewall issues never affect it. The
// output, data/live-data.json, is loaded by index.html as a fast baseline
// BEFORE the browser attempts its own live fetch — so visitors always see
// data no older than the last successful run of this script, even if the
// live in-browser calls fail for them.
//
// Every fetch is independently wrapped in try/catch: a single source being
// down or changing its schema never prevents the rest of the snapshot from
// being written.
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INDEX_HTML = join(ROOT, 'index.html');
const OUT_FILE = join(ROOT, 'data', 'live-data.json');

const TIMEOUT_MS = 25000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function getJSON(url, opts) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await withTimeout(fetch(url, opts), TIMEOUT_MS);
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Runs async jobs with bounded concurrency so we don't hammer a single host
// with 40+ simultaneous requests (nor wait on them fully sequentially).
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// ── Extract the country roster straight out of index.html so this script
// never drifts out of sync with the site's own data model. ──────────────
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

function loadRoster() {
  const src = readFileSync(INDEX_HTML, 'utf8');
  const countriesSrc = extractBlock(src, 'const COUNTRIES = [', ']');
  const iso3Src = extractBlock(src, 'const ISO3 = {', '}');
  const fxSrc = extractBlock(src, 'const FX_CURRENCY = {', '}');
  const COUNTRIES = new Function(`return ${countriesSrc}`)();
  const ISO3 = new Function(`return ${iso3Src}`)();
  const FX_CURRENCY = new Function(`return ${fxSrc}`)();
  return COUNTRIES.map(c => ({ id: c.id, iso2: c.code?.toUpperCase(), iso3: ISO3[c.id], currency: FX_CURRENCY[c.id] }))
    .filter(c => c.iso2);
}

// ── World Bank: one call per indicator, all countries, last 8 years ──
// mrv=1 alone often lands on the newest YEAR even when that year is still
// null for most countries (publication lag), so we pull a window and keep
// the most recent non-null value per country instead.
async function wbIndicator(code) {
  try {
    const thisYear = new Date().getFullYear();
    const url = `https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&date=${thisYear - 8}:${thisYear}&per_page=4000`;
    const [, rows] = await getJSON(url);
    const best = {}; // iso2 -> { year, value }
    (rows || []).forEach(r => {
      if (r.value === null || r.value === undefined || !r.country?.id) return;
      const iso2 = r.country.id.toUpperCase();
      const year = +r.date;
      if (!best[iso2] || year > best[iso2].year) best[iso2] = { year, value: +r.value };
    });
    const out = {};
    Object.entries(best).forEach(([iso2, { value }]) => { out[iso2] = value; });
    return out;
  } catch (e) { console.warn(`[WB] ${code} failed:`, e.message); return {}; }
}

async function imfIndicator(code) {
  try {
    const j = await getJSON(`https://www.imf.org/external/datamapper/api/v1/${code}`);
    const series = j?.values?.[code] || {};
    const out = {};
    Object.entries(series).forEach(([iso3, years]) => {
      const entry = Object.entries(years)
        .filter(([y, v]) => v !== null && +y <= new Date().getFullYear())
        .sort(([a], [b]) => +b - +a)[0];
      if (entry) out[iso3] = +entry[1];
    });
    return out;
  } catch (e) { console.warn(`[IMF] ${code} failed:`, e.message); return {}; }
}

async function whoIndicator(code) {
  try {
    const url = `https://ghoapi.azureedge.net/api/${code}?$filter=Dim1 eq 'BTSX'&$orderby=TimeDimensionBegin desc`;
    const j = await getJSON(url);
    const out = {};
    (j.value || []).forEach(d => {
      if (d.SpatialDim && d.NumericValue != null && !(d.SpatialDim in out)) out[d.SpatialDim] = +d.NumericValue;
    });
    return out;
  } catch (e) { console.warn(`[WHO] ${code} failed:`, e.message); return {}; }
}

// ── Eurostat (JSON-stat 2.0): decode via strides over the flat `value` map ──
async function eurostatIndicator(dataset, query) {
  try {
    const j = await getJSON(`https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${dataset}?format=JSON&${query}`);
    const dims = j.id, sizes = j.size;
    const geoIdx = dims.indexOf('geo'), timeIdx = dims.indexOf('time');
    if (geoIdx < 0 || timeIdx < 0) return {};
    const strides = sizes.map((_, i) => sizes.slice(i + 1).reduce((a, b) => a * b, 1));
    const geoCats = Object.entries(j.dimension.geo.category.index);
    const timeCats = Object.entries(j.dimension.time.category.index).sort((a, b) => b[1] - a[1]);
    const out = {};
    geoCats.forEach(([geoCode, gi]) => {
      for (const [, ti] of timeCats) {
        let flat = 0;
        for (let d = 0; d < dims.length; d++) flat += (d === geoIdx ? gi : d === timeIdx ? ti : 0) * strides[d];
        const v = j.value[flat];
        if (v !== undefined && v !== null) { out[geoCode] = v; break; }
      }
    });
    return out;
  } catch (e) { console.warn(`[Eurostat] ${dataset} failed:`, e.message); return {}; }
}

// ── OECD (generic SDMX-JSON 2.0): decode observations against dimension filters ──
async function oecdIndicator(dataflow, filters) {
  try {
    const url = `https://sdmx.oecd.org/public/rest/data/${dataflow}/all?lastNObservations=1&dimensionAtObservation=AllDimensions&format=jsondata`;
    const j = await getJSON(url);
    const dims = j.data?.structures?.[0]?.dimensions?.observation;
    const obs = j.data?.dataSets?.[0]?.observations;
    if (!dims || !obs) return {};
    const refAreaIdx = dims.findIndex(d => d.id === 'REF_AREA');
    if (refAreaIdx < 0) return {};
    const out = {};
    Object.entries(obs).forEach(([key, val]) => {
      const idxs = key.split(':').map(Number);
      for (const [dimId, wantId] of Object.entries(filters)) {
        const di = dims.findIndex(d => d.id === dimId);
        if (di >= 0 && dims[di].values[idxs[di]]?.id !== wantId) return;
      }
      const area = dims[refAreaIdx].values[idxs[refAreaIdx]]?.id;
      const v = val[0];
      if (area && v !== null && v !== undefined) out[area] = v;
    });
    return out;
  } catch (e) { console.warn(`[OECD] ${dataflow} failed:`, e.message); return {}; }
}

async function main() {
  const roster = loadRoster();
  console.log(`Loaded roster: ${roster.length} countries`);

  const WB_CODES = {
    gdp: 'NY.GDP.PCAP.CD', lifeExp: 'SP.DYN.LE00.IN', internet: 'IT.NET.USER.ZS', inflation: 'FP.CPI.TOTL.ZG',
    hc_spend: 'SH.XPD.CHEX.GD.ZS', hc_docs: 'SH.MED.PHYS.ZS', hc_beds: 'SH.MED.BEDS.ZS', hc_mort: 'SP.DYN.IMRT.IN',
    tech_rnd: 'GB.XPD.RSDV.GD.ZS', tech_pat: 'IP.PAT.RESD',
    econ_unemp: 'SL.UEM.TOTL.ZS', econ_gini: 'SI.POV.GINI', econ_debt: 'DT.DOD.DECT.GN.ZS',
    econ2_gdpg: 'NY.GDP.MKTP.KD.ZG', econ2_fdi: 'BX.KLT.DINV.CD.WD', econ2_res: 'FI.RES.TOTL.CD',
    econ2_ca: 'BN.CAB.XOKA.GD.ZS', econ2_rem: 'BX.TRF.PWKR.CD.DT', econ2_sav: 'NY.GNS.ICTR.ZS',
    env_co2pc: 'EN.ATM.CO2E.PC', env_co2tot: 'EN.ATM.CO2E.KT', env_renew: 'EG.FEC.RNEW.ZS',
    env_water: 'SH.H2O.SMDW.ZS', env_sanit: 'SH.STA.SMSS.ZS', env_forest: 'AG.LND.FRST.ZS',
    demo_pop: 'SP.POP.TOTL', demo_urb: 'SP.URB.TOTL.IN.ZS', demo_fert: 'SP.DYN.TFRT.IN', demo_popg: 'SP.POP.GROW',
    edu_lit: 'SE.ADT.LITR.ZS', edu_pri: 'SE.PRM.ENRR', edu_sec: 'SE.SEC.ENRR', edu_ter: 'SE.TER.ENRR', edu_spend: 'SE.XPD.TOTL.GD.ZS',
    h2_uhc: 'SH.UHC.SRVS.CV.XD', h2_mmort: 'SH.STA.MMRT', h2_tb: 'SH.TBS.INCD', h2_hiv: 'SH.DYN.AIDS.ZS', h2_dtp: 'SH.IMM.IDPT',
    soc_pov: 'SI.POV.DDAY', soc_hom: 'VC.IHR.PSRC.P5', soc_femlbr: 'SL.TLF.CACT.FE.ZS',
    fin_mcap: 'CM.MKT.LCAP.CD', fin_bank: 'FB.CBK.BRCH.P5',
    trade_exp: 'NE.EXP.GNFS.CD', trade_imp: 'NE.IMP.GNFS.CD',
    mil_pct: 'MS.MIL.XPND.GD.ZS', gov_rol: 'GOV_WGI_RL.EST', gov_geff: 'GOV_WGI_GE.EST',
  };

  console.log('Fetching World Bank indicators...');
  const wbEntries = Object.entries(WB_CODES);
  const wbValues = await runPool(wbEntries, 8, ([, code]) => wbIndicator(code));
  const wbResults = {};
  wbEntries.forEach(([key], i) => { wbResults[key] = wbValues[i]; });

  console.log('Fetching IMF, WHO, Eurostat, OECD, forex...');
  const [imfGrowth, whoMental, eurostatUnemp, oecdGerd, fx] = await Promise.all([
    imfIndicator('NGDP_RPCH'),
    whoIndicator('MH_18'),
    eurostatIndicator('une_rt_a', 'sex=T&age=Y15-74&unit=PC_ACT&sinceTimePeriod=2022'),
    oecdIndicator('OECD.STI.STP,DSD_RDS_GERD@DF_GERD_TORD,1.0',
      { SECT_PERF: '_T', TYPE_RD: '_T', UNIT_MEASURE: 'USD_PPP', PRICE_BASE: 'V' }),
    getJSON('https://open.er-api.com/v6/latest/USD').catch(e => { console.warn('[FX] failed:', e.message); return null; }),
  ]);

  const EUROSTAT_GEO_FIX = { EL: 'GR', UK: 'GB' };
  const rates = fx?.rates || null;

  const countries = {};
  for (const { id, iso2, iso3, currency } of roster) {
    const g = key => wbResults[key]?.[iso2];
    const has = key => g(key) !== undefined;

    const entry = {};
    if (has('gdp')) entry.gdp = Math.round(g('gdp'));
    if (has('lifeExp')) entry.lifeExp = +g('lifeExp').toFixed(1);
    if (has('internet')) entry.internet = Math.round(g('internet'));
    if (has('inflation')) entry.inflation = +g('inflation').toFixed(1);

    entry.healthcare = {};
    if (has('hc_spend')) entry.healthcare.spend = +g('hc_spend').toFixed(1);
    if (has('hc_docs')) entry.healthcare.doctors = +g('hc_docs').toFixed(2);
    if (has('hc_beds')) entry.healthcare.beds = +g('hc_beds').toFixed(1);
    if (has('hc_mort')) entry.healthcare.mortality = +g('hc_mort').toFixed(1);

    entry.tech = {};
    if (has('tech_rnd')) entry.tech.rnd = +g('tech_rnd').toFixed(2);
    if (has('internet')) entry.tech.broadband = Math.round(g('internet'));
    if (has('tech_pat')) entry.tech.patents = Math.round(g('tech_pat'));
    if (oecdGerd[iso3] != null) entry.tech.rndOECD = Math.round(oecdGerd[iso3]);

    entry.econ = {};
    if (has('econ_unemp')) entry.econ.unemployment = +g('econ_unemp').toFixed(1);
    if (has('econ_gini')) entry.econ.gini = +g('econ_gini').toFixed(1);
    if (has('econ_debt')) entry.econ.debt = Math.round(g('econ_debt'));
    if (has('trade_exp') && has('trade_imp')) entry.econ.trade = Math.round((g('trade_exp') + g('trade_imp')) / 1e9);
    const eurostatGeo = Object.keys(EUROSTAT_GEO_FIX).find(k => EUROSTAT_GEO_FIX[k] === iso2) || iso2;
    if (eurostatUnemp[eurostatGeo] != null) entry.econ.unemploymentEU = +eurostatUnemp[eurostatGeo].toFixed(1);

    entry.fin = {};
    if (has('fin_mcap')) entry.fin.mcap = Math.round(g('fin_mcap') / 1e9);
    if (has('fin_bank')) entry.fin.banking = +g('fin_bank').toFixed(1);
    if (rates && currency && currency !== 'USD' && rates[currency]) {
      entry.fin.forex = +rates[currency].toFixed(currency === 'JPY' ? 0 : 2);
    }

    if (has('mil_pct')) entry.military = +g('mil_pct').toFixed(1);

    entry.extended = {
      demo: {}, edu: {}, env: {}, gov: {}, social: {}, health2: {}, econ2: {},
    };
    if (has('demo_pop')) entry.extended.demo.population = +(g('demo_pop') / 1e6).toFixed(1);
    if (has('demo_urb')) entry.extended.demo.urbanPct = Math.round(g('demo_urb'));
    if (has('demo_fert')) entry.extended.demo.fertility = +g('demo_fert').toFixed(2);
    if (has('demo_popg')) entry.extended.demo.growthRate = +g('demo_popg').toFixed(1);

    if (has('edu_lit')) entry.extended.edu.literacy = Math.round(g('edu_lit'));
    if (has('edu_pri')) entry.extended.edu.primaryEnroll = Math.min(100, Math.round(g('edu_pri')));
    if (has('edu_sec')) entry.extended.edu.secondaryEnroll = Math.min(100, Math.round(g('edu_sec')));
    if (has('edu_ter')) entry.extended.edu.tertiaryEnroll = Math.min(100, Math.round(g('edu_ter')));
    if (has('edu_spend')) entry.extended.edu.eduSpend = +g('edu_spend').toFixed(1);

    if (has('env_co2pc')) entry.extended.env.co2PerCap = +g('env_co2pc').toFixed(1);
    if (has('env_co2tot')) entry.extended.env.co2Total = +(g('env_co2tot') / 1000).toFixed(0);
    if (has('env_renew')) entry.extended.env.renewablesPct = Math.round(g('env_renew'));
    if (has('env_water')) entry.extended.env.cleanWaterPct = Math.round(g('env_water'));
    if (has('env_sanit')) entry.extended.env.sanitationPct = Math.round(g('env_sanit'));
    if (has('env_forest')) entry.extended.env.forestPct = Math.round(g('env_forest'));

    if (has('gov_rol')) entry.extended.gov.ruleOfLaw = +g('gov_rol').toFixed(2);
    if (has('gov_geff')) entry.extended.gov.govEffectiveness = +g('gov_geff').toFixed(2);

    if (has('soc_pov')) entry.extended.social.povertyRate = +g('soc_pov').toFixed(1);
    if (has('soc_hom')) entry.extended.social.homicideRate = +g('soc_hom').toFixed(1);
    if (has('soc_femlbr')) entry.extended.social.femaleLabor = Math.round(g('soc_femlbr'));

    if (has('h2_uhc')) entry.extended.health2.uhcIndex = Math.round(g('h2_uhc'));
    if (has('h2_mmort')) entry.extended.health2.maternalMort = Math.round(g('h2_mmort'));
    if (has('h2_tb')) entry.extended.health2.tbIncidence = +g('h2_tb').toFixed(1);
    if (has('h2_hiv')) entry.extended.health2.hivPrev = +g('h2_hiv').toFixed(2);
    if (has('h2_dtp')) entry.extended.health2.vaccinationDTP = Math.round(g('h2_dtp'));
    if (whoMental[iso3] != null) entry.extended.health2.mentalHealthWorkers = +whoMental[iso3].toFixed(1);

    if (has('econ2_gdpg')) entry.extended.econ2.gdpGrowth = +g('econ2_gdpg').toFixed(1);
    if (imfGrowth[iso3] != null) entry.extended.econ2.gdpGrowth = +imfGrowth[iso3].toFixed(1); // IMF is more current
    if (has('econ2_fdi')) entry.extended.econ2.fdi = +(g('econ2_fdi') / 1e9).toFixed(1);
    if (has('econ2_res')) entry.extended.econ2.foreignReserves = Math.round(g('econ2_res') / 1e9);
    if (has('econ2_ca')) entry.extended.econ2.currentAccount = +g('econ2_ca').toFixed(1);
    if (has('econ2_rem')) entry.extended.econ2.remittances = +(g('econ2_rem') / 1e9).toFixed(1);
    if (has('econ2_sav')) entry.extended.econ2.savings = Math.round(g('econ2_sav'));

    countries[id] = entry;
  }

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      sources: ['World Bank Open Data', 'IMF DataMapper', 'WHO GHO', 'Eurostat', 'OECD.Stat', 'ExchangeRate-API'],
      countryCount: Object.keys(countries).length,
    },
    countries,
  };

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`Wrote ${OUT_FILE} (${Object.keys(countries).length} countries)`);
}

main().catch(e => { console.error(e); process.exit(1); });
