import { SubstrateEvent } from "@subql/types";

function extrinsicIndex(event: SubstrateEvent): number {
  return event.extrinsic ? event.extrinsic.idx : event.idx;
}

function blockNumber(event: SubstrateEvent): number {
  return event.block.block.header.number.toNumber();
}
interface ProxyEventData {
  proxyAccountId: string;
  accountId: string;
  type: string;
  delay: number;
  blockNumber: number;
  extrinsicIndex: number;
}

/**
 * Extracts and validates proxy event data
 */
export function extractProxyEventData(event: SubstrateEvent): ProxyEventData | null {
  const {
    event: {
      data,
    },
  } = event;

  if (!data || !Array.isArray(data)) {
    logger.error(`Invalid data: ${JSON.stringify(data)}`);
    return null;
  }

  const accountId = data.at(0)?.toHuman() as string;
  const proxyAccountId = data.at(1)?.toHuman() as string;
  const type = data.at(2)?.toHuman() as string;
  const delay = parseInt(data.at(3)?.toHuman() as string);

  if (!proxyAccountId) {
    logger.error(`Invalid proxyAccountId: ${JSON.stringify(proxyAccountId)}`);
    return null;
  }

  if (!accountId) {
    logger.error(`Invalid accountId: ${JSON.stringify(accountId)}`);
    return null;
  }

  if (!type) {
    logger.error(`Invalid type: ${JSON.stringify(type)}`);
    return null;
  }

  if (typeof delay !== 'number') {
    logger.error(`Invalid delay: ${JSON.stringify(delay)}`);
    return null;
  }

  return { proxyAccountId, accountId, type, delay, blockNumber: blockNumber(event), extrinsicIndex: extrinsicIndex(event) };
}