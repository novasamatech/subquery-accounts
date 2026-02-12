import { OverrideBundleDefinition } from "@polkadot/types/types";

const definitions: OverrideBundleDefinition = {
  types: [
    {
      // Specs 2–9425: ChargeAssetTxPayment.asset_id = Option<u32>
      // Pallet: pallet_asset_tx_payment (specs <504 have no v14 metadata;
      // override is harmless since ChargeAssetTxPayment is absent there).
      // Verified on-chain via RPC metadata scan across all spec eras.
      minmax: [0, 9425],
      types: {
        NovaAssetId: "Option<AssetId>",
      },
    },
    {
      // Specs 9435+: ChargeAssetTxPayment.asset_id = Option<MultiLocation/Location>
      // Pallet switched to pallet_asset_conversion_tx_payment.
      //   9435–1015000:  xcm::v3::multilocation::MultiLocation
      //   1016000:       staging_xcm::v4::location::Location
      //   1017001+:      staging_xcm::v5::location::Location
      // All are structurally identical {parents: u8, interior: Junctions},
      // so MultiLocationV3 decodes all of them correctly.
      minmax: [9435, null],
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
  typesBundle: { spec: { westmint: definitions } },
};
