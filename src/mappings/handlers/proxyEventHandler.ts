import { SubstrateEvent } from "@subql/types";

import { Proxy } from "../../types";

const logger = console;
const chainId = "substrate";

interface ProxyEventData {
  delegator: string;
  delegatee: string;
  type: string;
  delay: number;
}

/**
 * Extracts and validates proxy event data
 */
function extractProxyEventData(event: SubstrateEvent): ProxyEventData | null {
  const {
    event: {
      data,
    },
  } = event;

  if (!data || !Array.isArray(data)) {
    logger.error(`Invalid data: ${JSON.stringify(data)}`);
    return null;
  }

  const delegator = data.at(0)?.toHuman() as string;
  const delegatee = data.at(1)?.toHuman() as string;
  const type = data.at(2)?.toHuman() as string;
  const delay = parseInt(data.at(3)?.toHuman() as string);

  if (!delegator) {
    logger.error(`Invalid delegator: ${JSON.stringify(delegator)}`);
    return null;
  }

  if (!delegatee) {
    logger.error(`Invalid delegatee: ${JSON.stringify(delegatee)}`);
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

  return { delegator, delegatee, type, delay };
}

export async function handleProxyEvent(
  event: SubstrateEvent
): Promise<void> {
  const proxyData = extractProxyEventData(event);
  
  if (!proxyData) {
    return;
  }

  const { delegator, delegatee, type, delay } = proxyData;

  logger.info(`Proxy Add Event: ${JSON.stringify({
    type,
    delegator,
    delegatee,
    delay,
  })}`);

  const proxy = Proxy.create({
    id: `${chainId}-${delegator}-${delegatee}-${type}-${delay}`,
    chainId,
    type,
    delegator,
    delegatee,
    delay,
  });

  await proxy.save();
}

export async function handleProxyRemovedEvent(
  event: SubstrateEvent
): Promise<void> {
  const proxyData = extractProxyEventData(event);
  
  if (!proxyData) {
    return;
  }

  const { delegator, delegatee, type, delay } = proxyData;

  logger.info(`Proxy Remove Event: ${JSON.stringify({
    chainId,
    type,
    delegator,
    delegatee,
    delay,
  })}`);

  await Proxy.remove(`${chainId}-${delegator}-${delegatee}-${type}-${delay}`);
}
