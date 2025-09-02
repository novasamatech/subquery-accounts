import { SubstrateEvent, SubstrateExtrinsic } from "@subql/types";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress } from "../../utils";
import { CreateCallVisitorBuilder, CreateCallWalk, VisitedCall } from "subquery-call-visitor";
import { EventStatus, MultisigEvent, MultisigOperation, OperationStatus } from "../../types";
import { AccountId, DispatchResult, Timepoint } from "@polkadot/types/interfaces";
import { generateEventId, generateOperationId, getBlockCreated, getDataFromCall, getDataFromEvent, getIndexCreated, timestamp } from "../../utils/operations";

import { AnyTuple, CallBase } from "@polkadot/types/types";

function getCallHashString(event: SubstrateEvent, index: number): string {
  const callHash = getDataFromEvent<Uint8Array>(event.event, "callHash", index);
  if (!callHash) throw new Error("Call hash not found");
  return u8aToHex(callHash);
}

function getMultisigAccountId(event: SubstrateEvent, index: number): string {
  const multisig = getDataFromEvent<AccountId>(event.event, "multisig", index);
  if (!multisig) throw new Error("Multisig not found");
  return multisig.toHex();
}

function getSignatory(event: SubstrateEvent, fieldName: string): string {
  const signatory = getDataFromEvent<AccountId>(event.event, fieldName, 0);
  if (!signatory) throw new Error("Signatory not found");
  return signatory.toHex();
}

function getBlockAndIndexFromEvent(event: SubstrateEvent): { blockCreated: number; indexCreated: number } {
  let blockCreated = getBlockCreated(event.extrinsic!);
  let indexCreated = getIndexCreated(event.extrinsic!);

  const timepoint = getDataFromEvent<Timepoint>(event.event, "timepoint", 1) || getDataFromEvent<Timepoint>(event.event, "Timepoint", 1);

  if (timepoint && timepoint.height && timepoint.index) {
    blockCreated = timepoint.height.toNumber();
    indexCreated = timepoint.index.toNumber();
  }

  return { blockCreated, indexCreated };
}

const callWalk = CreateCallWalk();

function createMultisigVisitor(handleCall: (visitedCall: VisitedCall) => Promise<void>) {
  return CreateCallVisitorBuilder()
    .on("utility", ["batch", "batchAll", "forceBatch"], (extrinsic, context) => {
      const calls = extrinsic.call.args.at(0);
      if (Array.isArray(calls) && calls.length > 100) {
        // we're skipping large batches, something terrible happens inside anyway
        context.stop();
      }
    })
    .on("multisig", "asMulti", handleCall)
    .on("multisig", "asMultiThreshold1", handleCall)
    .ignoreFailedCalls(true)
    .build();
}

async function calculateMultiCalls(extrinsic: SubstrateExtrinsic) {
  let count = 0;

  const handleCall = (_: VisitedCall) => {
    count++;
    return Promise.resolve();
  };

  const visitor = CreateCallVisitorBuilder()
    .on("utility", ["batch", "batchAll", "forceBatch"], (extrinsic, context) => {
      const calls = extrinsic.call.args.at(0);
      if (Array.isArray(calls) && calls.length > 100) {
        // we're skipping large batches, something terrible happens inside anyway
        context.stop();
      }
    })
    .on("multisig", "asMulti", handleCall)
    .on("multisig", "asMultiThreshold1", handleCall)
    .ignoreFailedCalls(true)
    .build();

  await callWalk.walk(extrinsic, visitor);
  return count;
}

function createHandleCall(operation: MultisigOperation, callHash: string, multisigCallsWithCallData: number) {
  return async (visitedCall: VisitedCall) => {
    const call = getDataFromCall<CallBase<AnyTuple>>(visitedCall.call, "call");

    if (!call) {
      throw new Error("Call not found");
    }

    if (multisigCallsWithCallData >= 2 && call.hash.toHex() !== callHash) {
      return;
    }

    let callData = call?.toHex() || operation?.callData;
    let method = call?.method || operation?.method;
    let section = call?.section || operation?.section;

    operation.callData = callData;
    operation.method = method;
    operation.section = section;
  };
}

