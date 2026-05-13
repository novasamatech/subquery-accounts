import { subqlTest } from "@subql/testing";
import { Proxied, PureProxy } from "../../types";

// Polkadot Asset Hub block 15,503,985, extrinsic 2 — proxy.createPure with an
// explicit `when = Some((historic_relay_block, historic_ext_idx))`. This is the
// canonical migration scenario: an Asset Hub user re-creates on AH the same
// pure proxy they had on Polkadot relay, so the AH-side derivation has to use
// the relay's original `(block_number, extrinsic_index)` rather than the AH
// envelope. The runtime exposes those values in event data fields `at` (data[4])
// and `extrinsicIndex` (data[5]); `extractPureProxyEventData` must read from
// the payload, not from `event.block.block.header.number` / `event.extrinsic.idx`.
//
// Event payload (from RPC):
//   pure:                 15aFQvvt8j2ZCvMEjnUSz7s1nxt1yA1znBN8yUFo1SCr4YMk
//                       = 0xca4c8c9aa817020d515f77e46d60c74fdc7ea74244bba937e06a6a8abed5c746
//   who (spawner):        13TRAXTALwNp5vApqwiE74fg8G8ypMyaF9TxRfs4RwrCwxUE
//                       = 0x6c9e3102dd2c24274667d416e07570ebce6f20ab80ee3fc9917bf4a7568b8fd2
//   proxyType:            Any
//   disambiguationIndex:  1337         (data[3] — also exercises Number(toString())
//                                       vs the legacy parseInt(toHuman())="1,337"→1 bug)
//   at:                   31,147,672   (data[4] — relay-chain block; must end up in
//                                       PureProxy.entropyBlockNumber / Proxied.blockNumber)
//   extrinsicIndex:       2            (data[5] — must end up in *.extrinsicIndex)
//
// Pre-fix behaviour: extractPureProxyEventData wrote envelope values
// (blockNumber=15503985, extrinsicIndex=2) into entities, and findPureBlockNumber
// threw `Who 0x6c9e… is not the pure account …`, looping the indexer.
//
// https://assethub-polkadot.subscan.io/block/15503985

const CHAIN_ID = "0x68d56f15f85d3136970ec16946040bc1752654e906147f7e43e9d539d7c3de2f";
const PURE = "0xca4c8c9aa817020d515f77e46d60c74fdc7ea74244bba937e06a6a8abed5c746";
const SPAWNER = "0x6c9e3102dd2c24274667d416e07570ebce6f20ab80ee3fc9917bf4a7568b8fd2";

const DERIVATION_BLOCK = 31147672; // relay-chain block from payload `at` — NOT 15503985
const DERIVATION_EXT_IDX = 2;
const DISAMBIGUATION_INDEX = 1337;

subqlTest(
  "PureCreated with explicit `when`: uses payload at/extrinsicIndex for derivation",
  15503985,
  [],
  [
    PureProxy.create({
      id: `${CHAIN_ID}-${PURE}`,
      chainId: CHAIN_ID,
      accountId: PURE,
      spawner: SPAWNER,
      disambiguationIndex: DISAMBIGUATION_INDEX,
      entropyBlockNumber: DERIVATION_BLOCK,
      extrinsicIndex: DERIVATION_EXT_IDX,
    }),
    Proxied.create({
      id: `${CHAIN_ID}-${PURE}-${SPAWNER}-Any-0`,
      chainId: CHAIN_ID,
      type: "Any",
      proxyAccountId: SPAWNER,
      accountId: PURE,
      delay: 0,
      blockNumber: DERIVATION_BLOCK,
      extrinsicIndex: DERIVATION_EXT_IDX,
      isPureProxy: true,
      disambiguationIndex: DISAMBIGUATION_INDEX,
      spawner: SPAWNER,
    }),
  ],
  "handlePureProxyEvent",
);
