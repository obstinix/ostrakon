// SPDX-License-Identifier: BSL-1.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ostrakon} from "../src/Ostrakon.sol";

contract OstrakonBase is Test {
    Ostrakon internal o;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal mallory = makeAddr("mallory");

    event ElectionCreated(
        uint256 indexed electionId,
        address indexed admin,
        string name,
        string[] candidates,
        uint64 votingStart,
        uint64 votingEnd,
        bool secret,
        uint64 revealEnd
    );
    event VoterRegistered(uint256 indexed electionId, address indexed voter);
    event PhaseChanged(uint256 indexed electionId, Ostrakon.Phase from, Ostrakon.Phase to, bool byTimestamp);
    event Voted(uint256 indexed electionId, address indexed voter, uint256 candidateIndex);
    event Finalized(uint256 indexed electionId, bool tie, uint256 winner, uint256 winningVotes, uint256 totalVotes);
    event AdminTransferred(uint256 indexed electionId, address indexed previousAdmin, address indexed newAdmin);

    function setUp() public virtual {
        o = new Ostrakon();
        vm.warp(1_700_000_000);
    }

    function _three() internal pure returns (string[] memory c) {
        c = new string[](3);
        c[0] = "Ananya Kulkarni";
        c[1] = "Rahul Deshmukh";
        c[2] = "Sneha Jadhav";
    }

    function _names(uint256 n) internal pure returns (string[] memory c) {
        c = new string[](n);
        for (uint256 i = 0; i < n; ++i) {
            c[i] = string.concat("C", vm.toString(i));
        }
    }

    function _create() internal returns (uint256 id) {
        vm.prank(admin);
        id = o.createElection("Class Rep", _three(), 0, 0);
    }

    function _createScheduled(uint64 start, uint64 end) internal returns (uint256 id) {
        vm.prank(admin);
        id = o.createElection("Scheduled", _three(), start, end);
    }

    function _reg(uint256 id, address v) internal {
        vm.prank(admin);
        o.registerVoter(id, v);
    }

    function _advance(uint256 id) internal {
        vm.prank(admin);
        o.advancePhase(id);
    }

    function _vote(uint256 id, address v, uint256 c) internal {
        vm.prank(v);
        o.vote(id, c);
    }

    /// Election with alice, bob, carol registered and in Voting.
    function _open() internal returns (uint256 id) {
        id = _create();
        _reg(id, alice);
        _reg(id, bob);
        _reg(id, carol);
        _advance(id);
    }

    function _phase(uint256 id) internal view returns (Ostrakon.Phase) {
        return o.phaseOf(id);
    }
}

