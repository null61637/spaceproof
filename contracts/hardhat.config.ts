import { existsSync } from "node:fs";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

// contracts/.env (never committed) holds the deployment key. Node loads it;
// variables already set in the environment win.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    // One build for tests and deployment, so what is tested is what is
    // deployed. The EVM version is pinned to one Avalanche C-Chain supports.
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    // Avalanche Fuji C-Chain (testnet, chain id 43113). There is no mainnet
    // network here on purpose, and the scripts refuse any other chain id.
    fuji: {
      type: "http",
      chainType: "generic",
      chainId: 43113,
      url:
        process.env.ANCHOR_RPC_URL ??
        "https://api.avax-test.network/ext/bc/C/rpc",
      // Same variable the backend will use: the deployer is the contract's
      // owner, the only account allowed to anchor. Resolved only when the
      // network is used, so building and testing need no key.
      accounts: [configVariable("ANCHOR_PRIVATE_KEY")],
    },
  },
});
