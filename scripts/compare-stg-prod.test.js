const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('./compare-stg-prod');

const CHAIN_A = `0x${'a'.repeat(64)}`;
const CHAIN_B = `0x${'b'.repeat(64)}`;
const SCRIPT = path.resolve(__dirname, 'compare-stg-prod.js');

function side(nodes) {
  return { total: nodes.length, map: new Map(nodes.map(node => [node.id, node])) };
}

function mockJsonResponse(body, status = 200, overrides = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    ...overrides,
  };
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-stg-prod-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

async function withFetch(mock, fn) {
  const originalFetch = global.fetch;
  global.fetch = mock;
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

async function startGraphqlServer(entityResponses) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const query = JSON.parse(raw).query;
      let body;
      if (query.includes('_metadatas')) {
        body = { data: { _metadatas: { nodes: [] } } };
      } else if (entityResponses[req.url] instanceof Error) {
        body = { errors: [{ message: entityResponses[req.url].message }] };
      } else {
        const nodes = entityResponses[req.url] || [];
        body = {
          data: {
            pureProxies: {
              totalCount: nodes.length,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    close: () => new Promise(resolve => server.close(resolve)),
    url: pathName => `http://127.0.0.1:${server.address().port}${pathName}`,
  };
}

async function runScript(args) {
  const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, stdout, stderr };
}

test('parseArgs preserves values, accepts documented flags, and validates inputs', () => {
  const args = parseArgs([
    '--stg=https://example.test/graphql?token=a=b',
    '--entities=pureProxies',
    '--page-size=100',
    '--page-delay-ms=0',
    '--sample=0',
    '--parallel',
    '--sequential',
    '--deep',
    '--no-cache',
    '--refresh',
    '--json',
    '--no-exclude-chain',
  ]);
  assert.equal(args.stg, 'https://example.test/graphql?token=a=b');
  assert.equal(args.sequential, true);
  assert.equal(args.deep, true);
  assert.equal(args.noCache, true);
  assert.equal(args.refresh, true);
  assert.equal(args.json, true);
  assert.deepEqual(args.excludeChains, []);
  assert.throws(() => parseArgs(['--entities=']), /at least one entity/);
  assert.throws(() => parseArgs(['--entities']), /requires =value/);
  assert.throws(() => parseArgs(['--entities=unknown']), /Unknown entities/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown flag/);
  assert.throws(() => parseArgs(['--page-size=0']), /positive integer/);
  assert.throws(() => parseArgs(['--page-delay-ms=-1']), /non-negative integer/);
  assert.throws(() => parseArgs(['--sample=nope']), /non-negative integer/);
  assert.throws(() => parseArgs(['--cache-dir=']), /must not be empty/);
  assert.throws(() => parseArgs(['--stg=ftp://example.test']), /http:\/\/ or https:\/\//);
  assert.throws(() => parseArgs(['--exclude-chain=nope']), /genesis hash/);
});

test('default chain exclusion is active only while PROD is significantly behind', () => {
  const args = parseArgs(['--entities=pureProxies']);
  const metadata = height => [{ genesisHash: CHAIN_A, lastProcessedHeight: height }];
  args.excludeChains = [CHAIN_A];
  assert.deepEqual(resolveExcludeChains(args, metadata(5000), metadata(3000)), [CHAIN_A]);
  assert.deepEqual(resolveExcludeChains(args, metadata(5000), metadata(4500)), []);

  const explicit = parseArgs([`--exclude-chain=${CHAIN_A}`, '--entities=pureProxies']);
  assert.deepEqual(resolveExcludeChains(explicit, metadata(5000), metadata(5000)), [CHAIN_A]);
  assert.deepEqual(resolveExcludeChains(args, [], metadata(3000)), []);
  assert.deepEqual(resolveExcludeChains(args, metadata(5000), []), [CHAIN_A]);
});

test('chain scopes distinguish id prefixes, operation fields, and operation lookups', () => {
  const callHashId = `${CHAIN_A}-account-1-0`;
  const operation = compareEntity(
    ['id'],
    side([{ id: callHashId, chainId: CHAIN_B }]),
    side([{ id: callHashId, chainId: CHAIN_B }]),
    [CHAIN_A],
    'field',
  );
  assert.equal(operation.keptStg, 1, 'operation ids must not be parsed as chain ids');

  const proxied = compareEntity(
    ['id'],
    side([{ id: `${CHAIN_A}-proxied` }]),
    side([{ id: `${CHAIN_A}-proxied` }]),
    [CHAIN_A],
    'idPrefix',
  );
  assert.deepEqual(proxied.excluded, { stg: 1, prod: 1 });

  const event = { id: 'event', multisigId: 'operation' };
  const eventReport = compareEntity(
    ['id'],
    side([event]),
    side([event]),
    [CHAIN_A],
    'operation',
    {
      stg: new Map([['operation', CHAIN_A]]),
      prod: new Map([['operation', CHAIN_A]]),
    },
  );
  assert.deepEqual(eventReport.excluded, { stg: 1, prod: 1 });
});

test('compareEntity applies chain exclusions symmetrically and reports consistent metrics', () => {
  const report = compareEntity(
    ['id'],
    side([
      { id: 'same', chainId: CHAIN_A },
      { id: 'stg-only', chainId: CHAIN_B },
      { id: 'common', chainId: CHAIN_B },
    ]),
    side([
      { id: 'same', chainId: CHAIN_B },
      { id: 'prod-only', chainId: CHAIN_B },
      { id: 'common', chainId: CHAIN_B },
    ]),
    [CHAIN_A],
    'field',
  );
  assert.deepEqual(report.onlyStg, ['stg-only']);
  assert.deepEqual(report.onlyProd, ['same', 'prod-only']);
  assert.deepEqual(report.excluded, { stg: 1, prod: 0 });
  assert.equal(report.countStg, 3);
  assert.equal(report.countProd, 3);
  assert.equal(report.rawDelta, 0);
  assert.equal(report.keptStg, 2);
  assert.equal(report.keptProd, 3);
  assert.equal(report.delta, 1);
  assert.equal(report.common, 1);
});

test('deep comparison reports scalar differences while id-only comparison does not', () => {
  const stg = side([{ id: 'same', status: 'pending', nullable: null }]);
  const prod = side([{ id: 'same', status: 'executed', nullable: undefined }]);
  assert.deepEqual(compareEntity(['id'], stg, prod, [], 'none').differing, []);
  assert.deepEqual(compareEntity(['id', 'status', 'nullable'], stg, prod, [], 'none').differing, [{
    id: 'same',
    diff: { status: { stg: 'pending', prod: 'executed' } },
  }]);
});

test('summarizeResults separates filtered unscoped diffs and exit codes', () => {
  const entities = {
    accounts: { onlyStg: ['a'], onlyProd: [], differing: [], chainFilterApplicable: false },
    proxieds: { onlyStg: [], onlyProd: [], differing: [], chainFilterApplicable: true },
  };
  const filtered = summarizeResults(entities, true);
  assert.equal(filtered.hasDiff, false);
  assert.equal(filtered.hasUnscopedDiff, true);
  assert.deepEqual(filtered.unscoped.entities, ['accounts']);
  assert.equal(resultExitCode({}, filtered), 0);
  assert.equal(resultExitCode({ proxieds: 'failed' }, filtered), 2);

  const unfiltered = summarizeResults(entities, false);
  assert.equal(unfiltered.hasDiff, true);
  assert.deepEqual(unfiltered.unscoped.entities, []);
  assert.equal(resultExitCode({}, unfiltered), 1);
});

test('cache paths are endpoint-specific', () => {
  const a = endpointTag('https://a.example.test');
  const b = endpointTag('https://b.example.test');
  assert.notEqual(a, b);
  assert.notDeepEqual(
    cachePaths('/tmp/cache', 'stg', a, 'pureProxies', false),
    cachePaths('/tmp/cache', 'stg', b, 'pureProxies', false),
  );
});

test('readCache accepts valid partial caches and rejects every corrupt form', async () => {
  await withTempDir(async dir => {
    const { data, state } = cachePaths(dir, 'stg', 'tag', 'pureProxies', false);
    const writeState = overrides => fs.writeFileSync(state, JSON.stringify({
      cursor: 'cursor',
      total: 2,
      fieldsHash: 'id',
      done: false,
      count: 1,
      ...overrides,
    }));
    fs.writeFileSync(data, `${JSON.stringify({ id: 'one' })}\n`);
    writeState({});
    assert.equal(readCache(dir, 'stg', 'tag', 'pureProxies', false, 'id').map.size, 1);

    writeState({ count: 2 });
    assert.equal(readCache(dir, 'stg', 'tag', 'pureProxies', false, 'id'), null);

    writeState({ cursor: null });
    assert.equal(readCache(dir, 'stg', 'tag', 'pureProxies', false, 'id'), null);

    writeState({ total: 0 });
    assert.equal(readCache(dir, 'stg', 'tag', 'pureProxies', false, 'id'), null);

    writeState({ fieldsHash: 'id,chainId' });
    assert.equal(readCache(dir, 'stg', 'tag', 'pureProxies', false, 'id'), null);

    writeState({});
    fs.writeFileSync(data, '{broken}\n');
    assert.equal(readCache(dir, 'stg', 'tag', 'pureProxies', false, 'id'), null);

    fs.writeFileSync(data, `${JSON.stringify({ nope: 'id' })}\n`);
    assert.equal(readCache(dir, 'stg', 'tag', 'pureProxies', false, 'id'), null);

    fs.writeFileSync(data, `${JSON.stringify({ id: 'one' })}\n`);
    writeState({ cursor: null, total: 1, done: true });
    const completed = readCache(dir, 'stg', 'tag', 'pureProxies', false, 'id');
    assert.equal(completed.meta.done, true);
    assert.equal(completed.map, null);
  });
});

test('fetchAllEntities persists data before cursor state and deduplicates pages', async () => {
  await withTempDir(async dir => {
    const order = [];
    const originalAppend = fs.appendFileSync;
    const originalWrite = fs.writeFileSync;
    fs.appendFileSync = (...args) => {
      order.push('data');
      return originalAppend(...args);
    };
    fs.writeFileSync = (...args) => {
      if (String(args[0]).endsWith('.state.json')) order.push('state');
      return originalWrite(...args);
    };
    let page = 0;
    try {
      await withFetch(async () => {
        page++;
        return mockJsonResponse({
          data: {
            pureProxies: page === 1
              ? {
                  totalCount: 2,
                  pageInfo: { hasNextPage: true, endCursor: 'next' },
                  nodes: [{ id: 'one' }, { id: 'one' }],
                }
              : {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ id: 'two' }],
                },
          },
        });
      }, async () => {
        const fetched = await fetchAllEntities(
          'https://example.test',
          'pureProxies',
          ['id'],
          100,
          'TEST',
          { enabled: true, dir, env: 'stg', tag: 'tag', refresh: false },
          false,
          0,
        );
        assert.deepEqual([...fetched.map.keys()], ['one', 'two']);
      });
    } finally {
      fs.appendFileSync = originalAppend;
      fs.writeFileSync = originalWrite;
    }
    assert.deepEqual(order, ['data', 'state', 'data', 'state']);
  });
});

test('fetchAllEntities never reuses completed snapshots', async () => {
  await withTempDir(async dir => {
    const { data, state } = cachePaths(dir, 'stg', 'tag', 'pureProxies', false);
    fs.writeFileSync(data, `${JSON.stringify({ id: 'old' })}\n`);
    fs.writeFileSync(state, JSON.stringify({
      cursor: null,
      total: 1,
      fieldsHash: 'id',
      done: true,
      count: 1,
    }));
    let fetches = 0;
    await withFetch(async () => {
      fetches++;
      return mockJsonResponse({
        data: {
          pureProxies: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ id: 'fresh' }],
          },
        },
      });
    }, async () => {
      const fetched = await fetchAllEntities(
        'https://example.test',
        'pureProxies',
        ['id'],
        100,
        'TEST',
        { enabled: true, dir, env: 'stg', tag: 'tag', refresh: false },
        false,
        0,
      );
      assert.deepEqual([...fetched.map.keys()], ['fresh']);
    });
    assert.equal(fetches, 1);
  });
});