/// Twelve core voting scenarios, end to end.
contract ReportScenariosTest is OstrakonBase {
    // 1. Admin creates an election with three candidates -> ids 0,1,2; ElectionCreated emitted.
    function test_R01_createWithThreeCandidates() public {
        vm.expectEmit(true, true, false, true);
        emit ElectionCreated(1, admin, "Class Rep", _three(), 0, 0, false, 0);
        uint256 id = _create();
        assertEq(id, 1);
        string[] memory c = o.getCandidates(id);
        assertEq(c.length, 3);
        assertEq(c[0], "Ananya Kulkarni");
        assertEq(c[2], "Sneha Jadhav");
        assertEq(o.getTallies(id).length, 3);
    }

    // 2. Non-admin calls an admin function -> reverts NotAdmin.
    //    (Creating is now open to anyone; each creator administers only their own election.)
    function test_R02_nonAdminCannotRegister() public {
        uint256 id = _create();
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotAdmin.selector, id, mallory));
        o.registerVoter(id, mallory);
    }

    // 3. Empty candidate list -> reverts (now: fewer than 2 candidates).
    function test_R03_emptyCandidateListReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.CandidateCountOutOfRange.selector, 0));
        o.createElection("x", new string[](0), 0, 0);
    }

    // 4. Admin registers a voter -> registered, event, appears in voter list.
    function test_R04_registerVoter() public {
        uint256 id = _create();
        vm.expectEmit(true, true, false, true);
        emit VoterRegistered(id, alice);
        _reg(id, alice);
        assertTrue(o.isRegistered(id, alice));
        address[] memory vs = o.getVoters(id, 0, 10);
        assertEq(vs.length, 1);
        assertEq(vs[0], alice);
    }

    // 5. Same voter registered twice -> reverts AlreadyRegistered.
    function test_R05_doubleRegistrationReverts() public {
        uint256 id = _create();
        _reg(id, alice);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.AlreadyRegistered.selector, alice));
        o.registerVoter(id, alice);
    }

    // 6. Bulk registration with a repeated address -> stored once.
    function test_R06_bulkSkipsRepeat() public {
        uint256 id = _create();
        address[] memory b = new address[](3);
        b[0] = alice;
        b[1] = bob;
        b[2] = alice;
        vm.prank(admin);
        uint256 added = o.registerVoters(id, b);
        assertEq(added, 2);
        assertEq(o.voterCount(id), 2);
    }

    // 7. Registered voter votes once -> tally +1, Voted emitted.
    function test_R07_voteOnce() public {
        uint256 id = _open();
        vm.expectEmit(true, true, false, true);
        emit Voted(id, alice, 1);
        _vote(id, alice, 1);
        assertEq(o.getTallies(id)[1], 1);
        assertTrue(o.hasVoted(id, alice));
    }

    // 8. Same voter votes again -> reverts AlreadyVoted; counts unchanged.
    function test_R08_doubleVoteReverts() public {
        uint256 id = _open();
        _vote(id, alice, 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.AlreadyVoted.selector, alice));
        o.vote(id, 0);
        uint256[] memory t = o.getTallies(id);
        assertEq(t[0], 0);
        assertEq(t[1], 1);
    }

    // 9. Unregistered address votes -> reverts NotRegistered.
    function test_R09_unregisteredVoteReverts() public {
        uint256 id = _open();
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotRegistered.selector, mallory));
        o.vote(id, 0);
    }

    // 10. Vote for a non-existent candidate index -> reverts InvalidCandidate.
    function test_R10_invalidCandidateReverts() public {
        uint256 id = _open();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.InvalidCandidate.selector, 3, 3));
        o.vote(id, 3);
    }

    // 11. Vote / register on a non-existent election -> reverts ElectionNotFound.
    function test_R11_nonexistentElectionReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 7));
        o.vote(7, 0);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 7));
        o.registerVoter(7, alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 0));
        o.getElection(0);
    }

    // 12. Voter registered only for election 1 votes in election 2 -> NotRegistered.
    function test_R12_registrationIsPerElection() public {
        uint256 e1 = _open();
        uint256 e2 = _create();
        _advance(e2);
        assertTrue(o.isRegistered(e1, alice));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotRegistered.selector, alice));
        o.vote(e2, 0);
    }
}

