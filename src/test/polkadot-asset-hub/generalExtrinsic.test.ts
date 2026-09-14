import { subqlTest } from "@subql/testing";

// The stock decoder crashes before this v5 utility.forceBatch reaches the
// visitor. Its staking.payoutStakers call should create no account entities.
subqlTest("v5 general extrinsic with extension pipeline 1", 20494727, [], [], "handleNestedCalls");