test('operationChainMap validates and normalizes chain ids', () => {
  assert.deepEqual(
    [...operationChainMap(side([{ id: 'operation', chainId: CHAIN_A.toUpperCase() }]).map)],
    [['operation', CHAIN_A]],
  );
  assert.throws(() => operationChainMap(side([{ id: 'operation' }]).map), /has no chainId/);
});

test('JSON CLI returns exit 0/1/2 for equality, diffs, and entity failures', async () => {
  const server = await startGraphqlServer({
    '/stg': [{ id: 'only-stg' }],
    '/prod': [],
    '/broken': new Error('entity failed'),
  });
  const common = [
    '--entities=pureProxies',
    '--page-size=100',
    '--page-delay-ms=0',
    '--no-cache',
    '--no-exclude-chain',
    '--json',
  ];
  try {
    const equal = await runScript([
      `--stg=${server.url('/prod')}`,
      `--prod=${server.url('/prod')}`,
      ...common,
    ]);
    assert.equal(equal.code, 0, equal.stderr);
    assert.equal(JSON.parse(equal.stdout).summary.hasDiff, false);

    const diff = await runScript([
      `--stg=${server.url('/stg')}`,
      `--prod=${server.url('/prod')}`,
      ...common,
    ]);
    assert.equal(diff.code, 1, diff.stderr);
    assert.equal(JSON.parse(diff.stdout).summary.hasDiff, true);

    const failure = await runScript([
      `--stg=${server.url('/stg')}`,
      `--prod=${server.url('/broken')}`,
      ...common,
    ]);
    assert.equal(failure.code, 2, failure.stderr);
    assert.match(JSON.parse(failure.stdout).failures.pureProxies, /entity failed/);
  } finally {
    await server.close();
  }
});

