// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title SpaceProofAnchor
/// @notice Public, append-only registry of SpaceProof certificate hashes.
/// @dev A certificate hash is the SHA-256 of a certificate's canonical
/// manifest, as 32 bytes. Only hashes are stored: no file, no metadata, no
/// personal data. The registry says that the owner registered a hash and
/// when; it says nothing about where a file comes from or who made it.
///
/// Deliberately minimal: no upgradeability, no ownership transfer and no way
/// to remove or change an entry.
contract SpaceProofAnchor {
    /// @notice The only account that can anchor: the one that deployed the
    /// contract (the SpaceProof backend wallet). It can never change.
    address public immutable owner;

    /// @notice Block timestamp (seconds since the Unix epoch) at which a hash
    /// was anchored, or 0 if it never was.
    mapping(bytes32 hash => uint64 timestamp) public anchoredAt;

    /// @notice Emitted once per hash, when it is anchored.
    event Anchored(bytes32 indexed hash, uint64 timestamp);

    error NotOwner();
    error EmptyHash();
    error AlreadyAnchored(bytes32 hash, uint64 anchoredAt);

    constructor() {
        owner = msg.sender;
    }

    /// @notice Registers a certificate hash with the current block timestamp.
    /// @dev Reverts if the caller is not the owner, if the hash is zero or if
    /// the hash is already anchored: an entry is written once and never again.
    function anchor(bytes32 hash) external {
        if (msg.sender != owner) revert NotOwner();
        if (hash == bytes32(0)) revert EmptyHash();
        uint64 existing = anchoredAt[hash];
        if (existing != 0) revert AlreadyAnchored(hash, existing);

        uint64 timestamp = uint64(block.timestamp);
        anchoredAt[hash] = timestamp;
        emit Anchored(hash, timestamp);
    }
}
