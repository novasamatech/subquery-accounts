import { SubstrateEvent, SubstrateExtrinsic } from "@subql/types";
import { CreateCallVisitorBuilder, VisitedCall } from "subquery-call-visitor";
import type { u16 } from "@polkadot/types-codec";
import type { AccountId } from "@polkadot/types/interfaces";
import { callWalk } from "../../utils/callWalk";
import { createKeyMultiAccountId } from "../../utils/addressesDecode";
import { assertCryptoIntegrity } from "../../utils/cryptoIntegrity";
import { EventStatus, MultisigOperation, OperationStatus } from "../../types";
import { generateOperationId, getDataFromCall, timestamp } from "../../utils/operations";
import {
  createMultisigEvent,
  getCallHashString,
  getMultisigAccountId,
  getSignatory,
  getBlockAndIndexFromEvent,
  findExistingOperation,
  getExecutionResult,
} from "../../utils/multisigHelpers";

import { AnyTuple, CallBase } from "@polkadot/types/types";

/**
 * Creates a multisig visitor with the specified call handler
 * @param handleCall - Function to handle multisig calls
 * @returns Configured visitor
 */
function createMultisigVisitor(handleCall: (visitedCall: VisitedCall) => Promise<void>) {
  return CreateCallVisitorBuilder()
    .on("utility", ["batch", "batchAll", "forceBatch"], (extrinsic, context) => {
      const calls = extrinsic.call.args.at(0);
      const maxLength = 10_000;
      if ((Array.isArray(calls) && calls.length > maxLength) || extrinsic.events.length > maxLength) {
        context.stop();
      }
    })
    .on("multisig", "asMulti", handleCall)
    .on("multisig", "asMultiThreshold1", handleCall)
    .on("utility", "asMulti", handleCall)
    .on("utility", "asMultiThreshold1", handleCall)
    .ignoreFailedCalls(true)
    .build();
}

async function collectMultisigCalls(extrinsic: SubstrateExtrinsic): Promise<VisitedCall[]> {
  const calls: VisitedCall[] = [];
  await callWalk.walk(extrinsic, createMultisigVisitor(async visited => { calls.push(visited); }));
  return calls;
}

async function findMultisigCall(extrinsic: SubstrateExtrinsic, callHash: string, accountId: string): Promise<VisitedCall | undefined> {
  const calls = await collectMultisigCalls(extrinsic);
  assertCryptoIntegrity();
  return calls.find(visited => {
    const call = getDataFromCall<CallBase<AnyTuple>>(visited.call, "call");
    if (!call) throw new Error("Call not found");
    if (call.hash.toHex() !== callHash) return false;
    const others = getDataFromCall<AccountId[]>(visited.call, "otherSignatories") ??
      getDataFromCall<AccountId[]>(visited.call, "other_signatories");
    const threshold = visited.call.method === "asMultiThreshold1" ? 1 : getDataFromCall<u16>(visited.call, "threshold")?.toNumber();
    if (!others || threshold === undefined) throw new Error("Multisig call has no threshold or other signatories");
    return createKeyMultiAccountId([...others.map(signatory => signatory.toString()), visited.origin], threshold) === accountId;
  });
}

function populateOperationWithCallData(operation: MultisigOperation, visited: VisitedCall | undefined): void {
  if (!visited) return;
  const call = getDataFromCall<CallBase<AnyTuple>>(visited.call, "call");
  if (!call) throw new Error("Call not found");
  operation.callData = call.toHex();
  operation.method = call.method;
  operation.section = call.section;
}

export async function handleNewMultisigEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHashString = getCallHashString(event, 2);
  const multisigAccountId = getMultisigAccountId(event, 1);

  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);

  logger.info(
    `[handleNewMultisigEvent] callHashString: ${callHashString}, blockCreated: ${blockCreated}, indexCreated: ${indexCreated}, multisigAccountId: ${multisigAccountId}`,
  );

  const operationId = generateOperationId(callHashString, multisigAccountId, blockCreated, indexCreated);

  const signatory = getSignatory(event, "approving");
  const multisigCall = await findMultisigCall(event.extrinsic, callHashString, multisigAccountId);

  const newOperation = await MultisigOperation.create({
    id: operationId,
    chainId: chainId,
    callHash: callHashString,
    status: OperationStatus.pending,
    accountId: multisigAccountId,
    depositor: signatory,
    blockCreated: blockCreated,
    indexCreated: indexCreated,
    timestamp: timestamp(event.extrinsic.block),
  });

  await createMultisigEvent(event, newOperation.id, signatory, EventStatus.approve);
  populateOperationWithCallData(newOperation, multisigCall);
  await newOperation.save();
}

export async function handleMultisigApprovedEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHashString = getCallHashString(event, 3);
  const multisigAccountId = getMultisigAccountId(event, 2);
  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);
  const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);
  const signatory = getSignatory(event, "approving");
  const multisigCall = await findMultisigCall(event.extrinsic, callHashString, multisigAccountId);

  const newOperation = await MultisigOperation.create({
    ...existingOperation,
  });

  await createMultisigEvent(event, newOperation.id, signatory, EventStatus.approve);
  populateOperationWithCallData(newOperation, multisigCall);
  await newOperation.save();
}

export async function handleMultisigExecutedEvent(event: SubstrateEvent) {
  if (!event.extrinsic) throw new Error("Extrinsic not found");

  const callHashString = getCallHashString(event, 3);
  const multisigAccountId = getMultisigAccountId(event, 2);
  const { blockCreated, indexCreated } = getBlockAndIndexFromEvent(event);
  const multisigCall = await findMultisigCall(event.extrinsic, callHashString, multisigAccountId);
  const isThresholdOne = multisigCall?.call.method === "asMultiThreshold1";
  const finalStatus = getExecutionResult(event);
  const signatory = getSignatory(event, "approving");

  let operation: MultisigOperation;

  if (isThresholdOne) {
    const operationId = generateOperationId(callHashString, multisigAccountId, blockCreated, indexCreated);
    operation = await MultisigOperation.create({
      id: operationId,
      chainId: chainId,
      callHash: callHashString,
      status: finalStatus,
      accountId: multisigAccountId,
      depositor: signatory,
      blockCreated: blockCreated,
      indexCreated: indexCreated,
      timestamp: timestamp(event.extrinsic.block),
    });
  } else {
    const existingOperation = await findExistingOperation(callHashString, blockCreated, indexCreated, multisigAccountId);
    operation = await MultisigOperation.create({
      ...existingOperation,
      status: finalStatus,
    });
  }

  await createMultisigEvent(event, operation.id, signatory, EventStatus.approve);
  populateOperationWithCallData(operation, multisigCall);
  await operation.save();
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

  await createMultisigEvent(event, newOperation.id, signatory, EventStatus.reject);
  await newOperation.save();
}