test('graphqlRaw attaches a request timeout signal', async () => {
  await withFetch(async (_endpoint, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return mockJsonResponse({ data: { ok: true } });
  }, async () => {
    assert.deepEqual(await graphqlRaw('https://example.test', '{ ok }'), { data: { ok: true } });
  });
});

test('graphqlRaw retries transient statuses but returns parseable validation errors', async () => {
  let transientCalls = 0;
  await withFetch(async () => {
    transientCalls++;
    return transientCalls === 1
      ? mockJsonResponse({ message: 'unavailable' }, 503)
      : mockJsonResponse({ data: { ok: true } });
  }, async () => {
    assert.deepEqual(await graphqlRaw('https://example.test', '{ ok }'), { data: { ok: true } });
  });
  assert.equal(transientCalls, 2);

  let validationCalls = 0;
  await withFetch(async () => {
    validationCalls++;
    return mockJsonResponse({ errors: [{ message: 'bad field' }] }, 400);
  }, async () => {
    assert.deepEqual(await graphqlRaw('https://example.test', '{ bad }'), { errors: [{ message: 'bad field' }] });
  });
  assert.equal(validationCalls, 1);
});

test('graphqlRaw retries an interrupted successful response body', async () => {
  let calls = 0;
  await withFetch(async () => {
    calls++;
    return mockJsonResponse({
      data: { ok: true },
    }, 200, {
      ok: true,
      json: async () => {
        if (calls === 1) throw new Error('terminated');
        return { data: { ok: true } };
      },
    });
  }, async () => {
    assert.deepEqual(await graphqlRaw('https://example.test', '{ ok }'), { data: { ok: true } });
  });
  assert.equal(calls, 2);
});

test('review structural fixes remain present', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /function perChainCounts/);
  assert.doesNotMatch(source, /probeCachePath/);
  assert.match(source, /\*   --sequential /);
  assert.match(source, /\*   --no-exclude-chain /);
  assert.doesNotMatch(source, /pureProxies \/ proxieds \/ multisigOperations ids always start with the chainId/);
});
