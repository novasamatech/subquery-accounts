export interface MultisigArgs {
  args: {
    threshold: number;
    other_signatories: string[];
    maybe_timepoint?: {
      height: string;
      index: string;
    },
    call_hash?: `0x${string}`;
  };
}

export interface CancelMultisigArgs {
  args: {
    threshold: number;
    other_signatories: string[];
    timepoint: {
      height: string;
      index: string;
    },    
    call_hash: `0x${string}`;
  };
}
