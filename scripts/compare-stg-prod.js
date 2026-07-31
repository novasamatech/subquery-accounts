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
 *   --sequential         Query STG then PROD one after another (this is the default)
 *   --deep               Fetch all fields and compare them (default: id-only — much lighter on the backend)
 *   --exclude-chain=list Comma-separated genesis hashes to skip (default skips Westend Asset Hub only while PROD is >1000 blocks behind)
 *   --no-exclude-chain   Clear the default exclude list and compare every chain
 *   --cache-dir=<path>   Override cache dir (default: .cache/compare-stg-prod)
 *   --no-cache           Disable on-disk cache entirely
 *   --refresh            Ignore existing cache and re-fetch from scratch
 *   --json               Emit raw JSON diff to stdout, suppress human output
 *
 * Chain exclusion (--exclude-chain) only applies to entities whose chain can be
 * determined: pureProxies/proxieds (chainId is the id prefix) and multisigOperations
 * (has a chainId column — fetched even in id-only mode when an exclude list is set).
 * multisigEvents are resolved through their multisigOperation relationship.
 * It CANNOT apply to accounts/accountMultisigs (global, not chain-scoped); their
 * diffs are reported as unscoped and do not affect the verdict while exclusions
 * are active.
 *
 * Cache behavior: fetched pages are appended (synchronously, data-before-state) to
 * <cacheDir>/<env>-<urlhash>-<entity>[-deep].jsonl with a companion .state.json
 * holding the last cursor. The <urlhash> keys the cache to the endpoint URL, so
 * --stg/--prod overrides never reuse another server's cache. Only incomplete caches
 * are resumed; completed caches are re-fetched because endpoints keep changing.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_STG = 'https://subquery-accounts-stg.novasama-tech.org';
const DEFAULT_PROD = 'https://subquery-accounts-prod.novasama-tech.org';
const DEFAULT_CACHE = path.resolve(__dirname, '../.cache/compare-stg-prod');
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_EXCLUDE_LAG_THRESHOLD = 1_000;
// Westend Asset Hub — prod indexer has been stuck ~2M blocks behind staging for days,
// so ALL its (chain-scoped) rows show up as "only in STG" noise. Excluded by default.
// NOTE: this exclusion is only effective for entities whose chainId is derivable
// (pureProxies/proxieds via id prefix, multisigOperations via its chainId column).
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
  multisigOperations: [
    'id', 'status', 'chainId', 'accountId', 'section', 'method',
    'callHash', 'callData', 'depositor', 'blockCreated', 'indexCreated', 'timestamp',
  ],
  multisigEvents: [
    'id', 'accountId', 'status', 'blockCreated', 'indexCreated', 'multisigId', 'timestamp',
  ],
};

// How each entity can be filtered by chain (genesis hash) for --exclude-chain.
// Grounded in the id builders in src/utils (generateOperationId/generateEventId,
// getPureProxyId/getProxiedId) and schema.graphql:
//   'idPrefix' — id begins with the chainId (0x + 64 hex): pureProxies, proxieds
//   'field'    — entity has a chainId column, but id begins with the callHash (NOT the
//                chainId): multisigOperations. We fetch chainId even in id-only mode so
//                the exclusion works (parsing the id prefix would yield the callHash).
//   'operation' — entity points to a MultisigOperation whose chainId can be resolved:
//                 multisigEvents via multisigId.
//   'none'      — not chain-scoped, so exclusion cannot apply:
//                 accounts and accountMultisigs (global).
const CHAIN_SCOPE = {
  pureProxies: 'idPrefix',
  proxieds: 'idPrefix',
  accounts: 'none',
  accountMultisigs: 'none',
  multisigOperations: 'field',
  multisigEvents: 'operation',
};

// Short stable tag for an endpoint URL, used to key the on-disk cache so that
// --stg/--prod overrides never collide with the default servers' cache.
function endpointTag(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 8);
}