contract CreateValidationTest is OstrakonBase {
    function test_emptyName() public {
        vm.expectRevert(Ostrakon.EmptyElectionName.selector);
        o.createElection("", _three(), 0, 0);
    }

    function test_nameLengthBoundary() public {
        bytes memory n80 = new bytes(80);
        for (uint256 i = 0; i < 80; ++i) {
            n80[i] = "a";
        }
        o.createElection(string(n80), _three(), 0, 0);
        bytes memory n81 = bytes.concat(n80, "a");
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNameTooLong.selector, 81));
        o.createElection(string(n81), _three(), 0, 0);
    }

    function test_candidateCountBounds() public {
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.CandidateCountOutOfRange.selector, 1));
        o.createElection("x", _names(1), 0, 0);
        o.createElection("x", _names(2), 0, 0);
        o.createElection("x", _names(32), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.CandidateCountOutOfRange.selector, 33));
        o.createElection("x", _names(33), 0, 0);
    }

    function test_emptyCandidateName() public {
        string[] memory c = _three();
        c[1] = "";
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.EmptyCandidateName.selector, 1));
        o.createElection("x", c, 0, 0);
    }

    function test_candidateNameLengthBoundary() public {
        bytes memory n64 = new bytes(64);
        for (uint256 i = 0; i < 64; ++i) {
            n64[i] = "b";
        }
        string[] memory c = _three();
        c[2] = string(n64);
        o.createElection("x", c, 0, 0);
        c[2] = string(bytes.concat(n64, "b"));
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.CandidateNameTooLong.selector, 2, 65));
        o.createElection("x", c, 0, 0);
    }

    function test_duplicateCandidate() public {
        string[] memory c = _three();
        c[2] = c[0];
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.DuplicateCandidate.selector, 0, 2));
        o.createElection("x", c, 0, 0);
    }

    function test_duplicateIsByteExact() public {
        string[] memory c = new string[](2);
        c[0] = "Sneha";
        c[1] = "sneha";
        o.createElection("x", c, 0, 0); // case differs -> distinct (documented)
    }

    function test_scheduleValidation() public {
        uint64 nowTs = uint64(block.timestamp);
        vm.expectRevert(Ostrakon.InvalidSchedule.selector);
        o.createElection("x", _three(), 0, nowTs); // end not in future
        vm.expectRevert(Ostrakon.InvalidSchedule.selector);
        o.createElection("x", _three(), nowTs + 100, nowTs + 100); // start == end
        vm.expectRevert(Ostrakon.InvalidSchedule.selector);
        o.createElection("x", _three(), nowTs + 200, nowTs + 100); // start > end
        o.createElection("x", _three(), nowTs + 100, nowTs + 200);
        o.createElection("x", _three(), nowTs + 100, 0); // start only
        o.createElection("x", _three(), 0, nowTs + 100); // end only
    }

    function test_anyoneCanCreateAndBecomesAdmin() public {
        vm.prank(mallory);
        uint256 id = o.createElection("Mine", _three(), 0, 0);
        Ostrakon.ElectionView memory v = o.getElection(id);
        assertEq(v.admin, mallory);
        assertEq(v.createdBlock, block.number);
        assertEq(uint8(v.phase), uint8(Ostrakon.Phase.Registration));
    }

    function test_idsIncrement() public {
        assertEq(_create(), 1);
        assertEq(_create(), 2);
        assertEq(o.electionCount(), 2);
    }
}

