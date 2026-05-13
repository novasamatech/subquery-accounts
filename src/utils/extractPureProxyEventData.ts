import { Codec } from "@polkadot/types/types";
import { u8aToHex } from "@polkadot/util";
import { HexString } from "@polkadot/util/types";
import { SubstrateEvent } from "@subql/types";
import { eventParser } from "./eventParser";
import { decodeAddress } from "./addressesDecode";

type PureProxyEventData = {
  pure: HexString;
  spawner: HexString;
  type: Codec;
  disambiguationIndex: number;
  delay: number;
  blockNumber: number;
  extrinsicIndex: number;
};

export function extractPureProxyEventData(event: SubstrateEvent): PureProxyEventData | null {
  const {
    event: { data },
  } = event;

  if (!data || !Array.isArray(data)) {
    logger.error(`Invalid data: ${JSON.stringify(data)}`);
    return null;
  }

  // Use `toString()` rather than `toHuman()` for the index: toHuman formats numbers with
  // thousands separators (e.g. "1,337"), and parseInt of that string would silently truncate
  // at the comma and return 1. Number(toString()) gives the actual integer.
  const pure = data.at(0)?.toString();
  const who = data.at(1)?.toString();
  const type = data.at(2);
  const disambiguationIndex = Number(data.at(3)?.toString());

  // Modern proxy.PureCreated events carry the derivation parameters (`at`,
  // `extrinsicIndex`) in the event payload itself. They reflect whatever the
  // runtime actually passed to `pure_account(..., maybe_when)`. When a user
  // calls `proxy.createPure` with an explicit `when = Some((historic_block,
  // historic_ext_idx))` — the canonical case being Asset Hub users re-creating
  // their relay-chain pure proxies on AH — these payload fields are the only
  // way to reproduce the on-chain pure address. The block envelope (header
  // block number / extrinsic.idx) describes WHEN the call was dispatched, not
  // WHAT inputs went into the entropy.
  //
  // For older runtimes that emit `AnonymousCreated` with only 4 fields, or any
  // chain whose runtime does not include these fields, `data.at(4)` is undefined
  // and we fall back to the envelope — matches the previous (legacy) behaviour.
  const atField = data.at(4);
  const extrinsicIndexField = data.at(5);

  const blockNumber = atField !== undefined ? Number(atField.toString()) : eventParser.blockNumber(event);
  const extrinsicIndex = extrinsicIndexField !== undefined ? Number(extrinsicIndexField.toString()) : eventParser.extrinsicIndex(event);

  if (!who) {
    logger.error(`Invalid proxyAccountId: ${JSON.stringify(who)}`);
    return null;
  }

  if (!pure) {
    logger.error(`Invalid accountId: ${JSON.stringify(pure)}`);
    return null;
  }

  if (!type) {
    logger.error(`Invalid type: ${JSON.stringify(type)}`);
    return null;
  }

  if (!Number.isFinite(disambiguationIndex)) {
    logger.error(`Invalid disambiguationIndex: ${JSON.stringify(disambiguationIndex)}`);
    return null;
  }

  if (!Number.isFinite(blockNumber)) {
    logger.error(`Invalid blockNumber from event payload: ${JSON.stringify(atField?.toString())}`);
    return null;
  }

  if (!Number.isFinite(extrinsicIndex)) {
    logger.error(`Invalid extrinsicIndex from event payload: ${JSON.stringify(extrinsicIndexField?.toString())}`);
    return null;
  }

  return {
    pure: u8aToHex(decodeAddress(pure)),
    spawner: u8aToHex(decodeAddress(who)),
    type,
    delay: 0,
    disambiguationIndex,
    blockNumber,
    extrinsicIndex,
  };
}
