// Bounded JSON-RPC over HTTP(S). Endpoints may contain credentials: callers must not log them.
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Create an HTTP JSON-RPC client with a bounded timeout for each request.
 * @param {string} endpoint HTTP(S) URL; callers must redact any credentials from errors.
 * @returns {(method: string, params?: unknown[]) => Promise<unknown>} The JSON-RPC result.
 * @throws {Error} For a non-HTTP endpoint; requests reject on timeout, HTTP or RPC errors.
 */
function createRpc(endpoint) {
  if (!/^https?:\/\//.test(endpoint)) throw new Error("Use an HTTP(S) RPC endpoint");
  let id = 0;
  return async function rpc(method, params = []) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const result = await response.json();
    if (result.error) throw new Error(`${method}: ${result.error.message}`);
    return result.result;
  };
}

/**
 * Fetch metadata v16 when available, falling back to the runtime's default metadata.
 * @param {Function} rpc JSON-RPC client returned by createRpc.
 * @param {string} hash Runtime context block hash; use the parent hash for block decoding.
 * @param {{TypeRegistry: Function}} deps The selected decoder's registry constructor.
 * @returns {Promise<string>} SCALE metadata as hex.
 * @throws {Error} For RPC failures other than an unavailable versioned metadata API.
 */
async function fetchMetadata(rpc, hash, deps) {
  try {
    const bytes = await rpc("state_call", ["Metadata_metadata_at_version", "0x10000000", hash]);
    const registry = new deps.TypeRegistry();
    const opaque = registry.createType("Option<OpaqueMetadata>", registry.createType("Raw", bytes).toU8a());
    if (opaque.isSome) return opaque.unwrap().toHex();
  } catch (error) {
    if (!/not found|not exported|not available|not supported|does not exist/i.test(error.message)) throw error;
  }
  return rpc("state_getMetadata", [hash]);
}

module.exports = { createRpc, fetchMetadata, REQUEST_TIMEOUT_MS };
