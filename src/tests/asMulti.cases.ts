export interface AsMultiCaseConfig {
  name: string;
  block: number;
  dependentEntities?: any;
  expectedEntities?: any;
}

export const AS_MULTI_CASES: { [manifestBase: string]: AsMultiCaseConfig } = {
  "project-polkadot.yaml": { name: "polkadot", block: 27626569, dependentEntities: [], expectedEntities: [] },
  // "project-kusama.yaml": { name: "kusama", manifestPath: "./project-kusama.yaml" },
  // "project-westend.yaml": { name: "westend", manifestPath: "./project-westend.yaml" },
  // "project-rococo.yaml": { name: "rococo", manifestPath: "./project-rococo.yaml" },
  // "project-moonbeam.yaml": { name: "moonbeam", manifestPath: "./project-moonbeam.yaml" },
  // "project-moonriver.yaml": { name: "moonriver", manifestPath: "./project-moonriver.yaml" },
  // "project-hydradx.yaml": { name: "hydradx", manifestPath: "./project-hydradx.yaml" },
  // "project-mythos.yaml": { name: "mythos", manifestPath: "./project-mythos.yaml" },
  // "project-aleph-zero.yaml": { name: "aleph-zero", manifestPath: "./project-aleph-zero.yaml" },
  // "project-avail.yaml": { name: "avail", manifestPath: "./project-avail.yaml" },
  // "project-kusama-asset-hub.yaml": { name: "kusama-asset-hub", manifestPath: "./project-kusama-asset-hub.yaml" },
  // "project-polkadot-asset-hub.yaml": { name: "polkadot-asset-hub", manifestPath: "./project-polkadot-asset-hub.yaml" },
  // "project-polkadot-coretime.yaml": { name: "polkadot-coretime", manifestPath: "./project-polkadot-coretime.yaml" },
  // "project-kusama-coretime.yaml": { name: "kusama-coretime", manifestPath: "./project-kusama-coretime.yaml" },
  // "project-kusama-people-chain.yaml": { name: "kusama-people-chain", manifestPath: "./project-kusama-people-chain.yaml" },
  // "project-polkadot-people-chain.yaml": { name: "polkadot-people-chain", manifestPath: "./project-polkadot-people-chain.yaml" },
  // "project-westend-asset-hub.yaml": { name: "westend-asset-hub", manifestPath: "./project-westend-asset-hub.yaml" },
  // "project-testnet.yaml": { name: "testnet", manifestPath: "./project-testnet.yaml" },
};


