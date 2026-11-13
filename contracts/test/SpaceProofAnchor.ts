import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, type Hex } from "viem";

const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

/** A certificate hash as the backend produces it: SHA-256, as bytes32. */
const sha256 = (text: string): Hex =>
  `0x${createHash("sha256").update(text, "utf8").digest("hex")}`;

describe("SpaceProofAnchor", async function () {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [owner, stranger] = await viem.getWalletClients();

  const deploy = () => viem.deployContract("SpaceProofAnchor");

  /** Timestamp of the block that mined `txHash`. */
  async function blockTime(txHash: Hex): Promise<bigint> {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const block = await publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    return block.timestamp;
  }

  it("makes the deployer the owner", async function () {
    const anchor = await deploy();
    assert.equal(await anchor.read.owner(), getAddress(owner.account.address));
  });

  it("reports a hash that was never anchored as 0", async function () {
    const anchor = await deploy();
    assert.equal(await anchor.read.anchoredAt([sha256("unknown")]), 0n);
  });

  it("anchors a hash with the block timestamp and emits Anchored", async function () {
    const anchor = await deploy();
    const hash = sha256("manifest");

    const txHash = await anchor.write.anchor([hash]);
    const timestamp = await blockTime(txHash);

    assert.ok(timestamp > 0n);
    assert.equal(await anchor.read.anchoredAt([hash]), timestamp);

    const events = await publicClient.getContractEvents({
      address: anchor.address,
      abi: anchor.abi,
      eventName: "Anchored",
      fromBlock: 0n,
      strict: true,
    });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].args, { hash, timestamp });
    assert.equal(events[0].transactionHash, txHash);
  });

  it("anchors the certificate hash of the manifest specification, byte for byte", async function () {
    // Vector A of docs/manifiesto-v2.md: the contentHash the backend stores,
    // registered as the same 32 bytes.
    const contentHash =
      "268d7919b7a4f9abf52122595b8aecaa2caba5d8f13a3fca91f0d770fdc1f846";
    const anchor = await deploy();

    await anchor.write.anchor([`0x${contentHash}`]);

    assert.notEqual(await anchor.read.anchoredAt([`0x${contentHash}`]), 0n);
    // A hash differing in one bit is a different entry.
    const oneBitOff: Hex = `0x${contentHash.slice(0, -1)}7`;
    assert.equal(await anchor.read.anchoredAt([oneBitOff]), 0n);
  });

  it("keeps hashes independent of each other", async function () {
    const anchor = await deploy();
    const [first, second] = [sha256("first"), sha256("second")];

    await anchor.write.anchor([first]);
    assert.notEqual(await anchor.read.anchoredAt([first]), 0n);
    assert.equal(await anchor.read.anchoredAt([second]), 0n);

    await anchor.write.anchor([second]);
    assert.notEqual(await anchor.read.anchoredAt([second]), 0n);
  });

  it("rejects a duplicate and keeps the original timestamp", async function () {
    const anchor = await deploy();
    const hash = sha256("manifest");
    const timestamp = await blockTime(await anchor.write.anchor([hash]));

    await viem.assertions.revertWithCustomErrorWithArgs(
      anchor.write.anchor([hash]),
      anchor,
      "AlreadyAnchored",
      [hash, timestamp],
    );

    assert.equal(await anchor.read.anchoredAt([hash]), timestamp);
    const events = await publicClient.getContractEvents({
      address: anchor.address,
      abi: anchor.abi,
      eventName: "Anchored",
      fromBlock: 0n,
    });
    assert.equal(events.length, 1);
  });

  it("rejects anyone but the owner, and stores nothing", async function () {
    const anchor = await deploy();
    const hash = sha256("manifest");

    await viem.assertions.revertWithCustomError(
      anchor.write.anchor([hash], { account: stranger.account }),
      anchor,
      "NotOwner",
    );
    assert.equal(await anchor.read.anchoredAt([hash]), 0n);

    // The owner can still anchor it afterwards.
    await anchor.write.anchor([hash]);
    assert.notEqual(await anchor.read.anchoredAt([hash]), 0n);
  });

  it("does not let a stranger overwrite an anchored hash", async function () {
    const anchor = await deploy();
    const hash = sha256("manifest");
    const timestamp = await blockTime(await anchor.write.anchor([hash]));

    await viem.assertions.revertWithCustomError(
      anchor.write.anchor([hash], { account: stranger.account }),
      anchor,
      "NotOwner",
    );
    assert.equal(await anchor.read.anchoredAt([hash]), timestamp);
  });

  it("rejects the zero hash", async function () {
    const anchor = await deploy();
    await viem.assertions.revertWithCustomError(
      anchor.write.anchor([ZERO_HASH]),
      anchor,
      "EmptyHash",
    );
    assert.equal(await anchor.read.anchoredAt([ZERO_HASH]), 0n);
  });

  it("lets anyone read without being the owner", async function () {
    const anchor = await deploy();
    const hash = sha256("manifest");
    const timestamp = await blockTime(await anchor.write.anchor([hash]));

    const asStranger = await viem.getContractAt(
      "SpaceProofAnchor",
      anchor.address,
      { client: { wallet: stranger } },
    );
    assert.equal(await asStranger.read.anchoredAt([hash]), timestamp);
  });

  it("exposes nothing but anchor, anchoredAt and owner", async function () {
    // No way to remove, replace or transfer: any new function must be a
    // deliberate change to this list.
    const anchor = await deploy();
    const functions = anchor.abi
      .filter((item) => item.type === "function")
      .map((item) => `${item.name}:${item.stateMutability}`)
      .sort();
    assert.deepEqual(functions, [
      "anchor:nonpayable",
      "anchoredAt:view",
      "owner:view",
    ]);
  });

  it("matches the ABI versioned for the backend (abi/SpaceProofAnchor.json)", async function () {
    const anchor = await deploy();
    const versioned: unknown = JSON.parse(
      readFileSync("abi/SpaceProofAnchor.json", "utf8"),
    );
    assert.deepEqual(versioned, anchor.abi);
  });
});
