import { OverrideBundleDefinition } from "@polkadot/types/types";

const definitions: OverrideBundleDefinition = {
  types: [
    {
      // Specs 2–9435: ChargeAssetTxPayment.asset_id = Option<u32>
      // Pallet: pallet_asset_tx_payment (specs <800 have no v14 metadata;
      // override is harmless since ChargeAssetTxPayment is absent there).
      // Verified on-chain via RPC metadata scan across all spec eras.
      minmax: [0, 9435],
      types: {
        NovaAssetId: "Option<AssetId>",
      },
    },
    {
      // Specs 1000000+: ChargeAssetTxPayment.asset_id = Option<MultiLocation/Location>
      // Pallet switched to pallet_asset_conversion_tx_payment.
      //   1000000–1003003: staging_xcm::v3::multilocation::MultiLocation
      //   2000007+:        staging_xcm::v5::location::Location
      // All are structurally identical {parents: u8, interior: Junctions},
      // so MultiLocationV3 decodes all of them correctly.
      minmax: [1000000, null],
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
  typesBundle: { spec: { statemine: definitions } },
};
