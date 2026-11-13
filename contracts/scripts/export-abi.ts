import { mkdirSync, writeFileSync } from "node:fs";

import { artifacts } from "hardhat";

// Writes the contract's ABI to abi/SpaceProofAnchor.json, the versioned copy
// the backend reads (the artifacts directory is build output and is ignored).
// A test fails if the two ever differ.
const { abi } = await artifacts.readArtifact("SpaceProofAnchor");
mkdirSync("abi", { recursive: true });
writeFileSync("abi/SpaceProofAnchor.json", `${JSON.stringify(abi, null, 2)}\n`);
console.log("ABI written to abi/SpaceProofAnchor.json");
