import { SubstrateEvent } from "@subql/types";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress } from "../../utils";
import { CreateCallVisitorBuilder, CreateCallWalk, VisitedCall } from "subquery-call-visitor";
import { EventStatus, MultisigEvent, MultisigOperation, OperationStatus } from "../../types";
import {
  generateEventId,
  generateOperationId,
  getBlockCreated,
  getDataFromCall,
  getDataFromEvent,
  getIndexCreated,
  timestamp,
} from "../../utils/operations";
import { AccountId, DispatchResult, Timepoint } from "@polkadot/types/interfaces";
import { AnyTuple, CallBase } from "@polkadot/types/types";

const callWalk = CreateCallWalk();

export async function handleMultisigCallEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const isNewMultisig = event.event.method === "NewMultisig";

  const possibleIndex = isNewMultisig ? 2 : 3;
  const callHash = getDataFromEvent<Uint8Array>(event.event, "callHash", possibleIndex);

  if (!callHash) throw new Error("Call hash not found");

  const callHashString = u8aToHex(callHash);

  const multisigPossibleIndex = isNewMultisig ? 1 : 2;
  const multisig = getDataFromEvent<AccountId>(event.event, "multisig", multisigPossibleIndex);

  if (!multisig) throw new Error("Multisig not found");

  const multisigAccountId = multisig.toHex();

  let timepoint = null;
  let blockCreated = getBlockCreated(event.extrinsic);
  let indexCreated = getIndexCreated(event.extrinsic);
  if (!isNewMultisig) {
    timepoint = getDataFromEvent<Timepoint>(event.event, "timepoint", 1) || getDataFromEvent<Timepoint>(event.event, "Timepoint", 1);
  }
  if (timepoint && timepoint.height && timepoint.index) {
    blockCreated = timepoint.height.toNumber();
    indexCreated = timepoint.index.toNumber();
  }

  const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);

  const operationId = generateOperationId(callHashString, multisigAccountId, blockCreated, indexCreated);

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
    id: operationId,
    callHash: callHashString,
    status: existingOperation?.status || OperationStatus.pending,
    accountId: multisigAccountId,
    depositor: u8aToHex(decodeAddress(event.extrinsic.extrinsic.signer.toString())),
    blockCreated: blockCreated,
    indexCreated: indexCreated,
    timestamp: timestamp(event.extrinsic.block),
  });

  await newOperation.save();

  const handleCall = async (visitedCall: VisitedCall) => {
    const call = getDataFromCall<CallBase<AnyTuple>>(visitedCall.call, "call");

    const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);

    if (!existingOperation) throw new Error("Operation not found and that is fucking bad");

    let callData = call?.toHex() || existingOperation?.callData;
    let method = call?.method || existingOperation?.method;
    let section = call?.section || existingOperation?.section;

    const updatedOperation = await MultisigOperation.create({
      ...existingOperation,
      callData: callData,
      method: method,
      section: section,
    });
    await updatedOperation.save();

    const signer = u8aToHex(decodeAddress(visitedCall.origin));

    await MultisigEvent.create({
      id: generateEventId(updatedOperation.id, signer, EventStatus.approve),
      accountId: signer,
      status: EventStatus.approve,
      blockCreated: getBlockCreated(visitedCall.extrinsic),
      indexCreated: getIndexCreated(visitedCall.extrinsic),
      multisigId: updatedOperation.id,
      timestamp: timestamp(visitedCall.extrinsic.block),
    }).save();
  };

  const multisigVisitorHuy = CreateCallVisitorBuilder()
    .on("utility", ["batch", "batchAll", "forceBatch"], (extrinsic, context) => {
      const calls = extrinsic.call.args.at(0);
      if (Array.isArray(calls) && calls.length > 100) {
        // we're skipping large batches, something terrible happens inside anyway
        context.stop();
      }
    })
    .on("multisig", "asMulti", handleCall)
    .on("multisig", "asMultiThreshold1", handleCall)
    .on("multisig", "approveAsMulti", handleCall)
    .on("multisig", "cancelAsMulti", handleCall)
    .ignoreFailedCalls(true)
    .build();

  await callWalk.walk(event.extrinsic, multisigVisitorHuy);

  logger.info(`Multisig event method: ${event.event.method}`);

  const finalEvent = event.event.method === "MultisigExecuted" || event.event.method === "MultisigCancelled";
  if (!finalEvent) return;

  const result = getDataFromEvent<DispatchResult>(event.event, "result", 4);

  let status = result?.isOk ? OperationStatus.executed : OperationStatus.error;
  if (event.event.method === "MultisigCancelled") {
    status = OperationStatus.cancelled;
  }

  // getting updated operation after call walker
  const operation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);

  if (!operation) throw new Error("Operation not found and that is fucking bad");

  const updatedOperation = await MultisigOperation.create({
    ...operation,
    status,
  });
  await updatedOperation.save();
}

async function findExistingOperation(
  callHashString: string,
  blockCreated: number,
  indexCreated: number,
  multisigAccountId: string,
): Promise<MultisigOperation | undefined> {
  const [existingOperation] = await MultisigOperation.getByFields(
    [
      ["callHash", "=", callHashString],
      ["blockCreated", "=", blockCreated],
      ["indexCreated", "=", indexCreated],
      ["accountId", "=", multisigAccountId],
    ],
    { limit: 1 },
  );
  return existingOperation;
}