contract PhaseTest is OstrakonBase {
    function test_registrationToVotingToEnded() public {
        uint256 id = _create();
        assertEq(uint8(_phase(id)), 0);
        vm.expectEmit(true, false, false, true);
        emit PhaseChanged(id, Ostrakon.Phase.Registration, Ostrakon.Phase.Voting, false);
        _advance(id);
        assertEq(uint8(_phase(id)), 1);
        vm.expectEmit(true, false, false, true);
        emit PhaseChanged(id, Ostrakon.Phase.Voting, Ostrakon.Phase.Ended, false);
        _advance(id);
        assertEq(uint8(_phase(id)), uint8(Ostrakon.Phase.Ended));
    }

    function test_cannotAdvancePastEnded() public {
        uint256 id = _create();
        _advance(id);
        _advance(id);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Ended)
        );
        o.advancePhase(id);
    }

    function test_registerOnlyInRegistration() public {
        uint256 id = _create();
        _advance(id);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Registration, Ostrakon.Phase.Voting)
        );
        o.registerVoter(id, alice);
        address[] memory b = new address[](1);
        b[0] = alice;
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Registration, Ostrakon.Phase.Voting)
        );
        o.registerVoters(id, b);
        _advance(id);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Registration, Ostrakon.Phase.Ended)
        );
        o.registerVoter(id, alice);
    }

    function test_voteOnlyInVoting() public {
        uint256 id = _create();
        _reg(id, alice);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Registration)
        );
        o.vote(id, 0);
        _advance(id);
        _advance(id);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Ended)
        );
        o.vote(id, 0);
    }

    function test_finalizeOnlyWhenEnded() public {
        uint256 id = _create();
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Ended, Ostrakon.Phase.Registration)
        );
        o.finalize(id);
        _advance(id);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Ended, Ostrakon.Phase.Voting)
        );
        o.finalize(id);
    }

    // ---- timestamp windows

    function test_scheduledStartOpensVotingAutomatically() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint256 id = _createScheduled(t + 100, t + 200);
        _reg(id, alice);
        assertEq(uint8(_phase(id)), 0);
        vm.warp(t + 99);
        assertEq(uint8(_phase(id)), 0);
        vm.warp(t + 100);
        assertEq(uint8(_phase(id)), 1, "effective phase flips at votingStart");
        vm.expectEmit(true, false, false, true);
        emit PhaseChanged(id, Ostrakon.Phase.Registration, Ostrakon.Phase.Voting, true);
        _vote(id, alice, 0);
        assertEq(o.getTallies(id)[0], 1);
    }

    function test_scheduledStartBlocksEarlyManualAdvance() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint256 id = _createScheduled(t + 100, 0);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ScheduleNotReached.selector, t + 100));
        o.advancePhase(id);
    }

    function test_scheduledEndBlocksEarlyManualEnd() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint256 id = _createScheduled(0, t + 500);
        _advance(id); // manual open allowed (no start set)
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ScheduleNotReached.selector, t + 500));
        o.advancePhase(id);
    }

    function test_scheduledEndClosesVoting() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint256 id = _createScheduled(t + 100, t + 200);
        _reg(id, alice);
        _reg(id, bob);
        vm.warp(t + 150);
        _vote(id, alice, 2);
        vm.warp(t + 199);
        assertEq(uint8(_phase(id)), 1);
        vm.warp(t + 200);
        assertEq(uint8(_phase(id)), uint8(Ostrakon.Phase.Ended), "ends exactly at votingEnd");
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Ended)
        );
        o.vote(id, 0);
        o.finalize(id);
        Ostrakon.ElectionView memory v = o.getElection(id);
        assertTrue(v.finalized);
        assertEq(v.winner, 2);
    }

    function test_registrationClosesAtScheduledStart() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint256 id = _createScheduled(t + 100, 0);
        vm.warp(t + 100);
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Registration, Ostrakon.Phase.Voting)
        );
        o.registerVoter(id, alice);
    }

    function test_jumpFromRegistrationToEndedBySchedule() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint256 id = _createScheduled(0, t + 50);
        vm.warp(t + 60);
        assertEq(uint8(_phase(id)), uint8(Ostrakon.Phase.Ended));
        vm.expectEmit(true, false, false, true);
        emit PhaseChanged(id, Ostrakon.Phase.Registration, Ostrakon.Phase.Ended, true);
        o.syncPhase(id);
        // advancing now is illegal
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Ended)
        );
        o.advancePhase(id);
    }

    function test_advanceAfterScheduleJustRecords() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint256 id = _createScheduled(t + 10, t + 20);
        vm.warp(t + 10);
        // Lazy sync records Voting, then advance tries Voting->Ended but votingEnd not reached.
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ScheduleNotReached.selector, t + 20));
        o.advancePhase(id);
        assertEq(uint8(_phase(id)), 1);
    }

    function test_syncPhaseNoopEmitsNothing() public {
        uint256 id = _create();
        vm.recordLogs();
        o.syncPhase(id);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_manualThenScheduleNeverGoesBack() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint256 id = _createScheduled(0, t + 100);
        _advance(id);
        assertEq(uint8(_phase(id)), 1);
        vm.warp(t + 1000);
        assertEq(uint8(_phase(id)), uint8(Ostrakon.Phase.Ended));
    }
}

