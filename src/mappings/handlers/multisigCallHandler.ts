import { CancelMultisigArgs, MultisigArgs } from "../types";
import { SubstrateExtrinsic } from "@subql/types";
import { checkAndGetAccount } from "../../utils/checkAndGetAccount";
import { checkAndGetAccountMultisig } from "../../utils/checkAndGetAccountMultisig";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress, createKeyMultiAddress } from "../../utils";
import { CreateCallVisitorBuilder, CreateCallWalk, VisitedCall } from "subquery-call-visitor";
import { EventStatus, MultisigEvent, MultisigOperation, OperationStatus } from "../../types";
import { formatStringToNumber, generateEventId, generateOperationId, getBlockCreated, getIndexCreated, timestamp } from "../../utils/operations";
import { DispatchResult } from "@polkadot/types/interfaces";

const callWalk = CreateCallWalk()
const multisigVisitor = CreateCallVisitorBuilder()
  .on('multisig', 'asMulti', handleApproveMultisigCall)
  .on('multisig', 'approveAsMulti', handleApproveMultisigCall)
  .on('multisig', 'asMultiThreshold1', handleApproveMultisigCall)
  .on('multisig', 'cancelAsMulti', handleCancelMultisigCall)
  .ignoreFailedCalls(true)
  .build();

export async function handleMultisigCall(
  extrinsic: SubstrateExtrinsic
): Promise<void> {
  const {
    args: { threshold, other_signatories },
  } = extrinsic.extrinsic.method.toHuman() as unknown as MultisigArgs;

  const signer = extrinsic.extrinsic.signer.toString();
  const allSignatories = [...other_signatories, signer];
  const signatoriesAccountsPromises = allSignatories.map((signatory) =>
    checkAndGetAccount(u8aToHex(decodeAddress(signatory)))
  );
  const allSignatoriesAccounts = await Promise.all(signatoriesAccountsPromises);
  const multisigAddress = createKeyMultiAddress(allSignatories, threshold);
  const multisigAccount = await checkAndGetAccount(
    u8aToHex(decodeAddress(multisigAddress)),
    true,
    threshold
  );
  const accountMultisigsPromise = allSignatoriesAccounts.map((member) =>
    checkAndGetAccountMultisig(multisigAccount.id, member.id)
  );
  const accountMultisig = await Promise.all(accountMultisigsPromise);

  await Promise.all(allSignatoriesAccounts.map((member) => member.save()));
  await multisigAccount.save();
  await Promise.all(
    accountMultisig.map((accountMultisig) => accountMultisig.save())
  );

  await handleNewMultisigCall(extrinsic);
  await callWalk.walk(extrinsic, multisigVisitor)
}

async function getTransaction(extrinsic: SubstrateExtrinsic): Promise<MultisigOperation | undefined> {
  const { args } = extrinsic.extrinsic.method.toHuman() as unknown as MultisigArgs;
  const { threshold, other_signatories, maybe_timepoint: timepoint, call_hash } = args;

  const callIndex = extrinsic.extrinsic.method.meta.args.findIndex(arg =>
    arg.name.toLowerCase() === 'call'
  );
  const call = extrinsic.extrinsic.args[callIndex];
  const callHash = call_hash || extrinsic.extrinsic.args[callIndex]?.hash?.toHex();

  if (!callHash) return;

  const signer = extrinsic.extrinsic.signer.toString();
  const multisigAddress = createKeyMultiAddress([...other_signatories, signer], threshold);

  const blockCreated = timepoint ? formatStringToNumber(timepoint.height) : getBlockCreated(extrinsic);
  const indexCreated = timepoint ? formatStringToNumber(timepoint.index) : getIndexCreated(extrinsic);

  const [existingOperation] = await MultisigOperation.getByFields([
    ['callHash', '=', callHash],
    ['blockCreated', '=', blockCreated],
    ['indexCreated', '=', indexCreated],
    ['address', '=', multisigAddress]
  ], { limit: 1 });

  const operationId = existingOperation?.id || generateOperationId(callHash, multisigAddress, blockCreated, indexCreated);

  const newOperation = await MultisigOperation.create({
    id: operationId,
    callHash,
    status: OperationStatus.pending,
    address: multisigAddress,
    deposit: 1,
    depositor: extrinsic.extrinsic.signer.toHex(),
    blockCreated,
    indexCreated,
    callData: call?.toHex(),
    ...(call ? call.toHuman() as {} : {}),
    timestamp: timestamp(extrinsic.block)
  });

  await newOperation.save();
  return newOperation;
}

async function updateOperationStatus(operation: MultisigOperation, status: OperationStatus) {
  const updatedOperation = await MultisigOperation.create({
    ...operation,
    status,
  });
  await updatedOperation.save();
  return updatedOperation;
}

async function createMultisigEvent(extrinsic: SubstrateExtrinsic, operation: MultisigOperation, status: EventStatus) {
  const signer = extrinsic.extrinsic.signer.toString();

  await MultisigEvent.create({
    id: generateEventId(operation.id, signer, status),
    address: signer,
    status,
    blockCreated: getBlockCreated(extrinsic),
    indexCreated: getIndexCreated(extrinsic),
    multisigId: operation.id,
    timestamp: timestamp(extrinsic.block)
  }).save();
}

export async function handleApproveMultisigCall(call: VisitedCall): Promise<void> {
  const operation = await getTransaction(call.extrinsic);
  if (!operation) return;

  await createMultisigEvent(call.extrinsic, operation, EventStatus.approve);

  const finalEvent = call.events.find(e => e.method === 'MultisigExecuted');
  if (!finalEvent) return;

  const resultIndex = finalEvent.data.names?.indexOf('result');
  if (resultIndex === undefined || resultIndex === -1) return;

  const result = finalEvent.data[resultIndex] as DispatchResult;
  const status = result.isOk ? OperationStatus.executed : OperationStatus.error;
  await updateOperationStatus(operation, status);
}

export async function handleCancelMultisigCall(call: VisitedCall): Promise<void> {
  const { args } = call.extrinsic.extrinsic.method.toHuman() as unknown as CancelMultisigArgs;
  const { threshold, other_signatories, timepoint, call_hash: callHash } = args;

  const signer = call.extrinsic.extrinsic.signer.toString();
  const multisigAddress = createKeyMultiAddress([...other_signatories, signer], threshold);

  const [operation] = await MultisigOperation.getByFields([
    ['callHash', '=', callHash],
    ['blockCreated', '=', formatStringToNumber(timepoint!.height)],
    ['indexCreated', '=', formatStringToNumber(timepoint!.index)],
    ['address', '=', multisigAddress]
  ], { limit: 1 });

  if (!operation) return;

  const updatedOperation = await updateOperationStatus(operation, OperationStatus.cancelled);
  await createMultisigEvent(call.extrinsic, updatedOperation, EventStatus.reject);
}

export async function handleNewMultisigCall(extrinsic: SubstrateExtrinsic): Promise<void> {
  const operation = await getTransaction(extrinsic);
  if (operation) await createMultisigEvent(extrinsic, operation, EventStatus.approve);
}