function parseArgs(argv = process.argv.slice(2)) {
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
    excludeChainsDefaulted: true,
    cacheDir: DEFAULT_CACHE,
    noCache: false,
    refresh: false,
  };
  for (const arg of argv) {
    if (arg === '--json') { args.json = true; continue; }
    if (arg === '--parallel') { args.sequential = false; continue; }
    if (arg === '--sequential') { args.sequential = true; continue; }
    if (arg === '--deep') { args.deep = true; continue; }
    if (arg === '--no-cache') { args.noCache = true; continue; }
    if (arg === '--refresh') { args.refresh = true; continue; }
    if (arg === '--no-exclude-chain') {
      args.excludeChains = [];
      args.excludeChainsDefaulted = false;
      continue;
    }
    const raw = arg.replace(/^--/, '');
    const equals = raw.indexOf('=');
    const k = equals === -1 ? raw : raw.slice(0, equals);
    const v = equals === -1 ? undefined : raw.slice(equals + 1);
    const value = () => {
      if (v === undefined) throw new Error(`${arg} requires =value`);
      return v;
    };
    if (k === 'stg') args.stg = value();
    else if (k === 'prod') args.prod = value();
    else if (k === 'entities') args.entities = value().split(',').map(s => s.trim()).filter(Boolean);
    else if (k === 'page-size') args.pageSize = Number(value());
    else if (k === 'page-delay-ms') args.pageDelayMs = Number(value());
    else if (k === 'sample') args.sample = Number(value());
    else if (k === 'cache-dir') args.cacheDir = value();
    else if (k === 'exclude-chain') {
      args.excludeChains = value().split(',').map(s => s.trim()).filter(Boolean);
      args.excludeChainsDefaulted = false;
    }
    else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  const unknown = args.entities.filter(e => !(e in ENTITIES));
  if (unknown.length) {
    throw new Error(`Unknown entities: ${unknown.join(', ')}. Known: ${Object.keys(ENTITIES).join(', ')}`);
  }
  if (!args.entities.length) throw new Error('--entities must contain at least one entity');
  if (!Number.isInteger(args.pageSize) || args.pageSize <= 0) throw new Error('--page-size must be a positive integer');
  if (!Number.isInteger(args.pageDelayMs) || args.pageDelayMs < 0) throw new Error('--page-delay-ms must be a non-negative integer');
  if (!Number.isInteger(args.sample) || args.sample < 0) throw new Error('--sample must be a non-negative integer');
  if (!args.cacheDir) throw new Error('--cache-dir must not be empty');
  for (const [name, endpoint] of [['--stg', args.stg], ['--prod', args.prod]]) {
    let parsed;
    try { parsed = new URL(endpoint); } catch (_) { throw new Error(`${name} must be a valid URL`); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} must use http:// or https://`);
  }
  const invalidChains = args.excludeChains.filter(c => !/^0x[0-9a-fA-F]{64}$/.test(c));
  if (invalidChains.length) throw new Error(`Invalid --exclude-chain genesis hash: ${invalidChains.join(', ')}`);
  return args;
}

async function graphqlRaw(endpoint, query, variables, attempt = 0) {
  let res, errMsg;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
      return retryGraphql(endpoint, query, variables, attempt, `status=${res ? res.status : 'n/a'} ${errMsg ? '(' + errMsg.slice(0, 60) + ')' : ''}`);
    }
    throw new Error(
      `GraphQL fetch failed (${endpoint}) status=${res ? res.status : 'n/a'} ${errMsg || ''} body=${bodyText.slice(0, 500)}`,
    );
  }
  try {
    return await res.json();
  } catch (err) {
    if (attempt < 15) {
      return retryGraphql(endpoint, query, variables, attempt, `response body error (${String(err).slice(0, 80)})`);
    }
    throw new Error(`GraphQL response body failed after 15 retries (${endpoint}): ${String(err)}`);
  }
}

