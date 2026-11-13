import { existsSync, mkdirSync, writeFileSync } from "node:fs";

import { artifacts, network } from "hardhat";
import { formatEther, getAddress, type Hex } from "viem";

// Deploys SpaceProofAnchor to Avalanche Fuji and records the deployment in
// deployments/fuji.json (public data only: address, transaction, block).
//
//   npm run deploy:fuji
//
// The key comes from ANCHOR_PRIVATE_KEY (contracts/.env or the environment)
// and is never printed. The deployer becomes the contract's owner.
//
// If a deployment transaction was sent but not recorded (for example, the
// script stopped while waiting), record it without sending anything:
//
//   DEPLOY_TX=0x<transaction hash> npm run deploy:fuji

const FUJI_CHAIN_ID = 43113;
const RECORD = "deployments/fuji.json";
const EXPLORER = "https://testnet.snowtrace.io";

function fail(message: string): never {
  console.error(`Deployment aborted: ${message}`);
  process.exit(1);
}

if (existsSync(RECORD)) {
  fail(
    `${RECORD} already exists. A second deployment would create a second, empty registry; remove the file only if that is what you want.`,
  );
}

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();

const chainId = await publicClient.getChainId();
if (chainId !== FUJI_CHAIN_ID) {
  fail(`connected to chain ${chainId}, expected Fuji (${FUJI_CHAIN_ID}).`);
}

const address = deployer.account.address;
console.log(`Network:  Avalanche Fuji (chain id ${chainId})`);
console.log(`Deployer: ${getAddress(address)}`);

const artifact = await artifacts.readArtifact("SpaceProofAnchor");
let transactionHash = process.env.DEPLOY_TX as Hex | undefined;

if (transactionHash === undefined) {
  const balance = await publicClient.getBalance({ address });
  console.log(`Balance:  ${formatEther(balance)} AVAX`);
  if (balance === 0n) {
    fail("the deployer has no test AVAX. Fund it from a Fuji faucet first.");
  }
  transactionHash = await deployer.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode as Hex,
  });
  // Printed before waiting: if the wait fails, rerun with DEPLOY_TX set to
  // this hash instead of deploying again.
  console.log(`Transaction sent: ${transactionHash}`);
} else {
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
    fail("DEPLOY_TX must be 0x followed by 64 lowercase hex characters.");
  }
  console.log(`Recording existing transaction: ${transactionHash}`);
}

// Polls until the transaction is mined: a public RPC may take a moment to
// show a transaction it has just accepted.
const receipt = await publicClient.waitForTransactionReceipt({
  hash: transactionHash,
  confirmations: 1,
});
if (receipt.status !== "success" || receipt.contractAddress == null) {
  fail(`transaction ${receipt.transactionHash} did not create a contract.`);
}
if (getAddress(receipt.from) !== getAddress(address)) {
  fail(`transaction ${receipt.transactionHash} was not sent by the deployer.`);
}

// Read back from the chain: what is recorded is what is there.
const contract = await viem.getContractAt(
  "SpaceProofAnchor",
  receipt.contractAddress,
);
const code = await publicClient.getCode({ address: receipt.contractAddress });
if (code === undefined || code === "0x") {
  fail(`no code found at ${receipt.contractAddress}.`);
}
const owner = await contract.read.owner();
if (getAddress(owner) !== getAddress(address)) {
  fail(`the contract's owner is ${owner}, not the deployer.`);
}
const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

const record = {
  network: "fuji",
  chainId,
  contract: "SpaceProofAnchor",
  address: getAddress(receipt.contractAddress),
  owner,
  transactionHash: receipt.transactionHash,
  blockNumber: Number(receipt.blockNumber),
  deployedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
};
mkdirSync("deployments", { recursive: true });
writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);

console.log(`Contract: ${record.address}`);
console.log(`Owner:    ${record.owner}`);
console.log(`Block:    ${record.blockNumber}`);
console.log(`Recorded in ${RECORD}`);
console.log(`${EXPLORER}/address/${record.address}`);
console.log(`${EXPLORER}/tx/${record.transactionHash}`);
