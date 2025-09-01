import { SubstrateEvent } from "@subql/types";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress } from "../../utils";
import { CreateCallVisitorBuilder, CreateCallWalk, VisitedCall } from "subquery-call-visitor";
import { EventStatus, MultisigEvent, MultisigOperation, OperationStatus } from "../../types";
import { AccountId, DispatchResult, Timepoint } from "@polkadot/types/interfaces";
import { generateEventId, generateOperationId, getBlockCreated, getDataFromCall, getDataFromEvent, getIndexCreated, timestamp } from "../../utils/operations";

import { AnyTuple, CallBase } from "@polkadot/types/types";

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
    .on("multisig", "approveAsMulti", handleCall)
    .on("multisig", "cancelAsMulti", handleCall)
    .ignoreFailedCalls(true)
    .build();
}

function createHandleCall(operation: MultisigOperation, callHash: string) {
  return async (visitedCall: VisitedCall) => {
    const call = getDataFromCall<CallBase<AnyTuple>>(visitedCall.call, "call");

    if (call?.hash.toHex() !== callHash) {
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

export async function handleNewMultisigEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHash = getDataFromEvent<Uint8Array>(event.event, "callHash", 2);
  if (!callHash) throw new Error("Call hash not found");

  const callHashString = u8aToHex(callHash);

  const multisig = getDataFromEvent<AccountId>(event.event, "multisig", 1);
  if (!multisig) throw new Error("Multisig not found");

  const multisigAccountId = multisig.toHex();

  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);

  const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);
  const operationId = generateOperationId(callHashString, multisigAccountId, blockCreated, indexCreated);
  const signer = u8aToHex(decodeAddress(event.extrinsic.extrinsic.signer.toString()));

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
    id: operationId,
    callHash: callHashString,
    status: existingOperation?.status || OperationStatus.pending,
    accountId: multisigAccountId,
    depositor: signer,
    blockCreated: blockCreated,
    indexCreated: indexCreated,
    timestamp: timestamp(event.extrinsic.block),
  });

  await MultisigEvent.create({
    id: generateEventId(newOperation.id, signer, EventStatus.approve),
    accountId: signer,
    status: EventStatus.approve,
    blockCreated: getBlockCreated(event.extrinsic),
    indexCreated: getIndexCreated(event.extrinsic),
    multisigId: newOperation.id,
    timestamp: timestamp(event.extrinsic.block),
  }).save();

  const handleCall = createHandleCall(newOperation, callHashString);
  const multisigVisitor = createMultisigVisitor(handleCall);

  await callWalk.walk(event.extrinsic, multisigVisitor);
  await newOperation.save();
}

export async function handleMultisigApprovedEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHash = getDataFromEvent<Uint8Array>(event.event, "callHash", 3);

  if (!callHash) throw new Error("Call hash not found");

  const callHashString = u8aToHex(callHash);

  const multisig = getDataFromEvent<AccountId>(event.event, "multisig", 2);

  if (!multisig) throw new Error("Multisig not found");

  const multisigAccountId = multisig.toHex();

  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);

  const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);

  const operationId = generateOperationId(callHashString, multisigAccountId, blockCreated, indexCreated);

  const signer = u8aToHex(decodeAddress(event.extrinsic.extrinsic.signer.toString()));

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
    id: operationId,
    callHash: callHashString,
    status: existingOperation?.status || OperationStatus.pending,
    accountId: multisigAccountId,
    depositor: signer,
    blockCreated: blockCreated,
    indexCreated: indexCreated,
    timestamp: timestamp(event.extrinsic.block),
  });

  await MultisigEvent.create({
    id: generateEventId(newOperation.id, signer, EventStatus.approve),
    accountId: signer,
    status: EventStatus.approve,
    blockCreated: getBlockCreated(event.extrinsic),
    indexCreated: getIndexCreated(event.extrinsic),
    multisigId: newOperation.id,
    timestamp: timestamp(event.extrinsic.block),
  }).save();

  const handleCall = createHandleCall(newOperation, callHashString);
  const multisigVisitor = createMultisigVisitor(handleCall);

  await callWalk.walk(event.extrinsic, multisigVisitor);
  await newOperation.save();
}

export async function handleMultisigExecutedEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHash = getDataFromEvent<Uint8Array>(event.event, "callHash", 3);

  if (!callHash) throw new Error("Call hash not found");

  const callHashString = u8aToHex(callHash);

  const multisig = getDataFromEvent<AccountId>(event.event, "multisig", 2);

  if (!multisig) throw new Error("Multisig not found");

  const multisigAccountId = multisig.toHex();

  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);

  const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);

  const operationId = generateOperationId(callHashString, multisigAccountId, blockCreated, indexCreated);

  const signer = u8aToHex(decodeAddress(event.extrinsic.extrinsic.signer.toString()));

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
    id: operationId,
    callHash: callHashString,
    status: existingOperation?.status || OperationStatus.pending,
    accountId: multisigAccountId,
    depositor: signer,
    blockCreated: blockCreated,
    indexCreated: indexCreated,
    timestamp: timestamp(event.extrinsic.block),
  });

  await MultisigEvent.create({
    id: generateEventId(newOperation.id, signer, EventStatus.approve),
    accountId: signer,
    status: EventStatus.approve,
    blockCreated: getBlockCreated(event.extrinsic),
    indexCreated: getIndexCreated(event.extrinsic),
    multisigId: newOperation.id,
    timestamp: timestamp(event.extrinsic.block),
  }).save();

  const handleCall = createHandleCall(newOperation, callHashString);
  const multisigVisitor = createMultisigVisitor(handleCall);

  await callWalk.walk(event.extrinsic, multisigVisitor);

  const result = getDataFromEvent<DispatchResult>(event.event, "result", 4);

  const status = result?.isOk ? OperationStatus.executed : OperationStatus.error;
  newOperation.status = status;

  await newOperation.save();
}

export async function handleMultisigCancelledEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHash = getDataFromEvent<Uint8Array>(event.event, "callHash", 3);

  if (!callHash) throw new Error("Call hash not found");

  const callHashString = u8aToHex(callHash);

  const multisig = getDataFromEvent<AccountId>(event.event, "multisig", 2);

  if (!multisig) throw new Error("Multisig not found");

  const multisigAccountId = multisig.toHex();

  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);

  const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);

  const operationId = generateOperationId(callHashString, multisigAccountId, blockCreated, indexCreated);

  const signer = u8aToHex(decodeAddress(event.extrinsic.extrinsic.signer.toString()));

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
    id: operationId,
    callHash: callHashString,
    status: existingOperation?.status || OperationStatus.pending,
    accountId: multisigAccountId,
    depositor: signer,
    blockCreated: blockCreated,
    indexCreated: indexCreated,
    timestamp: timestamp(event.extrinsic.block),
  });

  await MultisigEvent.create({
    id: generateEventId(newOperation.id, signer, EventStatus.reject),
    accountId: signer,
    status: EventStatus.reject,
    blockCreated: getBlockCreated(event.extrinsic),
    indexCreated: getIndexCreated(event.extrinsic),
    multisigId: newOperation.id,
    timestamp: timestamp(event.extrinsic.block),
  }).save();

  const handleCall = createHandleCall(newOperation, callHashString);
  const multisigVisitor = createMultisigVisitor(handleCall);

  await callWalk.walk(event.extrinsic, multisigVisitor);
  newOperation.status = OperationStatus.cancelled;

  await newOperation.save();
}