async function retryGraphql(endpoint, query, variables, attempt, reason) {
  const base = Math.min(60000, 750 * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * 750);
  const backoff = base + jitter;
  process.stderr.write(`\n  [retry ${attempt + 1}/15] ${endpoint} ${reason} — waiting ${backoff}ms\n`);
  await new Promise(r => setTimeout(r, backoff));
  return graphqlRaw(endpoint, query, variables, attempt + 1);
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
  while (fields.length) {
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

function resolveExcludeChains(args, stgMeta, prodMeta) {
  if (!args.excludeChainsDefaulted) return args.excludeChains;
  const stgByGenesis = new Map(stgMeta.map(m => [String(m.genesisHash).toLowerCase(), m]));
  const prodByGenesis = new Map(prodMeta.map(m => [String(m.genesisHash).toLowerCase(), m]));
  return args.excludeChains.filter(chain => {
    const key = chain.toLowerCase();
    const stg = stgByGenesis.get(key);
    const prod = prodByGenesis.get(key);
    if (!stg) return false;
    if (!prod) return true;
    return Number(stg.lastProcessedHeight) - Number(prod.lastProcessedHeight) > DEFAULT_EXCLUDE_LAG_THRESHOLD;
  });
}

// Cache layout: <cacheDir>/<env>-<urlTag>-<entity>[-deep].jsonl  (one node per line)
//               <cacheDir>/<env>-<urlTag>-<entity>[-deep].state.json  { cursor, total, fieldsHash, done }
function cachePaths(cacheDir, env, urlTag, entity, deep) {
  const suffix = deep ? '-deep' : '';
  return {
    data: path.join(cacheDir, `${env}-${urlTag}-${entity}${suffix}.jsonl`),
    state: path.join(cacheDir, `${env}-${urlTag}-${entity}${suffix}.state.json`),
  };
}

function readCache(cacheDir, env, urlTag, entity, deep, expectedFieldsHash) {
  const { data, state } = cachePaths(cacheDir, env, urlTag, entity, deep);
  if (!fs.existsSync(state) || !fs.existsSync(data)) return null;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(state, 'utf8')); } catch (_) { return null; }
  if (meta.fieldsHash !== expectedFieldsHash) return null;
  if (meta.done) return { meta, map: null };
  const map = new Map();
  const text = fs.readFileSync(data, 'utf8');
  if (text.length) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      let node;
      try { node = JSON.parse(line); } catch (_) { return null; }
      if (!node || typeof node.id !== 'string') return null;
      map.set(node.id, node);
    }
  }
  if (!Number.isInteger(meta.count) || meta.count !== map.size) return null;
  if (!Number.isInteger(meta.total) || meta.total < meta.count) return null;
  if (!meta.cursor) return null;
  return { meta, map };
}

async function fetchAllEntities(endpoint, entity, fields, pageSize, label, cacheCfg, deep, pageDelayMs) {
  const selection = fields.join(' ');
  const fieldsHash = fields.join(',');
  let all = new Map();
  let after = null;
  let total = null;
  let firstPage = true;

  let dataPath = null, statePath = null;
  const cacheEnabled = !!(cacheCfg && cacheCfg.enabled);
  if (cacheEnabled) {
    fs.mkdirSync(cacheCfg.dir, { recursive: true });
    const paths = cachePaths(cacheCfg.dir, cacheCfg.env, cacheCfg.tag, entity, deep);
    dataPath = paths.data;
    statePath = paths.state;
    if (cacheCfg.refresh) {
      try { fs.unlinkSync(paths.data); } catch (_) {}
      try { fs.unlinkSync(paths.state); } catch (_) {}
    } else {
      // Resume from cache if present and the field set matches.
      const cached = readCache(cacheCfg.dir, cacheCfg.env, cacheCfg.tag, entity, deep, fieldsHash);
      if (cached && !cached.meta.done) {
        all = cached.map;
        after = cached.meta.cursor;
        total = cached.meta.total;
        firstPage = false;
        process.stderr.write(`  [${label}] ${entity}: resuming from cache at ${all.size}/${total ?? '?'}\n`);
      } else {
        // Completed caches are snapshots of live endpoints and become stale immediately.
        // Invalid/mismatched partial caches must also restart from scratch.
        try { fs.unlinkSync(paths.data); } catch (_) {}
        try { fs.unlinkSync(paths.state); } catch (_) {}
      }
    }
  }

  const writeState = (done) => {
    if (!statePath) return;
    fs.writeFileSync(statePath, JSON.stringify({ cursor: after, total, fieldsHash, done, count: all.size }));
  };

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
    let pageLines = '';
    for (const node of block.nodes) {
      if (!all.has(node.id)) {
        all.set(node.id, node);
        if (cacheEnabled) pageLines += JSON.stringify(node) + '\n';
      }
    }
    // Persist this page's rows BEFORE advancing the cursor in state, so a crash can
    // never leave state pointing past rows that were not durably written (which would
    // surface as phantom "only in PROD" diffs on the next resumed run).
    if (cacheEnabled && pageLines) fs.appendFileSync(dataPath, pageLines);
    process.stderr.write(`\r  [${label}] ${entity}: ${all.size}/${total ?? '?'}   `);
    if (!block.pageInfo.hasNextPage) { after = null; writeState(true); break; }
    after = block.pageInfo.endCursor;
    writeState(false);
    if (pageDelayMs > 0) await new Promise(r => setTimeout(r, pageDelayMs));
  }
  process.stderr.write('\n');
  return { total, map: all };
}

