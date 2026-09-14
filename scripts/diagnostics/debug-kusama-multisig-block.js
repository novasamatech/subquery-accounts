#!/usr/bin/env node

const { ApiPromise, WsProvider } = require("@polkadot/api");
const { u8aToHex } = require("@polkadot/util");

function parseArg(argv, key, fallback) {
  const prefixed = `${key}=`;
  const raw = argv.find(a => a.startsWith(prefixed));
  if (!raw) return fallback;
  return raw.slice(prefixed.length);
}

function toHexString(value) {
  if (!value) return;
  if (value instanceof Uint8Array) return u8aToHex(value);
  if (typeof value === "string" && value.startsWith("0x")) return value;
  if (typeof value.toHex === "function") return value.toHex();
}

function isValidCallHash(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function getArgByName(call, names) {
  if (!call?.meta?.args || !call?.args) return;
  for (const name of names) {
    const idx = call.meta.args.findIndex(arg => arg.name.toString() === name);
    if (idx >= 0) return call.args[idx];
  }
}

function getEventField(event, field, fallbackIndex) {
  const names = event.data.names || [];
  const idx = names.indexOf(field);
  if (idx >= 0) return event.data[idx];
  if (fallbackIndex === undefined) return;
  return event.data[fallbackIndex];
}

function getCallHashFromEvent(event, fallbackIndex) {
  const fromEvent = getEventField(event, "callHash", fallbackIndex) ?? getEventField(event, "call_hash", fallbackIndex);
  const hex = toHexString(fromEvent);
  if (isValidCallHash(hex)) return hex;
}

function getCallHashFromExtrinsic(call) {
  const namedHash = getArgByName(call, ["callHash", "call_hash"]);
  const namedHashHex = toHexString(namedHash);
  if (isValidCallHash(namedHashHex)) return namedHashHex;

  const innerCall = getArgByName(call, ["call"]);
  const innerCallHex = toHexString(innerCall?.hash);
  if (isValidCallHash(innerCallHex)) return innerCallHex;

  const callByIndex = call.args?.[3];
  const byIndexHex = toHexString(callByIndex?.hash);
  if (isValidCallHash(byIndexHex)) return byIndexHex;
}

function eventCallHashIndex(method) {
  if (method === "NewMultisig") return 2;
  if (method === "MultisigApproval" || method === "MultisigApproved") return 3;
  if (method === "MultisigExecuted") return 3;
  if (method === "MultisigCancelled" || method === "MultisigCanceled") return 3;
}

async function main() {
  const endpoint = parseArg(process.argv.slice(2), "--endpoint", "wss://kusama-rpc.polkadot.io");
  const blockNumber = Number.parseInt(parseArg(process.argv.slice(2), "--block", "2016479"), 10);

  if (!Number.isInteger(blockNumber) || blockNumber <= 0) {
    throw new Error(`Invalid --block value: ${blockNumber}`);
  }

  const api = await ApiPromise.create({
    provider: new WsProvider(endpoint),
    noInitWarn: true,
  });

  try {
    const hash = await api.rpc.chain.getBlockHash(blockNumber);
    const runtimeVersion = await api.rpc.state.getRuntimeVersion(hash);
    const at = await api.at(hash);
    const events = await at.query.system.events();
    const signedBlock = await api.rpc.chain.getBlock(hash);

    console.log(`Endpoint: ${endpoint}`);
    console.log(`Block: ${blockNumber}`);
    console.log(`Hash: ${hash.toHex()}`);
    console.log(`Spec version: ${runtimeVersion.specVersion.toString()}`);
    console.log(`Events in block: ${events.length}`);
    console.log(`Extrinsics in block: ${signedBlock.block.extrinsics.length}`);

    for (const { event, phase } of events) {
      const isMultisigEvent =
        (event.section === "utility" || event.section === "multisig") && (event.method.includes("Multisig") || event.method === "NewMultisig");

      if (!isMultisigEvent) continue;

      console.log("\n----------------------------------------");
      console.log(`${event.section}.${event.method}`);
      console.log(`phase: ${phase.toString()}`);
      console.log(`data.length: ${event.data.length}`);
      event.data.forEach((d, i) => {
        const t = event.typeDef?.[i]?.type || "?";
        console.log(`[${i}] ${t}: ${d.toString()}`);
      });

      const fallbackIndex = eventCallHashIndex(event.method);
      const fromEvent = getCallHashFromEvent(event, fallbackIndex);
      console.log(`callHash from event: ${fromEvent || "<missing>"}`);

      if (!phase.isApplyExtrinsic) {
        console.log("extrinsic: <none for this phase>");
        continue;
      }

      const extrinsicIndex = phase.asApplyExtrinsic.toNumber();
      const extrinsic = signedBlock.block.extrinsics[extrinsicIndex];
      if (!extrinsic) {
        console.log(`extrinsic: <missing at index ${extrinsicIndex}>`);
        continue;
      }

      console.log(`extrinsic index: ${extrinsicIndex}`);
      console.log(`extrinsic call: ${extrinsic.method.section}.${extrinsic.method.method}`);
      extrinsic.method.meta.args.forEach((arg, idx) => {
        const value = extrinsic.method.args[idx];
        console.log(`arg[${idx}] ${arg.name.toString()} (${arg.type.toString()}): ${value.toString()}`);
      });

      const fromExtrinsic = getCallHashFromExtrinsic(extrinsic.method);
      console.log(`callHash from extrinsic fallback: ${fromExtrinsic || "<missing>"}`);
    }
  } finally {
    await api.disconnect();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
