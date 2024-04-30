export const getAccountMultisigId = (signatoryId: string, multisigId: string) =>
  `${signatoryId}-${multisigId}`;