// pureProxies / proxieds ids start with the chainId (0x + 64 hex chars), so --exclude-chain
// works even in id-only mode. NOTE: multisigOperations / multisigEvents ids start with the
// callHash (also 0x + 64 hex), NOT the chainId — do NOT use this on them (see CHAIN_SCOPE).
function chainIdFromId(id) {
  const m = /^(0x[0-9a-fA-F]{64})(?:-|$)/.exec(id);
  return m ? m[1].toLowerCase() : null;
}

// Resolve a node's chainId according to the entity's CHAIN_SCOPE, or null when the entity
// is not chain-scoped (in which case --exclude-chain cannot apply to it).
function chainIdOf(node, scope, operationChains) {
  if (scope === 'field') return node.chainId ? String(node.chainId).toLowerCase() : null;
  if (scope === 'idPrefix') return chainIdFromId(node.id);
  if (scope === 'operation') return operationChains && operationChains.get(node.multisigId);
  return null;
}

function compareEntity(fields, stg, prod, excludeChains, scope, operationChains = {}) {
  const excluded = new Set((excludeChains || []).map(s => s.toLowerCase()));
  const chainFilterApplicable = scope !== 'none';
  const canFilter = excluded.size > 0 && chainFilterApplicable;
  const keep = (node, env) => {
    if (!canFilter) return true;
    const c = chainIdOf(node, scope, operationChains[env]);
    return !c || !excluded.has(c);
  };
  const keptStgMap = new Map([...stg.map].filter(([, node]) => keep(node, 'stg')));
  const keptProdMap = new Map([...prod.map].filter(([, node]) => keep(node, 'prod')));
  const onlyStg = [];
  const onlyProd = [];
  const differing = [];
  for (const [id, a] of keptStgMap) {
    const b = keptProdMap.get(id);
    if (!b) { onlyStg.push(id); continue; }
    const fieldDiffs = {};
    for (const f of fields) {
      if (f === 'id') continue;
      if (!eq(a[f], b[f])) fieldDiffs[f] = { stg: a[f], prod: b[f] };
    }
    if (Object.keys(fieldDiffs).length) differing.push({ id, diff: fieldDiffs });
  }
  for (const [id] of keptProdMap) {
    if (!keptStgMap.has(id)) onlyProd.push(id);
  }
  const keptStg = keptStgMap.size;
  const keptProd = keptProdMap.size;
  return {
    countStg: stg.total,
    countProd: prod.total,
    rawDelta: prod.total - stg.total,
    keptStg,
    keptProd,
    delta: keptProd - keptStg,
    onlyStg, onlyProd, differing,
    common: keptStg - onlyStg.length,
    excluded: { stg: stg.map.size - keptStg, prod: prod.map.size - keptProd },
    chainFilterApplicable,
  };
}

function operationChainMap(nodes) {
  const result = new Map();
  for (const node of nodes.values()) {
    if (typeof node.chainId !== 'string') throw new Error(`MultisigOperation ${node.id} has no chainId`);
    result.set(node.id, node.chainId.toLowerCase());
  }
  return result;
}

function summarizeResults(entities, excludeActive) {
  const summary = {
    scoped: { onlyStg: 0, onlyProd: 0, differing: 0 },
    unscoped: { onlyStg: 0, onlyProd: 0, differing: 0, entities: [] },
  };
  for (const [entity, report] of Object.entries(entities)) {
    const bucket = excludeActive && !report.chainFilterApplicable ? summary.unscoped : summary.scoped;
    bucket.onlyStg += report.onlyStg.length;
    bucket.onlyProd += report.onlyProd.length;
    bucket.differing += report.differing.length;
    if (bucket === summary.unscoped) bucket.entities.push(entity);
  }
  summary.hasDiff = summary.scoped.onlyStg + summary.scoped.onlyProd + summary.scoped.differing > 0;
  summary.hasUnscopedDiff = summary.unscoped.onlyStg + summary.unscoped.onlyProd + summary.unscoped.differing > 0;
  return summary;
}

