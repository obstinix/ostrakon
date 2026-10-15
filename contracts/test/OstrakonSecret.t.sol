// SPDX-License-Identifier: BSL-1.0
pragma solidity ^0.8.24;

import {Ostrakon} from "../src/Ostrakon.sol";
import {OstrakonBase} from "./Ostrakon.t.sol";

/// Commit-reveal (secret ballot) mode.
contract SecretBallotTest is OstrakonBase {
    event VoteCommitted(uint256 indexed electionId, address indexed voter, bytes32 commitment);

    bytes32 internal constant SALT_A = keccak256("alice salt");
    bytes32 internal constant SALT_B = keccak256("bob salt");
    bytes32 internal constant SALT_C = keccak256("carol salt");

    function _secret(uint64 start, uint64 end, uint64 revealEnd) internal returns (uint256 id) {
        vm.prank(admin);
        id = o.createSecretElection("Secret", _three(), start, end, revealEnd);
    }

    function _c(uint256 id, address voter, uint256 idx, bytes32 salt) internal view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(o), id, voter, idx, salt));
    }

    function _commit(uint256 id, address voter, uint256 idx, bytes32 salt) internal {
        bytes32 c = _c(id, voter, idx, salt);
        vm.prank(voter);
        o.commitVote(id, c);
    }

    function _reveal(uint256 id, address voter, uint256 idx, bytes32 salt) internal {
        vm.prank(voter);
        o.revealVote(id, idx, salt);
    }

    /// Secret election with alice, bob, carol registered and in Voting.
    function _openSecret() internal returns (uint256 id) {
        id = _secret(0, 0, 0);
        _reg(id, alice);
        _reg(id, bob);
        _reg(id, carol);
        _advance(id);
    }

    function _ph(uint256 id) internal view returns (uint8) {
        return uint8(o.phaseOf(id));
    }

    uint8 internal constant REG = uint8(Ostrakon.Phase.Registration);
    uint8 internal constant VOTING = uint8(Ostrakon.Phase.Voting);
    uint8 internal constant REVEAL = uint8(Ostrakon.Phase.Reveal);
    uint8 internal constant ENDED = uint8(Ostrakon.Phase.Ended);

    // ---- creation and schedule

    function test_createSecretEmitsAndViews() public {
        vm.expectEmit(true, true, false, true);
        emit ElectionCreated(1, admin, "Secret", _three(), 0, 0, true, 0);
        uint256 id = _secret(0, 0, 0);
        Ostrakon.ElectionView memory v = o.getElection(id);
        assertTrue(v.secret);
        assertEq(v.revealEnd, 0);
        assertEq(v.committed, 0);
    }

    function test_openElectionIsNotSecret() public {
        uint256 id = _create();
        assertFalse(o.getElection(id).secret);
    }

    function test_secretScheduleValidation() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        vm.expectRevert(Ostrakon.InvalidSchedule.selector);
        o.createSecretElection("x", _three(), 0, 0, t + 100); // revealEnd without votingEnd
        vm.expectRevert(Ostrakon.InvalidSchedule.selector);
        o.createSecretElection("x", _three(), 0, t + 100, t + 100); // revealEnd == votingEnd
        vm.expectRevert(Ostrakon.InvalidSchedule.selector);
        o.createSecretElection("x", _three(), 0, t + 100, t + 50); // revealEnd before votingEnd
        vm.expectRevert(Ostrakon.InvalidSchedule.selector);
        o.createSecretElection("x", _three(), 0, t, t + 50); // votingEnd not in future (shared rule)
        o.createSecretElection("x", _three(), 0, t + 100, t + 200);
        o.createSecretElection("x", _three(), 0, t + 100, 0); // reveal closed by hand
        o.createSecretElection("x", _three(), 0, 0, 0); // fully manual
    }

    function test_secretSharesCandidateValidation() public {
        string[] memory c = _three();
        c[1] = c[0];
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.DuplicateCandidate.selector, 0, 1));
        o.createSecretElection("x", c, 0, 0, 0);
    }

    // ---- mode separation

    function test_openVoteRejectedOnSecret() public {
        uint256 id = _openSecret();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.SecretBallot.selector, id));
        o.vote(id, 0);
    }

    function test_commitAndRevealRejectedOnOpen() public {
        uint256 id = _open();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotSecretBallot.selector, id));
        o.commitVote(id, bytes32(uint256(1)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotSecretBallot.selector, id));
        o.revealVote(id, 0, SALT_A);
    }

    function test_openBallotSkipsReveal() public {
        uint256 id = _open();
        _advance(id);
        assertEq(_ph(id), ENDED);
    }

    // ---- phases

    function test_phasesForwardThroughReveal() public {
        uint256 id = _secret(0, 0, 0);
        assertEq(_ph(id), REG);
        _advance(id);
        assertEq(_ph(id), VOTING);
        vm.expectEmit(true, false, false, true);
        emit PhaseChanged(id, Ostrakon.Phase.Voting, Ostrakon.Phase.Reveal, false);
        _advance(id);
        assertEq(_ph(id), REVEAL);
        vm.expectEmit(true, false, false, true);
        emit PhaseChanged(id, Ostrakon.Phase.Reveal, Ostrakon.Phase.Ended, false);
        _advance(id);
        assertEq(_ph(id), ENDED);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Ended)
        );
        o.advancePhase(id);
    }

    function test_scheduledVotingEndOpensRevealThenRevealEndCloses() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint256 id = _secret(t + 100, t + 200, t + 300);
        _reg(id, alice);
        vm.warp(t + 150);
        _commit(id, alice, 2, SALT_A);
        vm.warp(t + 200);
        assertEq(_ph(id), REVEAL, "votingEnd opens Reveal");
        // admin can't end reveal early
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ScheduleNotReached.selector, t + 300));
        o.advancePhase(id);
        vm.expectEmit(true, false, false, true);
        emit PhaseChanged(id, Ostrakon.Phase.Voting, Ostrakon.Phase.Reveal, true);
        _reveal(id, alice, 2, SALT_A);
        vm.warp(t + 300);
        assertEq(_ph(id), ENDED, "revealEnd ends");
        o.finalize(id);
        assertEq(o.getElection(id).winner, 2);
    }

    function test_revealClosesExactlyAtRevealEnd() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint256 id = _secret(0, t + 200, t + 300);
        _reg(id, alice);
        _advance(id);
        _commit(id, alice, 0, SALT_A);
        vm.warp(t + 300);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Reveal, Ostrakon.Phase.Ended)
        );
        o.revealVote(id, 0, SALT_A);
    }

    function test_manualRevealCloseWhenNoRevealEnd() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint256 id = _secret(0, t + 100, 0);
        _advance(id);
        vm.warp(t + 100);
        assertEq(_ph(id), REVEAL);
        _advance(id); // syncs Voting->Reveal (by timestamp) then admin closes Reveal->Ended
        assertEq(_ph(id), ENDED);
    }

    // ---- commit

    function test_commitRecordsSealedVote() public {
        uint256 id = _openSecret();
        bytes32 c = _c(id, alice, 1, SALT_A);
        vm.expectEmit(true, true, false, true);
        emit VoteCommitted(id, alice, c);
        vm.prank(alice);
        o.commitVote(id, c);
        assertTrue(o.hasVoted(id, alice));
        assertFalse(o.hasRevealed(id, alice));
        assertEq(o.commitmentOf(id, alice), c);
        Ostrakon.ElectionView memory v = o.getElection(id);
        assertEq(v.committed, 1);
        assertEq(v.totalVotes, 0, "nothing counted before reveal");
        uint256[] memory t = o.getTallies(id);
        assertEq(t[0] + t[1] + t[2], 0, "tallies reveal nothing during Voting");
    }

    function test_commitRules() public {
        uint256 id = _secret(0, 0, 0);
        _reg(id, alice);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Registration)
        );
        o.commitVote(id, bytes32(uint256(1)));
        _advance(id);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotRegistered.selector, mallory));
        o.commitVote(id, bytes32(uint256(1)));
        vm.prank(alice);
        vm.expectRevert(Ostrakon.EmptyCommitment.selector);
        o.commitVote(id, bytes32(0));
        _commit(id, alice, 0, SALT_A);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.AlreadyVoted.selector, alice));
        o.commitVote(id, bytes32(uint256(2)));
        _advance(id); // -> Reveal
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Reveal)
        );
        o.commitVote(id, bytes32(uint256(3)));
    }

    // ---- reveal

    function test_revealCountsAndEmitsVoted() public {
        uint256 id = _openSecret();
        _commit(id, alice, 1, SALT_A);
        _advance(id);
        vm.expectEmit(true, true, false, true);
        emit Voted(id, alice, 1);
        _reveal(id, alice, 1, SALT_A);
        assertTrue(o.hasRevealed(id, alice));
        assertEq(o.getTallies(id)[1], 1);
        assertEq(o.getElection(id).totalVotes, 1);
    }

    function test_revealRules() public {
        uint256 id = _openSecret();
        _commit(id, alice, 1, SALT_A);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Reveal, Ostrakon.Phase.Voting)
        );
        o.revealVote(id, 1, SALT_A);
        _advance(id);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NothingToReveal.selector, bob));
        o.revealVote(id, 1, SALT_B);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.CommitmentMismatch.selector, alice));
        o.revealVote(id, 1, SALT_B); // wrong salt
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.CommitmentMismatch.selector, alice));
        o.revealVote(id, 2, SALT_A); // different choice than committed
        _reveal(id, alice, 1, SALT_A);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.AlreadyRevealed.selector, alice));
        o.revealVote(id, 1, SALT_A);
        _advance(id);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Reveal, Ostrakon.Phase.Ended)
        );
        o.revealVote(id, 1, SALT_A);
    }

    function test_committedInvalidIndexCannotBeCounted() public {
        uint256 id = _openSecret();
        _commit(id, alice, 9, SALT_A); // the contract can't see the choice at commit time
        _advance(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.InvalidCandidate.selector, 9, 3));
        o.revealVote(id, 9, SALT_A);
        assertEq(o.getElection(id).totalVotes, 0);
    }

    function test_copiedCommitmentCannotBeRevealedByAnotherVoter() public {
        uint256 id = _openSecret();
        bytes32 aliceC = _c(id, alice, 1, SALT_A);
        vm.prank(alice);
        o.commitVote(id, aliceC);
        vm.prank(bob);
        o.commitVote(id, aliceC); // bob copies alice's sealed vote
        _advance(id);
        _reveal(id, alice, 1, SALT_A);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.CommitmentMismatch.selector, bob));
        o.revealVote(id, 1, SALT_A); // even knowing alice's choice and salt
        assertEq(o.getElection(id).totalVotes, 1);
    }

    function test_commitmentIsBoundToElection() public {
        uint256 e1 = _openSecret();
        uint256 e2 = _openSecret();
        bytes32 forE1 = _c(e1, alice, 0, SALT_A);
        vm.prank(alice);
        o.commitVote(e2, forE1); // commitment computed for another election
        _advance(e2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.CommitmentMismatch.selector, alice));
        o.revealVote(e2, 0, SALT_A);
    }

    function test_unrevealedVotesAreNotCounted() public {
        uint256 id = _openSecret();
        _commit(id, alice, 0, SALT_A);
        _commit(id, bob, 1, SALT_B);
        _commit(id, carol, 1, SALT_C);
        _advance(id);
        _reveal(id, alice, 0, SALT_A);
        _reveal(id, bob, 1, SALT_B); // carol never reveals
        _advance(id);
        vm.expectEmit(true, false, false, true);
        emit Finalized(id, true, 0, 1, 2);
        o.finalize(id);
        Ostrakon.ElectionView memory v = o.getElection(id);
        assertEq(v.committed, 3);
        assertEq(v.totalVotes, 2);
        assertTrue(v.tie);
    }

    function test_voterStatusesIncludeRevealed() public {
        uint256 id = _openSecret();
        _commit(id, alice, 0, SALT_A);
        _advance(id);
        (bool[] memory reg, bool[] memory voted, bool[] memory revealed) = o.getVoterStatuses(alice, 0, 10);
        assertTrue(reg[0] && voted[0]);
        assertFalse(revealed[0]);
        _reveal(id, alice, 0, SALT_A);
        (,, revealed) = o.getVoterStatuses(alice, 0, 10);
        assertTrue(revealed[0]);
    }

    function test_secretViewsRevertOnMissing() public {
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 9));
        o.hasRevealed(9, alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 9));
        o.commitmentOf(9, alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 9));
        o.commitVote(9, bytes32(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 9));
        o.revealVote(9, 0, SALT_A);
    }

    // ---- fuzz

    function testFuzz_commitRevealRoundTrip(uint8 rawIdx, bytes32 salt, bytes32 wrongSalt) public {
        vm.assume(salt != wrongSalt);
        uint256 idx = bound(rawIdx, 0, 2);
        uint256 id = _openSecret();
        _commit(id, alice, idx, salt);
        _advance(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.CommitmentMismatch.selector, alice));
        o.revealVote(id, idx, wrongSalt);
        _reveal(id, alice, idx, salt);
        assertEq(o.getTallies(id)[idx], 1);
    }
}
