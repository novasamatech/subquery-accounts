import type { Enum, Struct } from "@polkadot/types-codec";
import type { GenericExtrinsic } from "@polkadot/types/extrinsic/Extrinsic";
import type { CodecClass, Registry, RegisteredTypes } from "@polkadot/types/types";

const EXTRINSIC_VERSION_V5 = 5;
const GENERAL_EXTRINSIC_PREAMBLE = 0x40 | EXTRINSIC_VERSION_V5;
const MIN_GENERAL_PAYLOAD_BYTES = 2; // Preamble + extension version; metadata validates the rest.

// Read-only block decoding adapter, not a General-v5 transaction builder/signer.
// Return codecs created by the registry: it lives outside SubQuery's chain
// types VM, and its numeric decoders cannot consume the VM's Uint8Arrays.
export const MetadataGeneralExtrinsic = class {
  constructor(registry: Registry, value: Uint8Array | string) {
    const encoded = registry.createType("Raw", value).toU8a();
    const length = registry.createType("Compact<u32>", encoded);
    const offset = length.encodedLength;
    const end = offset + length.toNumber();
    if (end > encoded.length || encoded[offset] !== GENERAL_EXTRINSIC_PREAMBLE || length.toNumber() < MIN_GENERAL_PAYLOAD_BYTES) {
      throw new Error("Invalid general extrinsic envelope");
    }

    const data = encoded.subarray(offset + 1, end);
    const metadata = registry.metadata.extrinsic;
    const pipeline = [...metadata.transactionExtensionsByVersion].find(([version]) => version.eq(data[0]));
    if (!pipeline) {
      throw new Error(`Unknown transaction extension version: ${data[0]}`);
    }

    // polkadot-js 16.5.x uses the v4 extensions for all versions. v16 metadata
    // supplies both the exact order and the SCALE types for each v5 pipeline.
    const fields: Record<string, string> = { transactionExtensionVersion: "u8" };
    for (const index of pipeline[1]) {
      const extension = metadata.transactionExtensions[index.toNumber()];
      if (!extension) throw new Error(`Missing transaction extension: ${index}`);
      fields[extension.identifier.toString()] = registry.createLookupType(extension.type);
    }
    fields["method"] = "Call";
    const decoded = registry.createTypeUnsafe<Struct>(JSON.stringify(fields), [data]);
    if (decoded.encodedLength !== data.length) {
      throw new Error("General extrinsic length does not match its metadata");
    }
    // Some stock codecs normalize malformed input (e.g. bool 2 -> 0) without
    // changing its length. Never expose a different transaction encoding/hash.
    const reencoded = decoded.toU8a();
    if (reencoded.length !== data.length || reencoded.some((byte, index) => byte !== data[index])) {
      throw new Error("Non-canonical general extrinsic payload");
    }

    // Pipelines differ per chain (e.g. ChargeTransactionPayment instead of
    // ChargeAssetTxPayment); absent extensions yield the stock default values.
    const assetPayment = () => decoded.get("ChargeAssetTxPayment") as Struct | undefined;
    const metadataHash = () => decoded.get("CheckMetadataHash") as Struct | undefined;
    Object.defineProperties(decoded, {
      // GenericExtrinsic reads the preamble from the inner version on creation.
      version: { value: GENERAL_EXTRINSIC_PREAMBLE },
      signature: { value: { isSigned: false } },
      method: { get: () => decoded.get("method") },
      era: { get: () => decoded.get("CheckMortality") ?? registry.createType("ExtrinsicEra") },
      nonce: { get: () => decoded.get("CheckNonce") ?? registry.createType("Compact<Index>") },
      tip: { get: () => assetPayment()?.get("tip") ?? decoded.get("ChargeTransactionPayment") ?? registry.createType("Compact<Balance>") },
      assetId: { get: () => assetPayment()?.get("assetId") },
      mode: { get: () => registry.createType("u8", metadataHash()?.getT<Enum>("mode").index ?? 0) },
      // The metadata hash is implicit signing data, absent from the extrinsic.
      metadataHash: { get: () => registry.createType("Option<Hash>") },
    });
    return decoded;
  }
} as unknown as CodecClass;

export const MetadataExtrinsic = class {
  constructor(registry: Registry, value?: unknown, options?: unknown) {
    const Extrinsic = registry.createClassUnsafe<GenericExtrinsic>("GenericExtrinsic");
    const extrinsic = new Extrinsic(registry, value, options);
    if (!extrinsic.isGeneral()) return extrinsic;

    const extensions = extrinsic.unwrap() as unknown as Struct;
    const verification = extensions.get("VerifyMultiSignature") as Enum | undefined;
    const authorization = verification?.type === "Signed" ? verification.value as Struct : undefined;
    const signature = authorization?.get("signature") as Enum | undefined;
    Object.defineProperties(extrinsic, {
      type: { value: EXTRINSIC_VERSION_V5 },
      // A v5 signature lives in VerifyMultiSignature, not the v4 signed bit.
      version: { value: GENERAL_EXTRINSIC_PREAMBLE },
      isSigned: { value: !!authorization },
      signer: { get: () => registry.createType("Address", authorization?.get("account")?.toHex()) },
      signature: { get: () => {
        const codec = signature ?? registry.createType<Enum>("ExtrinsicSignature");
        return codec.value ?? codec;
      } },
    });
    return extrinsic;
  }
} as unknown as CodecClass;

/**
 * Register metadata-driven General-v5 decoding for each manifest's chain types.
 * @param chainTypes Existing network types, bundles and signed-extension overrides.
 * @returns A new configuration with the General-v5 codecs; v4 and bare v5 use the stock codec.
 * Codec registration takes precedence over existing Extrinsic/GeneralExtrinsic types.
 */
export function withMetadataExtrinsic(chainTypes: RegisteredTypes): RegisteredTypes {
  return {
    ...chainTypes,
    types: { ...chainTypes.types, Extrinsic: MetadataExtrinsic, GeneralExtrinsic: MetadataGeneralExtrinsic },
  };
}
