import { SubstrateExtrinsic } from "@subql/types";
import { CreateCallVisitorBuilder, CreateCallWalk, VisitedCall } from "subquery-call-visitor";
import { Proxied } from "../../types";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress } from "../../utils/addressesDecode";

const callWalk = CreateCallWalk();
const proxyVisitor = CreateCallVisitorBuilder()
  .on("utility", ["batch", "batchAll", "forceBatch"], (extrinsic, context) => {
    const calls = extrinsic.call.args.at(0);
    if (Array.isArray(calls) && calls.length > 100) {
      // we're skipping large batches, something terrible happens inside anyway
      context.stop();
    }
  })
  .on("proxy", "removeProxies", handleRemoveProxiesCall)
  .ignoreFailedCalls(true)
  .build();

export async function handleProxyCall(extrinsic: SubstrateExtrinsic): Promise<void> {
  await callWalk.walk(extrinsic, proxyVisitor);
}

export async function handleRemoveProxiesCall(call: VisitedCall): Promise<void> {
  if (!call || !call.call || !call.call.args) {
    throw new Error(`Invalid call: ${JSON.stringify(call)}`);
  }

  const callerAccountId = u8aToHex(decodeAddress(call.origin));

  while (true) {
    const proxiedBatch = await Proxied.getByFields(
      [
        ["accountId", "=", callerAccountId],
        ["chainId", "=", chainId],
      ],
      { limit: 100 },
    );

    if (proxiedBatch.length === 0) {
      break;
    }

    logger.info(`Removing ${proxiedBatch.length} proxy records for account ${callerAccountId}`);

    for (const proxied of proxiedBatch) {
      await Proxied.remove(proxied.id);
    }
  }

  logger.info(`Completed removing all proxies for account ${callerAccountId}`);
}
