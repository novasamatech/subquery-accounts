export interface MultisigArgs {
  args: {
    threshold: number;
    other_signatories: string[];
  };
}