contract BatchTest is OstrakonBase {
    function _addrs(uint256 n, uint256 seed) internal pure returns (address[] memory a) {
        a = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            a[i] = address(uint160(uint256(keccak256(abi.encode(seed, i)))));
        }
    }

    function test_emptyBatchReverts() public {
        uint256 id = _create();
        vm.prank(admin);
        vm.expectRevert(Ostrakon.EmptyBatch.selector);
        o.registerVoters(id, new address[](0));
    }

    function test_batchAtCap() public {
        uint256 id = _create();
        address[] memory a = _addrs(o.MAX_BATCH(), 1);
        vm.prank(admin);
        uint256 added = o.registerVoters(id, a);
        assertEq(added, 200);
        assertEq(o.voterCount(id), 200);
    }

    function test_batchOverCapReverts() public {
        uint256 id = _create();
        address[] memory a = _addrs(201, 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.BatchTooLarge.selector, 201, 200));
        o.registerVoters(id, a);
    }

    function test_batchSkipsZeroAndAlreadyRegistered() public {
        uint256 id = _create();
        _reg(id, alice);
        address[] memory b = new address[](4);
        b[0] = address(0);
        b[1] = alice;
        b[2] = bob;
        b[3] = bob;
        vm.recordLogs();
        vm.prank(admin);
        uint256 added = o.registerVoters(id, b);
        assertEq(added, 1);
        assertEq(vm.getRecordedLogs().length, 1, "one VoterRegistered");
        assertEq(o.voterCount(id), 2);
        assertFalse(o.isRegistered(id, address(0)));
    }

    function test_batchAllDuplicatesAddsNothing() public {
        uint256 id = _create();
        _reg(id, alice);
        address[] memory b = new address[](2);
        b[0] = alice;
        b[1] = alice;
        vm.prank(admin);
        assertEq(o.registerVoters(id, b), 0);
        assertEq(o.voterCount(id), 1);
    }

    function test_singleRejectsZero() public {
        uint256 id = _create();
        vm.prank(admin);
        vm.expectRevert(Ostrakon.ZeroAddress.selector);
        o.registerVoter(id, address(0));
    }

    function test_votersPagination() public {
        uint256 id = _create();
        address[] memory a = _addrs(25, 9);
        vm.prank(admin);
        o.registerVoters(id, a);
        address[] memory p0 = o.getVoters(id, 0, 10);
        address[] memory p2 = o.getVoters(id, 20, 10);
        address[] memory p3 = o.getVoters(id, 30, 10);
        assertEq(p0.length, 10);
        assertEq(p0[0], a[0]);
        assertEq(p2.length, 5);
        assertEq(p2[4], a[24]);
        assertEq(p3.length, 0);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.PageTooLarge.selector, 101, 100));
        o.getVoters(id, 0, 101);
    }

    function testFuzz_batchCountsUnique(uint8 n, uint8 dupEvery) public {
        uint256 id = _create();
        uint256 size = bound(n, 1, 200);
        uint256 every = bound(dupEvery, 1, 10);
        address[] memory a = new address[](size);
        uint256 unique;
        for (uint256 i = 0; i < size; ++i) {
            if (i > 0 && i % every == 0) {
                a[i] = a[i - 1];
            } else {
                a[i] = address(uint160(1000 + i));
                ++unique;
            }
        }
        vm.prank(admin);
        assertEq(o.registerVoters(id, a), unique);
        assertEq(o.voterCount(id), unique);
    }
}

