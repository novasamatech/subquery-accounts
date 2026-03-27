// Polyfill TextEncoder/TextDecoder for SubQuery sandbox (required by @noble/hashes >= 1.8)
if (typeof globalThis.TextEncoder === "undefined") {
  const util = require("util");
  globalThis.TextEncoder = util.TextEncoder;
  globalThis.TextDecoder = util.TextDecoder;
}

//Exports all handler functions
export * from "./mappings/mappingHandlers";
import "@polkadot/api-augment";
