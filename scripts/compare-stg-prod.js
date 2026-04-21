#!/usr/bin/env node
/*
 * Compare all entities between staging and production SubQuery endpoints.
 *
 * Usage:
 *   node scripts/compare-stg-prod.js
 *   node scripts/compare-stg-prod.js --entities=pureProxies,proxieds
 *   node scripts/compare-stg-prod.js --sample=10 --page-size=2000
 *   node scripts/compare-stg-prod.js --json > diff.json
 *
 * Flags:
 *   --stg=<url>          Override STG endpoint
 *   --prod=<url>         Override PROD endpoint
 *   --entities=a,b,c     Limit to a subset of entities
 *   --page-size=N        Page size for pagination (default: 500)
 *   --page-delay-ms=N    Pause between pages to be gentle on the backend (default: 250)
 *   --sample=N           Sample size for each diff list printed (default: 5)
 *   --parallel           Query STG and PROD in parallel (default: sequential, gentler)
 *   --deep               Fetch all fields and compare them (default: id-only — much lighter on the backend)
 *   --exclude-chain=list Comma-separated genesis hashes to skip (default skips Westend Asset Hub whose prod indexer is stuck ~1M blocks behind)
 *   --cache-dir=<path>   Override cache dir (default: .cache/compare-stg-prod)
 *   --no-cache           Disable on-disk cache entirely
 *   --refresh            Ignore existing cache and re-fetch from scratch
 *   --json               Emit raw JSON diff to stdout, suppress human output
 *
 * Cache behavior: fetched pages are streamed to
 * <cacheDir>/<env>-<entity>[-deep].jsonl with a companion .state.json holding
 * the last cursor. A flaky endpoint / Ctrl-C can be resumed on the next run.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STG = 'https://subquery-accounts-stg.novasama-tech.org';
const DEFAULT_PROD = 'https://subquery-accounts-prod.novasama-tech.org';
const DEFAULT_CACHE = path.resolve(__dirname, '../.cache/compare-stg-prod');
// Westend Asset Hub — prod indexer has been stuck ~1M blocks behind staging for days,
// so ALL its rows show up as "only in STG" noise. Excluded by default.
const DEFAULT_EXCLUDE_CHAINS = [
  '0x67f9723393ef76214df0118c34bbbd3dbebc8ed46a10973a8c969d48fe7598c9', // Westend Asset Hub
];
const USER_AGENT = 'subquery-proxy-compare-stg-prod/1.0 (+scripts/compare-stg-prod.js)';

const ENTITIES = {
  pureProxies: [
    'id', 'accountId', 'chainId', 'spawner',
    'disambiguationIndex', 'entropyBlockNumber', 'extrinsicIndex',
  ],
  proxieds: [
    'id', 'chainId', 'type', 'proxyAccountId', 'accountId', 'delay',
    'blockNumber', 'extrinsicIndex', 'isPureProxy', 'disambiguationIndex', 'spawner',
  ],
  accounts: [
    'id', 'accountId', 'isMultisig', 'threshold',
  ],
  accountMultisigs: [
    'id', 'multisigId', 'signatoryId',
  ],
  multisigEvents: [
    'id', 'accountId', 'status', 'blockCreated', 'indexCreated', 'multisigId', 'timestamp',
  ],
  multisigOperations: [
    'id', 'status', 'chainId', 'accountId', 'section', 'method',
    'callHash', 'callData', 'depositor', 'blockCreated', 'indexCreated', 'timestamp',
  ],
};

function parseArgs() {
  const args = {
    stg: DEFAULT_STG,
    prod: DEFAULT_PROD,
    entities: Object.keys(ENTITIES),
    pageSize: 500,
    pageDelayMs: 250,
    sample: 5,
    json: false,
    sequential: true,
    deep: false,
    excludeChains: [...DEFAULT_EXCLUDE_CHAINS],
    cacheDir: DEFAULT_CACHE,
    noCache: false,
    refresh: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--json') { args.json = true; continue; }
    if (arg === '--parallel') { args.sequential = false; continue; }
    if (arg === '--sequential') { args.sequential = true; continue; }
    if (arg === '--deep') { args.deep = true; continue; }
    if (arg === '--no-cache') { args.noCache = true; continue; }
    if (arg === '--refresh') { args.refresh = true; continue; }
    if (arg === '--no-exclude-chain') { args.excludeChains = []; continue; }
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'stg') args.stg = v;
    else if (k === 'prod') args.prod = v;
    else if (k === 'entities') args.entities = v.split(',').map(s => s.trim()).filter(Boolean);
    else if (k === 'page-size') args.pageSize = Number(v);
    else if (k === 'page-delay-ms') args.pageDelayMs = Number(v);
    else if (k === 'sample') args.sample = Number(v);
    else if (k === 'cache-dir') args.cacheDir = v;
    else if (k === 'exclude-chain') args.excludeChains = v.split(',').map(s => s.trim()).filter(Boolean);
    else {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  const unknown = args.entities.filter(e => !(e in ENTITIES));
  if (unknown.length) {
    console.error(`Unknown entities: ${unknown.join(', ')}`);
    console.error(`Known: ${Object.keys(ENTITIES).join(', ')}`);
    process.exit(2);
  }
  return args;
}

async function graphqlRaw(endpoint, query, variables, attempt = 0) {
  let res, errMsg;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    errMsg = String(err);
  }
  if (errMsg || !res.ok) {
    let bodyText = '';
    if (res && !res.ok) {
      try { bodyText = await res.text(); } catch (_) {}
    }
    const transient = !res || res.status >= 500 || res.status === 429;
    // For GraphQL validation errors we often get 400 with a parseable body — return it for the caller to inspect.
    if (!transient && bodyText) {
      try { return JSON.parse(bodyText); } catch (_) {}
    }
    if (transient && attempt < 15) {
      const base = Math.min(60000, 750 * Math.pow(2, attempt));
      const jitter = Math.floor(Math.random() * 750);
      const backoff = base + jitter;
      process.stderr.write(`\n  [retry ${attempt + 1}/15] ${endpoint} status=${res ? res.status : 'n/a'} ${errMsg ? '(' + errMsg.slice(0, 60) + ')' : ''} — waiting ${backoff}ms\n`);
      await new Promise(r => setTimeout(r, backoff));
      return graphqlRaw(endpoint, query, variables, attempt + 1);
    }
    throw new Error(
      `GraphQL fetch failed (${endpoint}) status=${res ? res.status : 'n/a'} ${errMsg || ''} body=${bodyText.slice(0, 500)}`,
    );
  }
  return res.json();
}

async function graphql(endpoint, query, variables) {
  const body = await graphqlRaw(endpoint, query, variables);
  if (body.errors) {
    throw new Error(`GraphQL errors (${endpoint}): ${JSON.stringify(body.errors).slice(0, 500)}`);
  }
  return body.data;
}

// Probe which of `candidateFields` exist on `entity` at `endpoint` by sending
// a cheap `first: 0` query and stripping any fields the server rejects with
// "Cannot query field X on type Y". Returns the accepted field list (order preserved).
async function probeFields(endpoint, entity, candidateFields) {
  let fields = [...candidateFields];
  for (let i = 0; i < 8 && fields.length; i++) {
    const query = `{ ${entity}(first: 0) { nodes { ${fields.join(' ')} } } }`;
    const body = await graphqlRaw(endpoint, query);
    if (!body.errors) return fields;
    const missing = new Set();
    for (const e of body.errors) {
      const m = /Cannot query field "([^"]+)"/.exec(e.message || '');
      if (m) missing.add(m[1]);
    }
    if (!missing.size) {
      throw new Error(`Probe failed for ${entity} @ ${endpoint}: ${JSON.stringify(body.errors).slice(0, 500)}`);
    }
    fields = fields.filter(f => !missing.has(f));
  }
  return fields;
}

async function fetchMetadatas(endpoint) {
  const data = await graphql(endpoint, `{
    _metadatas { nodes { chain specName genesisHash lastProcessedHeight targetHeight indexerHealthy } }
  }`);
  return data._metadatas.nodes;
}

// Cache layout: <cacheDir>/<env>-<entity>[-deep].jsonl  (one node per line)
//               <cacheDir>/<env>-<entity>[-deep].state.json  { cursor, total, fieldsHash, done }
function cachePaths(cacheDir, env, entity, deep) {
  const suffix = deep ? '-deep' : '';
  return {
    data: path.join(cacheDir, `${env}-${entity}${suffix}.jsonl`),
    state: path.join(cacheDir, `${env}-${entity}${suffix}.state.json`),
  };
}

function readCache(cacheDir, env, entity, deep, expectedFieldsHash) {
  const { data, state } = cachePaths(cacheDir, env, entity, deep);
  if (!fs.existsSync(state) || !fs.existsSync(data)) return null;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(state, 'utf8')); } catch (_) { return null; }
  if (meta.fieldsHash !== expectedFieldsHash) return null;
  const map = new Map();
  const text = fs.readFileSync(data, 'utf8');
  if (text.length) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const node = JSON.parse(line); map.set(node.id, node); } catch (_) {}
    }
  }
  return { meta, map };
}

async function fetchAllEntities(endpoint, entity, fields, pageSize, label, cacheCfg, deep, pageDelayMs) {
  const selection = fields.join(' ');
  const fieldsHash = fields.join(',');
  let all = new Map();
  let after = null;
  let total = null;
  let firstPage = true;

  let dataStream = null, statePath = null;
  if (cacheCfg && cacheCfg.enabled) {
    fs.mkdirSync(cacheCfg.dir, { recursive: true });
    const paths = cachePaths(cacheCfg.dir, cacheCfg.env, entity, deep);
    statePath = paths.state;
    // Resume from cache if present and field set matches — unless --refresh requested.
    if (!cacheCfg.refresh) {
      const cached = readCache(cacheCfg.dir, cacheCfg.env, entity, deep, fieldsHash);
      if (cached) {
        all = cached.map;
        after = cached.meta.cursor;
        total = cached.meta.total;
        firstPage = false;
        if (cached.meta.done) {
          process.stderr.write(`  [${label}] ${entity}: ${all.size}/${total} (from cache)\n`);
          return { total, map: all };
        }
        process.stderr.write(`  [${label}] ${entity}: resuming from cache at ${all.size}/${total ?? '?'}\n`);
      }
    } else {
      try { fs.unlinkSync(paths.data); } catch (_) {}
      try { fs.unlinkSync(paths.state); } catch (_) {}
    }
    dataStream = fs.createWriteStream(paths.data, { flags: cacheCfg.refresh || !fs.existsSync(paths.data) ? 'w' : 'a' });
  }

  const writeState = (done) => {
    if (!statePath) return;
    fs.writeFileSync(statePath, JSON.stringify({ cursor: after, total, fieldsHash, done, count: all.size }));
  };

  try {
    while (true) {
      const cursorArg = after ? `, after: "${after}"` : '';
      const totalCountField = (firstPage && total == null) ? 'totalCount' : '';
      const query = `{
        ${entity}(first: ${pageSize}${cursorArg}) {
          ${totalCountField}
          pageInfo { hasNextPage endCursor }
          nodes { ${selection} }
        }
      }`;
      const data = await graphql(endpoint, query);
      const block = data[entity];
      if (firstPage && total == null) total = block.totalCount;
      firstPage = false;
      for (const node of block.nodes) {
        if (!all.has(node.id)) {
          all.set(node.id, node);
          if (dataStream) dataStream.write(JSON.stringify(node) + '\n');
        }
      }
      process.stderr.write(`\r  [${label}] ${entity}: ${all.size}/${total ?? '?'}   `);
      if (!block.pageInfo.hasNextPage) { after = null; writeState(true); break; }
      after = block.pageInfo.endCursor;
      writeState(false);
      if (pageDelayMs > 0) await new Promise(r => setTimeout(r, pageDelayMs));
    }
  } finally {
    if (dataStream) await new Promise(r => dataStream.end(r));
  }
  process.stderr.write('\n');
  return { total, map: all };
}

// pureProxies / proxieds / multisigOperations ids always start with the chainId (0x + 64 hex chars).
// This lets --exclude-chain work even when we only fetched `id`.
function chainIdFromId(id) {
  const m = /^(0x[0-9a-fA-F]{64})(?:-|$)/.exec(id);
  return m ? m[1].toLowerCase() : null;
}

function compareEntity(fields, stg, prod, excludeChains) {
  const excluded = new Set((excludeChains || []).map(s => s.toLowerCase()));
  const keep = (node) => {
    if (!excluded.size) return true;
    const c = node.chainId || chainIdFromId(node.id);
    return !c || !excluded.has(c.toLowerCase());
  };
  const onlyStg = [];
  const onlyProd = [];
  const differing = [];
  let excludedCount = 0;
  let stgTotalFiltered = 0;
  for (const [id, a] of stg.map) {
    if (!keep(a)) { excludedCount++; continue; }
    stgTotalFiltered++;
    const b = prod.map.get(id);
    if (!b) { onlyStg.push(id); continue; }
    const fieldDiffs = {};
    for (const f of fields) {
      if (f === 'id') continue;
      if (!eq(a[f], b[f])) fieldDiffs[f] = { stg: a[f], prod: b[f] };
    }
    if (Object.keys(fieldDiffs).length) differing.push({ id, diff: fieldDiffs });
  }
  let prodExcludedCount = 0;
  for (const [id, b] of prod.map) {
    if (!keep(b)) { prodExcludedCount++; continue; }
    if (!stg.map.has(id)) onlyProd.push(id);
  }
  return {
    countStg: stg.total,
    countProd: prod.total,
    delta: prod.total - stg.total,
    onlyStg, onlyProd, differing,
    common: stgTotalFiltered - onlyStg.length,
    excluded: { stg: excludedCount, prod: prodExcludedCount },
  };
}

function eq(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return false;
}

function perChainCounts(map, fields) {
  const hasChainId = fields.includes('chainId');
  if (!hasChainId) return null;
  const counts = {};
  for (const node of map.values()) {
    counts[node.chainId] = (counts[node.chainId] || 0) + 1;
  }
  return counts;
}

function printChainStatus(stgMeta, prodMeta) {
  console.log('Chain indexing status (lastProcessedHeight):');
  const byGenesis = new Map();
  for (const m of stgMeta) byGenesis.set(m.genesisHash, { stg: m });
  for (const m of prodMeta) {
    const e = byGenesis.get(m.genesisHash) || {};
    e.prod = m;
    byGenesis.set(m.genesisHash, e);
  }
  const rows = [...byGenesis.entries()].map(([gh, { stg, prod }]) => {
    const name = (stg && stg.chain) || (prod && prod.chain);
    const sh = stg ? stg.lastProcessedHeight : null;
    const ph = prod ? prod.lastProcessedHeight : null;
    const delta = (sh != null && ph != null) ? (ph - sh) : null;
    return { name, gh, sh, ph, delta, stg: !!stg, prod: !!prod };
  }).sort((a, b) => a.name.localeCompare(b.name));
  for (const r of rows) {
    const flag = !r.stg ? ' (missing on STG)' : !r.prod ? ' (missing on PROD)' : '';
    const deltaStr = r.delta == null ? '' : ` delta=${r.delta >= 0 ? '+' : ''}${r.delta}`;
    const warn = (r.delta != null && Math.abs(r.delta) > 1000) ? ' ⚠' : '';
    console.log(`  - ${r.name}: stg=${r.sh} prod=${r.ph}${deltaStr}${warn}${flag}`);
  }
  console.log('');
}

function printEntityReport(entity, fields, report, sampleSize) {
  console.log(`Entity: ${entity}`);
  console.log(`  Count:    stg=${report.countStg} prod=${report.countProd} (delta=${report.delta >= 0 ? '+' : ''}${report.delta})`);
  if (report.excluded && (report.excluded.stg || report.excluded.prod)) {
    console.log(`  Excluded by chain filter: stg=${report.excluded.stg} prod=${report.excluded.prod}`);
  }
  console.log(`  Common:   ${report.common}`);
  console.log(`  Only STG:  ${report.onlyStg.length}${sampleIds(report.onlyStg, sampleSize)}`);
  console.log(`  Only PROD: ${report.onlyProd.length}${sampleIds(report.onlyProd, sampleSize)}`);
  console.log(`  Differing on common ids: ${report.differing.length}${sampleDiffs(report.differing, sampleSize)}`);
  // per-chain breakdown of diffs where possible (deep mode only — id-only mode has no chainId on nodes)
  const hasChainId = fields.includes('chainId') && [...(report._stgMap.values())].some(n => n.chainId);
  if (hasChainId) {
    const chains = {};
    const bump = (bucket, id, map) => {
      const node = map.get(id);
      if (!node) return;
      chains[node.chainId] = chains[node.chainId] || { onlyStg: 0, onlyProd: 0, diff: 0 };
      chains[node.chainId][bucket]++;
    };
    for (const id of report.onlyStg) bump('onlyStg', id, report._stgMap);
    for (const id of report.onlyProd) bump('onlyProd', id, report._prodMap);
    for (const d of report.differing) bump('diff', d.id, report._stgMap);
    const keys = Object.keys(chains).sort();
    if (keys.length) {
      console.log('  By chainId:');
      for (const c of keys) {
        const v = chains[c];
        console.log(`    ${c.slice(0, 10)}...: onlyStg=${v.onlyStg} onlyProd=${v.onlyProd} diff=${v.diff}`);
      }
    }
  }
  console.log('');
}

function sampleIds(ids, n) {
  if (!ids.length) return '';
  const sample = ids.slice(0, n).map(truncId).join(', ');
  const more = ids.length > n ? `, ... (+${ids.length - n} more)` : '';
  return ` — sample: [${sample}${more}]`;
}

function sampleDiffs(diffs, n) {
  if (!diffs.length) return '';
  const parts = [];
  for (const d of diffs.slice(0, n)) {
    const fields = Object.entries(d.diff)
      .map(([f, v]) => `${f}: stg=${JSON.stringify(v.stg)} prod=${JSON.stringify(v.prod)}`)
      .join('; ');
    parts.push(`    ${truncId(d.id)} — ${fields}`);
  }
  if (diffs.length > n) parts.push(`    ... (+${diffs.length - n} more)`);
  return '\n' + parts.join('\n');
}

function truncId(id) {
  return id.length > 70 ? id.slice(0, 33) + '…' + id.slice(-33) : id;
}

(async () => {
  const args = parseArgs();

  if (!args.json) {
    console.log(`Comparing SubQuery entities`);
    console.log(`  STG:  ${args.stg}`);
    console.log(`  PROD: ${args.prod}`);
    console.log(`  Entities: ${args.entities.join(', ')}`);
    console.log(`  Mode: ${args.deep ? 'deep (full field comparison)' : 'id-only (light on backend)'}`);
    console.log(`  Transport: ${args.sequential ? 'sequential' : 'parallel'}, page size ${args.pageSize}, page delay ${args.pageDelayMs}ms`);
    if (args.excludeChains.length) {
      console.log(`  Excluded chains: ${args.excludeChains.map(c => c.slice(0, 10) + '…').join(', ')}`);
    }
    console.log('');
  }

  const [stgMeta, prodMeta] = await Promise.all([
    fetchMetadatas(args.stg),
    fetchMetadatas(args.prod),
  ]);
  if (!args.json) printChainStatus(stgMeta, prodMeta);

  const result = { stg: args.stg, prod: args.prod, metadatas: { stg: stgMeta, prod: prodMeta }, entities: {} };

  result.schemaDiffs = {};
  result.failures = {};
  for (const entity of args.entities) {
    try {
      const candidates = ENTITIES[entity];
      let stgFields, prodFields;
      if (!args.deep) {
        // id-only mode doesn't need a schema probe: we only query `id`, which exists on every entity.
        // Skipping the probe avoids triggering backend 502s when heavy fields like `callData` timeout.
        stgFields = ['id'];
        prodFields = ['id'];
      } else {
        process.stderr.write(`Probing schema for ${entity}...\n`);
        const probeCachePath = path.join(args.cacheDir, `probe-${entity}.json`);
        if (!args.noCache && !args.refresh && fs.existsSync(probeCachePath)) {
          try {
            const cached = JSON.parse(fs.readFileSync(probeCachePath, 'utf8'));
            if (Array.isArray(cached.stg) && Array.isArray(cached.prod)) {
              stgFields = cached.stg; prodFields = cached.prod;
              process.stderr.write(`  (probe cached)\n`);
            }
          } catch (_) {}
        }
        if (!stgFields || !prodFields) {
          [stgFields, prodFields] = await Promise.all([
            probeFields(args.stg, entity, candidates),
            probeFields(args.prod, entity, candidates),
          ]);
          if (!args.noCache) {
            fs.mkdirSync(args.cacheDir, { recursive: true });
            fs.writeFileSync(probeCachePath, JSON.stringify({ stg: stgFields, prod: prodFields }));
          }
        }
      }
      const commonFields = candidates.filter(f => stgFields.includes(f) && prodFields.includes(f));
      const onlyStgFields = stgFields.filter(f => !prodFields.includes(f));
      const onlyProdFields = prodFields.filter(f => !stgFields.includes(f));
      result.schemaDiffs[entity] = { stgFields, prodFields, commonFields, onlyStgFields, onlyProdFields };
      if (!args.json && (onlyStgFields.length || onlyProdFields.length)) {
        console.log(`Schema diff on ${entity}:`);
        if (onlyStgFields.length) console.log(`  Only on STG: ${onlyStgFields.join(', ')}`);
        if (onlyProdFields.length) console.log(`  Only on PROD: ${onlyProdFields.join(', ')}`);
        console.log('');
      }
      if (!commonFields.includes('id')) {
        throw new Error(`Entity ${entity} has no shared 'id' field between STG and PROD — cannot compare.`);
      }

      process.stderr.write(`Fetching ${entity}${args.deep ? ' (deep)' : ' (id-only)'}...\n`);
      const cacheStg = { enabled: !args.noCache, dir: args.cacheDir, env: 'stg', refresh: args.refresh };
      const cacheProd = { enabled: !args.noCache, dir: args.cacheDir, env: 'prod', refresh: args.refresh };
      // In id-only mode we ask for just the id. That alone cuts payload for multisigEvents/Operations
      // by 10–20x because we drop heavy fields like `callData` (hex blobs).
      const fetchFields = args.deep ? commonFields : ['id'];
      let stg, prod;
      if (args.sequential) {
        stg = await fetchAllEntities(args.stg, entity, fetchFields, args.pageSize, 'STG', cacheStg, args.deep, args.pageDelayMs);
        prod = await fetchAllEntities(args.prod, entity, fetchFields, args.pageSize, 'PROD', cacheProd, args.deep, args.pageDelayMs);
      } else {
        [stg, prod] = await Promise.all([
          fetchAllEntities(args.stg, entity, fetchFields, args.pageSize, 'STG', cacheStg, args.deep, args.pageDelayMs),
          fetchAllEntities(args.prod, entity, fetchFields, args.pageSize, 'PROD', cacheProd, args.deep, args.pageDelayMs),
        ]);
      }
      const report = compareEntity(args.deep ? commonFields : ['id'], stg, prod, args.excludeChains);
      report._stgMap = stg.map;
      report._prodMap = prod.map;
      if (!args.json) printEntityReport(entity, commonFields, report, args.sample);
      const { _stgMap, _prodMap, ...serializable } = report;
      result.entities[entity] = { ...serializable, comparedFields: commonFields };
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      result.failures[entity] = msg;
      if (!args.json) {
        console.log(`Entity: ${entity}`);
        console.log(`  ⚠ Skipped due to error: ${msg.slice(0, 300)}`);
        console.log('');
      } else {
        process.stderr.write(`Skipped ${entity}: ${msg.slice(0, 300)}\n`);
      }
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2));
    return;
  }

  const totalOnlyStg = Object.values(result.entities).reduce((s, r) => s + r.onlyStg.length, 0);
  const totalOnlyProd = Object.values(result.entities).reduce((s, r) => s + r.onlyProd.length, 0);
  const totalDiffering = Object.values(result.entities).reduce((s, r) => s + r.differing.length, 0);
  const failedEntities = Object.keys(result.failures);
  console.log('====================================================================');
  console.log('Summary');
  console.log(`  Total ids only in STG:  ${totalOnlyStg}`);
  console.log(`  Total ids only in PROD: ${totalOnlyProd}`);
  console.log(`  Total differing common ids: ${totalDiffering}`);
  if (failedEntities.length) {
    console.log(`  ⚠ Entities skipped due to errors: ${failedEntities.join(', ')}`);
  }
  const hasDiff = totalOnlyStg + totalOnlyProd + totalDiffering > 0;
  console.log(hasDiff ? '  ⚠ Differences detected' : '  ✓ No differences');
  process.exit(failedEntities.length ? 2 : (hasDiff ? 1 : 0));
})().catch(err => {
  console.error(err);
  process.exit(2);
});