contract FinalizeTest is OstrakonBase {
    function test_winner() public {
        uint256 id = _open();
        _vote(id, alice, 1);
        _vote(id, bob, 1);
        _vote(id, carol, 0);
        _advance(id);
        vm.expectEmit(true, false, false, true);
        emit Finalized(id, false, 1, 2, 3);
        vm.prank(mallory); // anyone can finalize
        o.finalize(id);
        Ostrakon.ElectionView memory v = o.getElection(id);
        assertTrue(v.finalized);
        assertFalse(v.tie);
        assertEq(v.winner, 1);
        assertEq(v.totalVotes, 3);
    }

    function test_tie() public {
        uint256 id = _open();
        _vote(id, alice, 0);
        _vote(id, bob, 2);
        _advance(id);
        vm.expectEmit(true, false, false, true);
        emit Finalized(id, true, 0, 1, 2);
        o.finalize(id);
        assertTrue(o.getElection(id).tie);
    }

    function test_tieBrokenByLaterHigher() public {
        // tallies [1,1,2] -> no tie, winner 2
        address[] memory v = new address[](4);
        v[0] = alice;
        v[1] = bob;
        v[2] = carol;
        v[3] = mallory;
        uint256 id = _create();
        vm.prank(admin);
        o.registerVoters(id, v);
        _advance(id);
        _vote(id, alice, 0);
        _vote(id, bob, 1);
        _vote(id, carol, 2);
        _vote(id, mallory, 2);
        _advance(id);
        o.finalize(id);
        Ostrakon.ElectionView memory e = o.getElection(id);
        assertFalse(e.tie);
        assertEq(e.winner, 2);
    }

    function test_noVotesIsTie() public {
        uint256 id = _open();
        _advance(id);
        o.finalize(id);
        Ostrakon.ElectionView memory v = o.getElection(id);
        assertTrue(v.tie);
        assertEq(v.totalVotes, 0);
    }

    function test_doubleFinalizeReverts() public {
        uint256 id = _open();
        _advance(id);
        o.finalize(id);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.AlreadyFinalized.selector, id));
        o.finalize(id);
    }

    function testFuzz_finalizeMatchesArgmax(uint8[6] memory picks) public {
        uint256 id;
        {
            address[] memory v = new address[](6);
            for (uint256 i = 0; i < 6; ++i) {
                v[i] = address(uint160(0xA000 + i));
            }
            id = _create();
            vm.prank(admin);
            o.registerVoters(id, v);
            _advance(id);
            for (uint256 i = 0; i < 6; ++i) {
                _vote(id, v[i], picks[i] % 3);
            }
        }
        _advance(id);
        o.finalize(id);
        uint256[] memory t = o.getTallies(id);
        uint256 best = t[0];
        uint256 idx = 0;
        uint256 count = 1;
        for (uint256 i = 1; i < 3; ++i) {
            if (t[i] > best) {
                best = t[i];
                idx = i;
                count = 1;
            } else if (t[i] == best) {
                ++count;
            }
        }
        Ostrakon.ElectionView memory e = o.getElection(id);
        assertEq(e.winner, idx);
        assertEq(e.tie, count > 1);
    }
}

contract AccessControlTest is OstrakonBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _create();
    }

    function test_registerVoter_onlyAdmin() public {
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotAdmin.selector, id, mallory));
        o.registerVoter(id, alice);
    }

    function test_registerVoters_onlyAdmin() public {
        address[] memory b = new address[](1);
        b[0] = alice;
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotAdmin.selector, id, mallory));
        o.registerVoters(id, b);
    }

    function test_advancePhase_onlyAdmin() public {
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotAdmin.selector, id, mallory));
        o.advancePhase(id);
    }

    function test_transferAdmin_onlyAdmin() public {
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotAdmin.selector, id, mallory));
        o.transferAdmin(id, mallory);
    }

    function test_adminOfOneIsNotAdminOfAnother() public {
        vm.prank(mallory);
        uint256 other = o.createElection("Other", _three(), 0, 0);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotAdmin.selector, other, admin));
        o.advancePhase(other);
    }

    function test_transferAdmin() public {
        vm.expectEmit(true, true, true, true);
        emit AdminTransferred(id, admin, alice);
        vm.prank(admin);
        o.transferAdmin(id, alice);
        assertEq(o.getElection(id).admin, alice);
        // old admin lost rights, new admin has them
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotAdmin.selector, id, admin));
        o.advancePhase(id);
        vm.prank(alice);
        o.advancePhase(id);
    }

    function test_transferAdminToZeroReverts() public {
        vm.prank(admin);
        vm.expectRevert(Ostrakon.ZeroAddress.selector);
        o.transferAdmin(id, address(0));
    }

    function test_adminFunctionsOnMissingElection() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 99));
        o.advancePhase(99);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 99));
        o.transferAdmin(99, alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 99));
        o.registerVoters(99, new address[](1));
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 99));
        o.finalize(99);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 99));
        o.syncPhase(99);
    }
}