async function findExistingOperation(callHashString: string, blockCreated: number, indexCreated: number, multisigAccountId: string) {
  const [existingOperation] = await MultisigOperation.getByFields(
    [
      ["callHash", "=", callHashString],
      ["blockCreated", "=", blockCreated],
      ["indexCreated", "=", indexCreated],
      ["accountId", "=", multisigAccountId],
    ],
    { limit: 1 },
  );

  if (!existingOperation) {
    throw new Error(
      `Operation not found for call hash: ${callHashString} on block: ${blockCreated} index: ${indexCreated} multisig account id: ${multisigAccountId}`,
    );
  }

  return existingOperation;
}

async function populateOperationWithCallData(operation: MultisigOperation, callHashString: string, event: SubstrateEvent): Promise<void> {
  const count = await calculateMultiCalls(event.extrinsic!);

  const handleCall = createHandleCall(operation, callHashString, count);
  const multisigVisitor = createMultisigVisitor(handleCall);

  await callWalk.walk(event.extrinsic!, multisigVisitor);
}

export async function handleNewMultisigEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHashString = getCallHashString(event, 2);
  const multisigAccountId = getMultisigAccountId(event, 1);

  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);

  const operationId = generateOperationId(callHashString, multisigAccountId, blockCreated, indexCreated);

  const signatory = getSignatory(event, "approving");

  const newOperation = await MultisigOperation.create({
    id: operationId,
    chainId,
    callHash: callHashString,
    status: OperationStatus.pending,
    accountId: multisigAccountId,
    depositor: signatory,
    blockCreated: blockCreated,
    indexCreated: indexCreated,
    timestamp: timestamp(event.extrinsic.block),
  });

  await MultisigEvent.create({
    id: generateEventId(newOperation.id, signatory, EventStatus.approve),
    accountId: signatory,
    status: EventStatus.approve,
    blockCreated: getBlockCreated(event.extrinsic),
    indexCreated: getIndexCreated(event.extrinsic),
    multisigId: newOperation.id,
    timestamp: timestamp(event.extrinsic.block),
  }).save();

  await populateOperationWithCallData(newOperation, callHashString, event);
  await newOperation.save();
}

export async function handleMultisigApprovedEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHashString = getCallHashString(event, 3);
  const multisigAccountId = getMultisigAccountId(event, 2);

  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);

  const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);

  const signatory = getSignatory(event, "approving");

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
  });

  await MultisigEvent.create({
    id: generateEventId(newOperation.id, signatory, EventStatus.approve),
    accountId: signatory,
    status: EventStatus.approve,
    blockCreated: getBlockCreated(event.extrinsic),
    indexCreated: getIndexCreated(event.extrinsic),
    multisigId: newOperation.id,
    timestamp: timestamp(event.extrinsic.block),
  }).save();

  await populateOperationWithCallData(newOperation, callHashString, event);
  await newOperation.save();
}

export async function handleMultisigExecutedEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHashString = getCallHashString(event, 3);
  const multisigAccountId = getMultisigAccountId(event, 2);

  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);

  const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);

  const signatory = getSignatory(event, "approving");

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
  });

  await MultisigEvent.create({
    id: generateEventId(newOperation.id, signatory, EventStatus.approve),
    accountId: signatory,
    status: EventStatus.approve,
    blockCreated: getBlockCreated(event.extrinsic),
    indexCreated: getIndexCreated(event.extrinsic),
    multisigId: newOperation.id,
    timestamp: timestamp(event.extrinsic.block),
  }).save();

  await populateOperationWithCallData(newOperation, callHashString, event);

  const result = getDataFromEvent<DispatchResult>(event.event, "result", 4);

  const status = result?.isOk ? OperationStatus.executed : OperationStatus.error;
  newOperation.status = status;

  await newOperation.save();
}

export async function handleMultisigCancelledEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHashString = getCallHashString(event, 3);
  const multisigAccountId = getMultisigAccountId(event, 2);

  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);

  const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);

  const signatory = getSignatory(event, "cancelling");

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
    status: OperationStatus.cancelled,
  });

  await MultisigEvent.create({
    id: generateEventId(newOperation.id, signatory, EventStatus.reject),
    accountId: signatory,
    status: EventStatus.reject,
    blockCreated: getBlockCreated(event.extrinsic),
    indexCreated: getIndexCreated(event.extrinsic),
    multisigId: newOperation.id,
    timestamp: timestamp(event.extrinsic.block),
  }).save();

  await newOperation.save();
}
