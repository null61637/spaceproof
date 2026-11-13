import { readFileSync } from "node:fs";

import { network } from "hardhat";
import { parseEventLogs, type Address, type Hex } from "viem";

// Anchors one certificate hash by hand in the deployed SpaceProofAnchor and
// checks the result on chain. For tests and manual operation: the backend
// will anchor on its own.
//
//   HASH=0x<64 lowercase hex> npm run anchor:fuji
//
// Signs with ANCHOR_PRIVATE_KEY, which must be the contract's owner.

const FUJI_CHAIN_ID = 43113;
const EXPLORER = "https://testnet.snowtrace.io";

function fail(message: string): never {
  console.error(`Anchoring aborted: ${message}`);
  process.exit(1);
}

const hash = process.env.HASH as Hex | undefined;
if (hash === undefined || !/^0x[0-9a-f]{64}$/.test(hash)) {
  fail("HASH must be 0x followed by 64 lowercase hex characters.");
}

const record = JSON.parse(readFileSync("deployments/fuji.json", "utf8")) as {
  address: Address;
};

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
if (chainId !== FUJI_CHAIN_ID) {
  fail(`connected to chain ${chainId}, expected Fuji (${FUJI_CHAIN_ID}).`);
}

const contract = await viem.getContractAt("SpaceProofAnchor", record.address);
const existing = await contract.read.anchoredAt([hash]);
if (existing !== 0n) {
  fail(
    `the hash is already anchored (${new Date(Number(existing) * 1000).toISOString()}).`,
  );
}

const transactionHash = await contract.write.anchor([hash]);
console.log(`Transaction sent: ${transactionHash}`);
const receipt = await publicClient.waitForTransactionReceipt({
  hash: transactionHash,
  confirmations: 1,
});
if (receipt.status !== "success") {
  fail(`transaction ${transactionHash} reverted.`);
}

// The event of this transaction and the stored value must agree.
const events = parseEventLogs({
  abi: contract.abi,
  eventName: "Anchored",
  logs: receipt.logs,
});
const anchoredAt = await contract.read.anchoredAt([hash]);
if (
  events.length !== 1 ||
  events[0].args.hash !== hash ||
  events[0].args.timestamp !== anchoredAt ||
  anchoredAt === 0n
) {
  fail("the Anchored event and anchoredAt() do not agree.");
}

console.log(`Contract:   ${record.address}`);
console.log(`Hash:       ${hash}`);
console.log(`Anchored:   ${anchoredAt} (${new Date(Number(anchoredAt) * 1000).toISOString()})`);
console.log(`Block:      ${receipt.blockNumber}, gas used ${receipt.gasUsed}`);
console.log(`${EXPLORER}/tx/${transactionHash}`);
