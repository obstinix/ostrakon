// SPDX-License-Identifier: BSL-1.0
pragma solidity ^0.8.24;

import {Ostrakon} from "../src/Ostrakon.sol";
import {OstrakonBase} from "./Ostrakon.t.sol";

/// Builds OpenZeppelin-compatible Merkle trees (sorted-pair keccak, double-hashed address leaves)
/// in memory, so tests can produce roots and proofs for any electorate size.
abstract contract MerkleHelper {
    function _leaf(address a) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(a))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// Root and proof for `leaves[index]`. Odd nodes are carried up unchanged.
    function _rootAndProof(bytes32[] memory leaves, uint256 index)
        internal
        pure
        returns (bytes32 root, bytes32[] memory proof)
    {
        bytes32[] memory level = leaves;
        bytes32[] memory tmp = new bytes32[](64);
        uint256 depth = 0;
        uint256 idx = index;
        while (level.length > 1) {
            uint256 sib = idx ^ 1;
            if (sib < level.length) tmp[depth++] = level[sib];
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i = 0; i < level.length; i += 2) {
                next[i / 2] = i + 1 < level.length ? _hashPair(level[i], level[i + 1]) : level[i];
            }
            level = next;
            idx /= 2;
        }
        root = level[0];
        proof = new bytes32[](depth);
        for (uint256 i = 0; i < depth; ++i) {
            proof[i] = tmp[i];
        }
    }
}

