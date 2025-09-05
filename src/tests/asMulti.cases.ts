import { Account, AccountMultisig } from "../types";

export interface AsMultiCaseConfig {
  name: string;
  block: number;
  dependentEntities?: any;
  expectedEntities?: any;
}

export const AS_MULTI_CASES: { [manifestBase: string]: AsMultiCaseConfig } = {
  "0x91b171bb158e2d3848fa23a9f1c25182fb8e20313b2c1eb49219da7a70ce90c3": {
    name: "polkadot", block: 27626569, dependentEntities: [], expectedEntities: [
      AccountMultisig.create({
        id: "0x14b3cf31ec26dcd596285c2afbdd19579b3634a78bc987dad71d91ecf436847b-0xfecc28dd9692d147bb8af57fadbee14659740b6fe50c1775d6941b8a1629b5d8",
        multisigId: "0xfecc28dd9692d147bb8af57fadbee14659740b6fe50c1775d6941b8a1629b5d8",
        signatoryId: "0x14b3cf31ec26dcd596285c2afbdd19579b3634a78bc987dad71d91ecf436847b"
      }),
      Account.create({
        id: "0xfecc28dd9692d147bb8af57fadbee14659740b6fe50c1775d6941b8a1629b5d8",
        accountId: "0xfecc28dd9692d147bb8af57fadbee14659740b6fe50c1775d6941b8a1629b5d8",
        isMultisig: true,
        threshold: "4" as unknown as number // for some reason number here do not working with expect in test framework
      }),
    ]
  },
  "0x70255b4d28de0fc4e1a193d7e175ad1ccef431598211c55538f1018651a0344e": {
    name: "aleph-zero", block: 120027387, dependentEntities: [], expectedEntities: [
      AccountMultisig.create({
        id: "0x7a28037947ecebe0dd86dc0e910911cb33185fd0714b37b75943f67dcf9b6e7c-0x92b254cca405990962c4fcd8510ee3e659b2edf6db5b8d3cb53b0286ac8377ab",
        multisigId: "0x92b254cca405990962c4fcd8510ee3e659b2edf6db5b8d3cb53b0286ac8377ab",
        signatoryId: "0x7a28037947ecebe0dd86dc0e910911cb33185fd0714b37b75943f67dcf9b6e7c"
      }),
      Account.create({
        id: "0x92b254cca405990962c4fcd8510ee3e659b2edf6db5b8d3cb53b0286ac8377ab",
        accountId: "0x92b254cca405990962c4fcd8510ee3e659b2edf6db5b8d3cb53b0286ac8377ab",
        isMultisig: true,
        threshold: "3" as unknown as number // for some reason number here do not working with expect in test framework
      }),
    ]
  },
  // "project-kusama.yaml": { name: "kusama", manifestPath: "./project-kusama.yaml" },
  // "project-westend.yaml": { name: "westend", manifestPath: "./project-westend.yaml" },
  // "project-rococo.yaml": { name: "rococo", manifestPath: "./project-rococo.yaml" },
  // "project-moonbeam.yaml": { name: "moonbeam", manifestPath: "./project-moonbeam.yaml" },
  // "project-moonriver.yaml": { name: "moonriver", manifestPath: "./project-moonriver.yaml" },
  // "project-hydradx.yaml": { name: "hydradx", manifestPath: "./project-hydradx.yaml" },
  // "project-mythos.yaml": { name: "mythos", manifestPath: "./project-mythos.yaml" },
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


