import { u8aToHex } from "@polkadot/util";
import { SubstrateEvent } from "@subql/types";
import { decodeAddress } from "./addressesDecode";
import { HexString } from "@polkadot/util/types";
import { Codec } from "@polkadot/types/types";
import { eventParser } from "./eventParser";

export function getPureProxyId(params: { delegator: HexString; chainId: string }) {
  return `${params.chainId}-${params.delegator}`;
}

export function getProxiedId(params: { delegator: HexString; delegatee: HexString; type: string; delay: number; chainId: string }) {
  return `${params.chainId}-${params.delegator}-${params.delegatee}-${params.type}-${params.delay}`;
}

/**
 * Extracts and validates proxy event data
 */

type ProxyEventData = {
  delegator: HexString;
  delegatee: HexString;
  type: Codec;
  delay: number;
  blockNumber: number;
  extrinsicIndex: number;
};

export function extractProxyEventData(event: SubstrateEvent): ProxyEventData | null {
  const {
    event: { data },
  } = event;

  if (!data || !Array.isArray(data)) {
    logger.error(`Invalid data: ${JSON.stringify(data)}`);
    return null;
  }

  const delegator = data.at(0)?.toHuman() as string;
  const delegatee = data.at(1)?.toHuman() as string;
  const type = data.at(2);
  const delay = parseInt(data.at(3)?.toHuman() as string);

  if (!delegatee) {
    logger.error(`Invalid proxyAccountId: ${JSON.stringify(delegatee)}`);
    return null;
  }

  if (!delegator) {
    logger.error(`Invalid accountId: ${JSON.stringify(delegator)}`);
    return null;
  }

  if (!type) {
    logger.error(`Invalid type: ${JSON.stringify(type)}`);
    return null;
  }

  if (typeof delay !== "number") {
    logger.error(`Invalid delay: ${JSON.stringify(delay)}`);
    return null;
  }

  return {
    delegator: u8aToHex(decodeAddress(delegator)),
    delegatee: u8aToHex(decodeAddress(delegatee)),
    type,
    delay,
    blockNumber: eventParser.blockNumber(event),
    extrinsicIndex: eventParser.extrinsicIndex(event),
  };
}
