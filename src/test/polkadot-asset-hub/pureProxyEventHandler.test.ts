import { subqlTest } from "@subql/testing";
import { Proxied, PureProxy } from "../../types";

// Polkadot Asset Hub block 6601748, extrinsic 2 — direct proxy.createPure
// (no multisig wrapper, so the test exercises only the pure-proxy path).
//   pure:           0x32b451dd…  (created pure proxy)
//   who (spawner):  0x40ff75e9…  (extrinsic signer)
//   proxy_type: Any, disambiguation_index: 0
// findPureBlockNumber reproduces the on-chain account using the parachain
// blockNumber (not relayParentNumber), so entropyBlockNumber must equal 6601748.
//
// https://assethub-polkadot.subscan.io/block/6601748

const CHAIN_ID = "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f";
const PURE = "0x32b451ddfb7b71e4463c38a5bac29bd9679f4c04d853bae12bb1ee4440c1e1ac";
const SPAWNER = "0x40ff75e9f6e5eea6579fd37a8296c58b0ff0f0940ea873e5d26b701163b1b325";

subqlTest(
  "PureCreated: creates PureProxy and matching pure Proxied entity",
  6601748,
  [],
  [
    PureProxy.create({
      id: `${CHAIN_ID}-${PURE}`,
      chainId: CHAIN_ID,
      accountId: PURE,
      spawner: SPAWNER,
      disambiguationIndex: 0,
      entropyBlockNumber: 6601748,
      extrinsicIndex: 2,
    }),
    Proxied.create({
      id: `${CHAIN_ID}-${PURE}-${SPAWNER}-Any-0`,
      chainId: CHAIN_ID,
      type: "Any",
      proxyAccountId: SPAWNER,
      accountId: PURE,
      delay: 0,
      blockNumber: 6601748,
      extrinsicIndex: 2,
      isPureProxy: true,
      disambiguationIndex: 0,
      spawner: SPAWNER,
    }),
  ],
  "handlePureProxyEvent",
);