contract AllowlistTest is OstrakonBase, MerkleHelper {
    event AllowlistSet(uint256 indexed electionId, bytes32 root, string uri);
    event AdminTransferStarted(uint256 indexed electionId, address indexed admin, address indexed pendingAdmin);

    address[] internal listed;
    bytes32[] internal leaves;

    function setUp() public override {
        super.setUp();
        listed.push(alice);
        listed.push(bob);
        listed.push(carol);
        listed.push(makeAddr("dave"));
        listed.push(makeAddr("erin"));
        for (uint256 i = 0; i < listed.length; ++i) {
            leaves.push(_leaf(listed[i]));
        }
    }

    function _root() internal view returns (bytes32 r) {
        (r,) = _rootAndProof(leaves, 0);
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory p) {
        (, p) = _rootAndProof(leaves, i);
    }

    function _withList(bool secret) internal returns (uint256 id) {
        vm.startPrank(admin);
        id = secret ? o.createSecretElection("Big", _three(), 0, 0, 0) : o.createElection("Big", _three(), 0, 0);
        o.setAllowlist(id, _root(), "ipfs://tree.json");
        vm.stopPrank();
    }

    // ---- setting the root

    function test_setAllowlistStoresAndEmits() public {
        uint256 id = _create();
        bytes32 r = _root();
        vm.expectEmit(true, false, false, true);
        emit AllowlistSet(id, r, "https://example.org/tree.json");
        vm.prank(admin);
        o.setAllowlist(id, r, "https://example.org/tree.json");
        (bytes32 root, string memory uri) = o.getAllowlist(id);
        assertEq(root, r);
        assertEq(uri, "https://example.org/tree.json");
        assertEq(o.getElection(id).allowlistRoot, r);
    }

    function test_setAllowlistRules() public {
        uint256 id = _create();
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotAdmin.selector, id, mallory));
        o.setAllowlist(id, bytes32(uint256(1)), "");
        bytes memory long = new bytes(257);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.UriTooLong.selector, 257));
        o.setAllowlist(id, bytes32(uint256(1)), string(long));
        _advance(id);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Registration, Ostrakon.Phase.Voting)
        );
        o.setAllowlist(id, bytes32(uint256(1)), ""); // frozen once voting opens
    }

    function test_rootCanBeReplacedAndClearedDuringRegistration() public {
        uint256 id = _withList(false);
        vm.prank(admin);
        o.setAllowlist(id, bytes32(0), "");
        bytes32[] memory p = _proof(0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NoAllowlist.selector, id));
        o.registerWithProof(id, p);
    }

    // ---- claiming

    function test_registerWithProofInRegistrationAndVoting() public {
        uint256 id = _withList(false);
        bytes32[] memory p0 = _proof(0);
        vm.expectEmit(true, true, false, true);
        emit VoterRegistered(id, alice);
        vm.prank(alice);
        o.registerWithProof(id, p0);
        assertTrue(o.isRegistered(id, alice));
        _advance(id);
        bytes32[] memory p1 = _proof(1);
        vm.prank(bob);
        o.registerWithProof(id, p1); // still allowed while Voting
        assertEq(o.voterCount(id), 2);
        _advance(id);
        bytes32[] memory p2 = _proof(2);
        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Ended)
        );
        o.registerWithProof(id, p2);
    }

    function test_badProofsRejected() public {
        uint256 id = _withList(false);
        bytes32[] memory aliceProof = _proof(0);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotOnAllowlist.selector, mallory));
        o.registerWithProof(id, aliceProof); // someone else's proof
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotOnAllowlist.selector, bob));
        o.registerWithProof(id, aliceProof); // proof for a different leaf
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotOnAllowlist.selector, alice));
        o.registerWithProof(id, new bytes32[](0));
        vm.prank(alice);
        o.registerWithProof(id, aliceProof);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.AlreadyRegistered.selector, alice));
        o.registerWithProof(id, aliceProof);
    }

    function test_noAllowlist() public {
        uint256 id = _create();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NoAllowlist.selector, id));
        o.registerWithProof(id, new bytes32[](0));
    }

    function test_voteWithProofRegistersAndVotesOnce() public {
        uint256 id = _withList(false);
        _advance(id);
        bytes32[] memory p = _proof(3);
        address dave = listed[3];
        vm.expectEmit(true, true, false, true);
        emit Voted(id, dave, 2);
        vm.prank(dave);
        o.voteWithProof(id, 2, p);
        assertTrue(o.isRegistered(id, dave));
        assertEq(o.getTallies(id)[2], 1);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.AlreadyVoted.selector, dave));
        o.voteWithProof(id, 2, p);
    }

    function test_voteWithProofForAlreadyRegisteredIgnoresProof() public {
        uint256 id = _withList(false);
        _reg(id, mallory); // explicitly registered, not on the list
        _advance(id);
        vm.prank(mallory);
        o.voteWithProof(id, 0, new bytes32[](0));
        assertEq(o.getTallies(id)[0], 1);
    }

    function test_voteWithProofRules() public {
        uint256 id = _withList(false);
        bytes32[] memory p = _proof(0);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Registration)
        );
        o.voteWithProof(id, 0, p);
        _advance(id);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotOnAllowlist.selector, mallory));
        o.voteWithProof(id, 0, p);
        uint256 sid = _withList(true);
        _advance(sid);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.SecretBallot.selector, sid));
        o.voteWithProof(sid, 0, p);
    }

    function test_commitVoteWithProof() public {
        uint256 id = _withList(true);
        _advance(id);
        bytes32[] memory p = _proof(1);
        bytes32 c = keccak256(abi.encode(block.chainid, address(o), id, bob, uint256(1), bytes32("s")));
        vm.prank(bob);
        o.commitVoteWithProof(id, c, p);
        assertTrue(o.isRegistered(id, bob));
        assertEq(o.commitmentOf(id, bob), c);
        _advance(id);
        vm.prank(bob);
        o.revealVote(id, 1, bytes32("s"));
        assertEq(o.getTallies(id)[1], 1);
        // open ballots reject the secret path
        uint256 oid = _withList(false);
        _advance(oid);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotSecretBallot.selector, oid));
        o.commitVoteWithProof(oid, c, p);
    }

    function test_commitVoteWithProofRegisteredSkipsProof() public {
        uint256 id = _withList(true);
        _reg(id, mallory);
        _advance(id);
        vm.prank(mallory);
        o.commitVoteWithProof(id, bytes32(uint256(7)), new bytes32[](0));
        assertTrue(o.hasVoted(id, mallory));
    }

    function test_commitVoteWithProofWrongPhase() public {
        uint256 id = _withList(true);
        bytes32[] memory p = _proof(1);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Registration)
        );
        o.commitVoteWithProof(id, bytes32(uint256(1)), p);
    }

    function test_getAllowlistOnMissing() public {
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 9));
        o.getAllowlist(9);
    }

    /// Any member of a large electorate can claim with their proof; any non-member can't with any member's proof.
    function testFuzz_largeElectorate(uint16 rawSize, uint16 rawIndex, address outsider) public {
        uint256 size = bound(rawSize, 2, 2000);
        uint256 index = bound(rawIndex, 0, size - 1);
        bytes32[] memory ls = new bytes32[](size);
        for (uint256 i = 0; i < size; ++i) {
            ls[i] = _leaf(address(uint160(0x10000 + i)));
        }
        vm.assume(uint160(outsider) < 0x10000 || uint160(outsider) >= 0x10000 + size);
        (bytes32 root, bytes32[] memory proof) = _rootAndProof(ls, index);
        vm.startPrank(admin);
        uint256 id = o.createElection("Large", _three(), 0, 0);
        o.setAllowlist(id, root, "");
        o.advancePhase(id);
        vm.stopPrank();
        address member = address(uint160(0x10000 + index));
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotOnAllowlist.selector, outsider));
        o.voteWithProof(id, 0, proof);
        vm.prank(member);
        o.voteWithProof(id, 1, proof);
        assertEq(o.getTallies(id)[1], 1);
        assertEq(o.voterCount(id), 1);
    }
}

