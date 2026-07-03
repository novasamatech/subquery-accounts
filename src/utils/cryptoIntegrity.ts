import { createKeyMultiAccountId } from "./addressesDecode";

// Real 4-of-7 multisig from Polkadot Asset Hub block 6706950, extrinsic 2.
// The NewMultisig event is the on-chain ground truth for the derived account id:
// https://assethub-polkadot.subscan.io/extrinsic/6706950-2
//
// v2.5.0 derived 0x485f6f80…d373 from these exact inputs when running inside the
// SubQuery sandbox (host-realm Uint8Array corruption inside util-crypto, see
// MULTISIG_PREFIX in addressesDecode.ts) and silently indexed wrong multisig
// accounts for months. This canary turns that failure mode into a hard crash on
// the first derivation instead.
const CANARY_SIGNATORIES = [
  "0x0c691601793de060491dab143dfae19f5f6413d4ce4c363637e5ceacb2836a4e",
  "0x18bd4fb6b90f5088bdc825c3d674bd72e705c6f1163e86f960eeb7969ab4833a",
  "0x2055808c210d863dfc372ec85beafa8fd3a8ff497f8eaee401ef05bf27d3065b",
  "0x42be75cb933073a967d8cb8c6c723028208a678c5a58f5e8f49a237eb33e1654",
  "0x7cbcc6a855945d221338c68bec20f892c73ccb4fc9be838d8e525c225129a00a",
  "0xe424b2ee4c8a8fb3334248367a7a7e5c2d236205368cd4aee4e8ae274fc45566",
  "0xe43550c34b73d305a049fb155219ea2cc3dd7b3fe71f93658d7554ccd33db210",
];
const CANARY_THRESHOLD = 4;
const CANARY_EXPECTED = "0x4e289015f60c88b9b1d1b58ba4110ed1e3e745b82101db274e1afba4b19eed63";

let verified = false;

/**
 * Verify that address derivation produces a known-correct result in the current
 * runtime before any derived account id is written to the store.
 *
 * The @polkadot byte/hash pipeline has repeatedly broken inside the SubQuery
 * sandbox in environment-specific ways (#88, #90, #92) while staying perfectly
 * healthy on the host — unit tests pass, the indexer keeps processing blocks,
 * and garbage account ids land in the database unnoticed. Every handler that
 * derives an account id must call this before saving; the check runs once per
 * process and is a no-op afterwards.
 *
 * @throws Error if the derivation pipeline returns a wrong result
 */
export function assertCryptoIntegrity(): void {
  if (verified) return;

  const actual = createKeyMultiAccountId(CANARY_SIGNATORIES, CANARY_THRESHOLD);
  if (actual !== CANARY_EXPECTED) {
    throw new Error(
      `Crypto integrity check failed: multisig derivation returned ${actual}, expected ${CANARY_EXPECTED}. ` +
        "The @polkadot byte/hash pipeline is corrupted in this runtime (sandbox realm issue — " +
        "see MULTISIG_PREFIX in addressesDecode.ts). Refusing to index derived account ids.",
    );
  }

  verified = true;
}
