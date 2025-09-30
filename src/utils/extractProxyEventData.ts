import { u8aToHex } from "@polkadot/util";
import { SubstrateEvent } from "@subql/types";
import { decodeAddress } from "./addressesDecode";
import { HexString } from "@polkadot/util/types";
import { Codec } from "@polkadot/types/types";
import { eventParser } from "./eventParser";

export function getPureProxyId(params: { pure: HexString; chainId: string }) {
  return `${params.chainId}-${params.pure}`;
}

export function getProxiedId(params: { proxied: HexString; proxy: HexString; type: string; delay: number; chainId: string }) {
  return `${params.chainId}-${params.proxied}-${params.proxy}-${params.type}-${params.delay}`;
}

/**
 * Extracts and validates proxy event data
 */

type ProxyEventData = {
  proxied: HexString;
  proxy: HexString;
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

  const proxied = data.at(0)?.toHuman() as string;
  const proxy = data.at(1)?.toHuman() as string;
  const type = data.at(2);
  const delay = parseInt(data.at(3)?.toHuman() as string);

  if (!proxy) {
    logger.error(`Invalid proxyAccountId: ${JSON.stringify(proxy)}`);
    return null;
  }

  if (!proxied) {
    logger.error(`Invalid accountId: ${JSON.stringify(proxied)}`);
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
    proxied: u8aToHex(decodeAddress(proxied)),
    proxy: u8aToHex(decodeAddress(proxy)),
    type,
    delay,
    blockNumber: eventParser.blockNumber(event),
    extrinsicIndex: eventParser.extrinsicIndex(event),
  };
}