function resultExitCode(failures, summary) {
  return Object.keys(failures).length ? 2 : (summary.hasDiff ? 1 : 0);
}

function eq(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return false;
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

function printEntityReport(entity, fields, report, sampleSize, excludeActive) {
  const sign = (n) => `${n >= 0 ? '+' : ''}${n}`;
  console.log(`Entity: ${entity}`);
  const filtered = report.excluded && (report.excluded.stg || report.excluded.prod);
  console.log(`  Count:    stg=${report.countStg} prod=${report.countProd} (raw delta=${sign(report.rawDelta)})`);
  if (filtered) {
    console.log(`  Excluded by chain filter: stg=${report.excluded.stg} prod=${report.excluded.prod}`);
    console.log(`  Kept (after filter):      stg=${report.keptStg} prod=${report.keptProd} (delta=${sign(report.delta)})`);
  }
  if (excludeActive && !report.chainFilterApplicable) {
    console.log(`  ⚠ Chain exclusion N/A for this entity (no chainId) — only-STG/PROD may include lagging-chain noise`);
  }
  console.log(`  Common:   ${report.common}`);
  console.log(`  Only STG:  ${report.onlyStg.length}${sampleIds(report.onlyStg, sampleSize)}`);
  console.log(`  Only PROD: ${report.onlyProd.length}${sampleIds(report.onlyProd, sampleSize)}`);
  console.log(`  Differing on common ids: ${report.differing.length}${sampleDiffs(report.differing, sampleSize)}`);
  // per-chain breakdown of diffs where possible (needs chainId on the fetched nodes)
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

if (require.main === module) {
  (async () => {
  const args = parseArgs();

  const [stgMeta, prodMeta] = await Promise.all([
    fetchMetadatas(args.stg),
    fetchMetadatas(args.prod),
  ]);
  args.excludeChains = resolveExcludeChains(args, stgMeta, prodMeta);
  const excludeActive = args.excludeChains.length > 0;

  if (!args.json) {
    console.log(`Comparing SubQuery entities`);
    console.log(`  STG:  ${args.stg}`);
    console.log(`  PROD: ${args.prod}`);
    console.log(`  Entities: ${args.entities.join(', ')}`);
    console.log(`  Mode: ${args.deep ? 'deep (full field comparison)' : 'id-only (light on backend)'}`);
    console.log(`  Transport: ${args.sequential ? 'sequential' : 'parallel'}, page size ${args.pageSize}, page delay ${args.pageDelayMs}ms`);
    if (args.excludeChains.length) {
      console.log(`  Excluded chains: ${args.excludeChains.map(c => c.slice(0, 10) + '…').join(', ')}`);
    } else if (args.excludeChainsDefaulted) {
      console.log(`  Excluded chains: none (default exclusion is inactive because PROD is not significantly behind)`);
    }
    console.log('');
  }

  if (!args.json) printChainStatus(stgMeta, prodMeta);

  const result = { stg: args.stg, prod: args.prod, metadatas: { stg: stgMeta, prod: prodMeta }, entities: {} };

  result.schemaDiffs = {};
  result.failures = {};
  let operationChains = null;
  for (const entity of args.entities) {
    try {
      const candidates = ENTITIES[entity];
      const scope = CHAIN_SCOPE[entity] || 'none';
      let stgFields, prodFields;
      if (!args.deep) {
        // id-only mode doesn't need a schema probe: we only query `id`, which exists on every entity.
        // Skipping the probe avoids triggering backend 502s when heavy fields like `callData` timeout.
        stgFields = ['id'];
        prodFields = ['id'];
      } else {
        process.stderr.write(`Probing schema for ${entity}...\n`);
        [stgFields, prodFields] = await Promise.all([
          probeFields(args.stg, entity, candidates),
          probeFields(args.prod, entity, candidates),
        ]);
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
      const cacheStg = { enabled: !args.noCache, dir: args.cacheDir, env: 'stg', tag: endpointTag(args.stg), refresh: args.refresh };
      const cacheProd = { enabled: !args.noCache, dir: args.cacheDir, env: 'prod', tag: endpointTag(args.prod), refresh: args.refresh };
      if (scope === 'operation' && excludeActive && !operationChains) {
        process.stderr.write(`Fetching multisigOperations chain lookup for ${entity}...\n`);
        let operationsStg, operationsProd;
        if (args.sequential) {
          operationsStg = await fetchAllEntities(args.stg, 'multisigOperations', ['id', 'chainId'], args.pageSize, 'STG', cacheStg, false, args.pageDelayMs);
          operationsProd = await fetchAllEntities(args.prod, 'multisigOperations', ['id', 'chainId'], args.pageSize, 'PROD', cacheProd, false, args.pageDelayMs);
        } else {
          [operationsStg, operationsProd] = await Promise.all([
            fetchAllEntities(args.stg, 'multisigOperations', ['id', 'chainId'], args.pageSize, 'STG', cacheStg, false, args.pageDelayMs),
            fetchAllEntities(args.prod, 'multisigOperations', ['id', 'chainId'], args.pageSize, 'PROD', cacheProd, false, args.pageDelayMs),
          ]);
        }
        operationChains = { stg: operationChainMap(operationsStg.map), prod: operationChainMap(operationsProd.map) };
      }
      // In id-only mode we ask for just the id. That alone cuts payload for multisigEvents/Operations
      // by 10–20x because we drop heavy fields like `callData` (hex blobs). For chain-scoped entities
      // whose id does NOT start with the chainId, fetch the field needed to resolve their chain.
      const fetchFields = args.deep
        ? commonFields
        : (scope === 'field' && excludeActive
          ? ['id', 'chainId']
          : (scope === 'operation' && excludeActive ? ['id', 'multisigId'] : ['id']));
      const compareFields = args.deep ? commonFields : ['id'];
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
      if (entity === 'multisigOperations' && excludeActive) {
        operationChains = { stg: operationChainMap(stg.map), prod: operationChainMap(prod.map) };
      }
      const report = compareEntity(compareFields, stg, prod, args.excludeChains, scope, operationChains || {});
      report._stgMap = stg.map;
      report._prodMap = prod.map;
      if (!args.json) printEntityReport(entity, commonFields, report, args.sample, excludeActive);
      const { _stgMap, _prodMap, ...serializable } = report;
      result.entities[entity] = { ...serializable, comparedFields: compareFields };
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

  const failedEntities = Object.keys(result.failures);
  const summary = summarizeResults(result.entities, excludeActive);
  result.summary = summary;
  const exitCode = resultExitCode(result.failures, summary);
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.exitCode = exitCode;
    return;
  }

  console.log('====================================================================');
  console.log('Summary');
  console.log(`  Scoped ids only in STG:  ${summary.scoped.onlyStg}`);
  console.log(`  Scoped ids only in PROD: ${summary.scoped.onlyProd}`);
  console.log(`  Scoped differing common ids: ${summary.scoped.differing}`);
  if (excludeActive && summary.unscoped.entities.length) {
    console.log(`  Unscoped entities (not included in verdict): ${summary.unscoped.entities.join(', ')}`);
    console.log(`    only STG=${summary.unscoped.onlyStg}, only PROD=${summary.unscoped.onlyProd}, differing=${summary.unscoped.differing}`);
  }
  if (failedEntities.length) {
    console.log(`  ⚠ Entities skipped due to errors: ${failedEntities.join(', ')}`);
  }
  console.log(summary.hasDiff ? '  ⚠ Scoped differences detected' : '  ✓ No scoped differences');
  process.exit(exitCode);
  })().catch(err => {
    console.error(err);
    process.exit(2);
  });
}

module.exports = {
  CHAIN_SCOPE,
  cachePaths,
  compareEntity,
  endpointTag,
  fetchAllEntities,
  graphqlRaw,
  operationChainMap,
  parseArgs,
  readCache,
  resolveExcludeChains,
  resultExitCode,
  summarizeResults,
};
