import { OverrideBundleDefinition } from "@polkadot/types/types";

const definitions: OverrideBundleDefinition = {
  types: [
    {
      // Specs 2–1001002: ChargeAssetTxPayment.asset_id = Option<u32>
      // Pallet: pallet_asset_tx_payment.  Spec 2 has no ChargeAssetTxPayment
      // but the override is harmless (type is unused if extension is absent).
      // Verified on-chain via RPC metadata scan across all spec eras.
      minmax: [0, 1001002],
      types: {
        NovaAssetId: "Option<AssetId>",
      },
    },
    {
      // Specs 1002000+: ChargeAssetTxPayment.asset_id = Option<MultiLocation/Location>
      // Pallet switched to pallet_asset_conversion_tx_payment.
      //   1002000–1003003: staging_xcm::v3::multilocation::MultiLocation
      //   1004000–1007001: staging_xcm::v4::location::Location
      //   2000002+:        staging_xcm::v5::location::Location
      // All three are structurally identical {parents: u8, interior: Junctions},
      // so MultiLocationV3 decodes all of them correctly.
      minmax: [1002000, null],
      types: {
        NovaAssetId: "Option<MultiLocationV3>",
      },
    },
  ],
  signedExtensions: {
    ChargeAssetTxPayment: {
      extrinsic: {
        tip: "Compact<Balance>",
        // eslint-disable-next-line sort-keys
        assetId: "NovaAssetId",
      },
      payload: {},
    },
  },
};

export default {
  typesBundle: { spec: { statemint: definitions } },
};
