import { readFileSync } from "node:fs";

import { artifacts, network } from "hardhat";
import { getAddress, type Address, type Hex } from "viem";

// Checks, against the live chain, that deployments/fuji.json describes a real
// SpaceProofAnchor: read-only, needs no funds.
//
//   npm run check:fuji
//   HASH=0x<64 hex> npm run check:fuji    also looks a certificate hash up
//
// (Hardhat still asks for ANCHOR_PRIVATE_KEY to open the network; nothing is
// signed.)

interface DeploymentRecord {
  chainId: number;
  address: Address;
  owner: Address;
  transactionHash: Hex;
  blockNumber: number;
}

const record = JSON.parse(
  readFileSync("deployments/fuji.json", "utf8"),
) as DeploymentRecord;

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const problems: string[] = [];

const chainId = await publicClient.getChainId();
if (chainId !== record.chainId) {
  problems.push(`chain id is ${chainId}, the record says ${record.chainId}`);
}

// The code on chain must be, byte for byte, the code this repository builds.
// The only bytes allowed to differ are the immutable slots (the owner's
// address, written at deployment), which the build leaves as zeros.
const code = await publicClient.getCode({ address: record.address });
const artifact = await artifacts.readArtifact("SpaceProofAnchor");
if (code === undefined || code === "0x") {
  problems.push(`no contract code at ${record.address}`);
} else {
  let onChain = code.slice(2);
  const slots = Object.values(
    artifact.immutableReferences as Record<
      string,
      { start: number; length: number }[]
    >,
  ).flat();
  for (const { start, length } of slots) {
    onChain =
      onChain.slice(0, start * 2) +
      "0".repeat(length * 2) +
      onChain.slice((start + length) * 2);
  }
  if (`0x${onChain}` !== artifact.deployedBytecode) {
    problems.push("the deployed code is not the code of this build");
  } else {
    console.log(
      `Code:        ${(code.length - 2) / 2} bytes, identical to this build`,
    );
  }
}

const receipt = await publicClient.getTransactionReceipt({
  hash: record.transactionHash,
});
if (
  receipt.contractAddress == null ||
  getAddress(receipt.contractAddress) !== getAddress(record.address)
) {
  problems.push("the recorded transaction did not create this contract");
}
if (Number(receipt.blockNumber) !== record.blockNumber) {
  problems.push(`mined in block ${receipt.blockNumber}, not ${record.blockNumber}`);
}

const contract = await viem.getContractAt("SpaceProofAnchor", record.address);
const owner = await contract.read.owner();
if (getAddress(owner) !== getAddress(record.owner)) {
  problems.push(`owner is ${owner}, the record says ${record.owner}`);
}

console.log(`Chain id:    ${chainId}`);
console.log(`Contract:    ${record.address}`);
console.log(`Owner:       ${owner}`);
console.log(`Deployed in: block ${receipt.blockNumber}, ${record.transactionHash}`);

const hash = process.env.HASH;
if (hash !== undefined) {
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    problems.push("HASH must be 0x followed by 64 lowercase hex characters");
  } else {
    const anchoredAt = await contract.read.anchoredAt([hash as Hex]);
    console.log(
      anchoredAt === 0n
        ? `Hash ${hash}: not anchored`
        : `Hash ${hash}: anchored at ${new Date(Number(anchoredAt) * 1000).toISOString()}`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`MISMATCH: ${problem}`);
  process.exit(1);
}
console.log("OK: the record matches the chain.");