contract TwoStepAdminTest is OstrakonBase {
    event AdminTransferStarted(uint256 indexed electionId, address indexed admin, address indexed pendingAdmin);

    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _create();
    }

    function test_nominationEmitsAndKeepsAdmin() public {
        vm.expectEmit(true, true, true, true);
        emit AdminTransferStarted(id, admin, alice);
        vm.prank(admin);
        o.transferAdmin(id, alice);
        assertEq(o.getElection(id).admin, admin);
        _advance(id); // old admin still acts
    }

    function test_onlyNomineeCanAccept() public {
        vm.prank(admin);
        o.transferAdmin(id, alice);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotPendingAdmin.selector, id, mallory));
        o.acceptAdmin(id);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotPendingAdmin.selector, id, admin));
        o.acceptAdmin(id);
    }

    function test_acceptWithoutNomination() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotPendingAdmin.selector, id, alice));
        o.acceptAdmin(id);
    }

    function test_renominationReplaces() public {
        vm.startPrank(admin);
        o.transferAdmin(id, alice);
        o.transferAdmin(id, bob);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotPendingAdmin.selector, id, alice));
        o.acceptAdmin(id);
        vm.prank(bob);
        o.acceptAdmin(id);
        assertEq(o.getElection(id).admin, bob);
    }

    function test_cancel() public {
        vm.prank(admin);
        o.transferAdmin(id, alice);
        vm.expectEmit(true, true, true, true);
        emit AdminTransferStarted(id, admin, address(0));
        vm.prank(admin);
        o.cancelAdminTransfer(id);
        assertEq(o.getElection(id).pendingAdmin, address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotPendingAdmin.selector, id, alice));
        o.acceptAdmin(id);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NoPendingAdmin.selector, id));
        o.cancelAdminTransfer(id);
    }

    function test_cancelOnlyAdmin() public {
        vm.prank(admin);
        o.transferAdmin(id, alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotAdmin.selector, id, alice));
        o.cancelAdminTransfer(id);
    }

    function test_newAdminCanHandOnAndOldCannot() public {
        vm.prank(admin);
        o.transferAdmin(id, alice);
        vm.prank(alice);
        o.acceptAdmin(id);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotAdmin.selector, id, admin));
        o.transferAdmin(id, admin);
        vm.prank(alice);
        o.transferAdmin(id, bob);
        vm.prank(bob);
        o.acceptAdmin(id);
        assertEq(o.getElection(id).admin, bob);
    }

    function test_twoStepFunctionsOnMissingElection() public {
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 9));
        o.acceptAdmin(9);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 9));
        o.cancelAdminTransfer(9);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 9));
        o.registerWithProof(9, new bytes32[](0));
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 9));
        o.voteWithProof(9, 0, new bytes32[](0));
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 9));
        o.commitVoteWithProof(9, bytes32(uint256(1)), new bytes32[](0));
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 9));
        o.setAllowlist(9, bytes32(0), "");
    }
}
