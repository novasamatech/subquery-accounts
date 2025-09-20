import { Codec } from "@polkadot/types/types";
import { u8aToHex } from "@polkadot/util";
import { HexString } from "@polkadot/util/types";
import { SubstrateEvent } from "@subql/types";
import { eventParser } from "./eventParser";
import { decodeAddress } from "./addressesDecode";

type PureProxyEventData = {
  pure: HexString;
  who: HexString;
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

  const pure = data.at(0)?.toHuman() as string;
  const who = data.at(1)?.toHuman() as string;
  const type = data.at(2);
  const disambiguationIndex = parseInt(data.at(3)?.toHuman() as string);

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

  if (typeof disambiguationIndex !== "number") {
    logger.error(`Invalid disambiguationIndex: ${JSON.stringify(disambiguationIndex)}`);
    return null;
  }

  return {
    pure: u8aToHex(decodeAddress(pure)),
    who: u8aToHex(decodeAddress(who)),
    type,
    delay: 0,
    disambiguationIndex,
    blockNumber: eventParser.blockNumber(event),
    extrinsicIndex: eventParser.extrinsicIndex(event),
  };
}
