const assert = require("node:assert/strict");
const { test } = require("node:test");
const { load: parse } = require("js-yaml");
const { prepareBlockSpec } = require("../lib/block-spec");

const spec = `network:
  endpoint: >-
    wss://public.example
  chainId: '0x1234'
dataSources:
  - kind: substrate/Runtime
    startBlock: 100
    mapping:
      file: ./dist/index.js
  - kind: substrate/Runtime
    startBlock: 200
`;

test("replay changes every data source start without changing mapping paths", () => {
  const result = parse(prepareBlockSpec(spec, "20494727"));
  assert.deepEqual(result.dataSources.map(source => source.startBlock), [20494727, 20494727]);
  assert.equal(result.network.endpoint, "wss://public.example");
  assert.equal(result.dataSources[0].mapping.file, "./dist/index.js");
});

test("endpoint override replaces folded scalars and endpoint lists as YAML values", () => {
  for (const input of [spec, spec.replace(">-\n    wss://public.example", "[wss://one.example, wss://two.example]")]) {
    const result = parse(prepareBlockSpec(input, 10, "wss://rpc.example/key:with#punctuation"));
    assert.equal(result.network.endpoint, "wss://rpc.example/key:with#punctuation");
    assert.equal(result.network.chainId, "0x1234");
  }
});

test("invalid replay inputs fail without emitting source YAML", () => {
  for (const block of ["-1", "1.2", "NaN", "9007199254740992", ""]) {
    assert.throws(() => prepareBlockSpec(spec, block), /start-block/);
  }
  assert.throws(() => prepareBlockSpec("network: [", 1), /^Error: Invalid project YAML$/);
  assert.throws(() => prepareBlockSpec("dataSources: []", 1), /data source/);
  assert.throws(() => prepareBlockSpec("dataSources: [{}]", 1, "wss://rpc.example"), /network/);
});