contract ViewsTest is OstrakonBase {
    function test_getElectionsPagination() public {
        for (uint256 i = 0; i < 5; ++i) {
            _create();
        }
        Ostrakon.ElectionView[] memory p = o.getElections(0, 3);
        assertEq(p.length, 3);
        assertEq(p[0].id, 1);
        assertEq(p[2].id, 3);
        p = o.getElections(3, 10);
        assertEq(p.length, 2);
        assertEq(p[1].id, 5);
        assertEq(o.getElections(5, 10).length, 0);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.PageTooLarge.selector, 101, 100));
        o.getElections(0, 101);
    }

    function test_getVoterStatuses() public {
        uint256 e1 = _open(); // alice registered
        uint256 e2 = _create(); // alice not registered
        _vote(e1, alice, 0);
        assertEq(e2, 2);
        (bool[] memory reg, bool[] memory voted,) = o.getVoterStatuses(alice, 0, 10);
        assertEq(reg.length, 2);
        assertTrue(reg[0]);
        assertTrue(voted[0]);
        assertFalse(reg[1]);
        assertFalse(voted[1]);
        (reg, voted,) = o.getVoterStatuses(alice, 1, 10);
        assertEq(reg.length, 1);
        assertFalse(reg[0]);
        (reg, voted,) = o.getVoterStatuses(alice, 0, 1);
        assertEq(reg.length, 1);
        assertTrue(voted[0]);
        (reg, voted,) = o.getVoterStatuses(alice, 2, 10);
        assertEq(reg.length, 0);
        assertEq(voted.length, 0);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.PageTooLarge.selector, 101, 100));
        o.getVoterStatuses(alice, 0, 101);
    }

    function test_summaryReflectsState() public {
        uint256 id = _open();
        _vote(id, alice, 2);
        Ostrakon.ElectionView memory v = o.getElection(id);
        assertEq(v.name, "Class Rep");
        assertEq(v.candidateCount, 3);
        assertEq(v.voterCount, 3);
        assertEq(v.totalVotes, 1);
        assertEq(uint8(v.phase), 1);
        assertFalse(v.finalized);
    }

    function test_viewsRevertOnMissing() public {
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 1));
        o.getTallies(1);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 1));
        o.getCandidates(1);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 1));
        o.isRegistered(1, alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 1));
        o.hasVoted(1, alice);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 1));
        o.voterCount(1);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 1));
        o.phaseOf(1);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.ElectionNotFound.selector, 1));
        o.getVoters(1, 0, 1);
    }
}

contract VoteFuzzTest is OstrakonBase {
    function testFuzz_voteAnyCandidateIndex(uint256 idx) public {
        uint256 id = _open();
        vm.prank(alice);
        if (idx >= 3) {
            vm.expectRevert(abi.encodeWithSelector(Ostrakon.InvalidCandidate.selector, idx, 3));
            o.vote(id, idx);
            assertFalse(o.hasVoted(id, alice));
        } else {
            o.vote(id, idx);
            assertEq(o.getTallies(id)[idx], 1);
        }
    }

    function testFuzz_strangerCannotVote(address who) public {
        vm.assume(who != alice && who != bob && who != carol);
        uint256 id = _open();
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(Ostrakon.NotRegistered.selector, who));
        o.vote(id, 0);
    }

    function testFuzz_nameLengths(uint8 len) public {
        bytes memory b = new bytes(len);
        for (uint256 i = 0; i < len; ++i) {
            b[i] = "z";
        }
        string[] memory c = _three();
        c[0] = string(b);
        if (len == 0) {
            vm.expectRevert(abi.encodeWithSelector(Ostrakon.EmptyCandidateName.selector, 0));
        } else if (len > 64) {
            vm.expectRevert(abi.encodeWithSelector(Ostrakon.CandidateNameTooLong.selector, 0, uint256(len)));
        }
        o.createElection("x", c, 0, 0);
    }

    function testFuzz_scheduleWindow(uint32 startOff, uint32 len, uint32 at) public {
        uint64 t = uint64(vm.getBlockTimestamp());
        uint64 start = t + 1 + uint64(startOff);
        uint64 end = start + 1 + uint64(len);
        uint256 id = _createScheduled(start, end);
        _reg(id, alice);
        uint64 when = t + uint64(at);
        vm.warp(when);
        vm.prank(alice);
        if (when < start) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Registration
                )
            );
        } else if (when >= end) {
            vm.expectRevert(
                abi.encodeWithSelector(Ostrakon.WrongPhase.selector, id, Ostrakon.Phase.Voting, Ostrakon.Phase.Ended)
            );
        }
        o.vote(id, 1);
    }
}
