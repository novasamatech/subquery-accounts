import { subqlTest } from "@subql/testing";
import { Proxied } from "../types";

// Polkadot Asset Hub block 2430302, extrinsic 2 — proxy.addProxy.
//   delegator (signer): 1virto…  (accountId 0x28f8eba6…)
//   delegatee:          15oLan…  (proxyAccountId 0xd44824ac…)
//   proxy_type: Any, delay: 0
// handleProxyEvent must persist a regular Proxied entity (isPureProxy=false,
// no disambiguationIndex/spawner since no PureProxy exists for the delegator).
//
// https://assethub-polkadot.subscan.io/block/2430302

const CHAIN_ID = "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f";
const PROXIED = "0x28f8eba6bdaecef86bc33c0f7ba0ccfc77664776a6033c31c7716f4de2a1c74f";
const PROXY = "0xd44824ac8d1edecca67639ca74d208bd2044a10e67c9677e288080191e3fec13";

subqlTest(
  "ProxyAdded: creates non-pure Proxied entity",
  2430302,
  [],
  [
    Proxied.create({
      id: `${CHAIN_ID}-${PROXIED}-${PROXY}-Any-0`,
      chainId: CHAIN_ID,
      type: "Any",
      proxyAccountId: PROXY,
      accountId: PROXIED,
      delay: 0,
      blockNumber: 2430302,
      extrinsicIndex: 2,
      isPureProxy: false,
    }),
  ],
  "handleProxyEvent",
);
