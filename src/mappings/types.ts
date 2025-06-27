import { AccountId } from "@polkadot/types/interfaces";

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

export interface MultisigThreshold1Args {
  args: {
    other_signatories: string[];
    call: unknown
  }
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


export interface MultisigRemarkArgs {
  threshold: number;
  signatories: string[];
  text: string;
}