// SPDX-License-Identifier: BSL-1.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ostrakon} from "../src/Ostrakon.sol";

/// Drives random but well-formed sequences of calls against two elections (one manual, one
/// scheduled) and records ghost state that the invariants compare with the contract.
contract Handler is Test {
    Ostrakon public immutable o;
    address public immutable admin;
    uint256[2] public ids;
    address[] public actors;

    mapping(uint256 => mapping(address => uint256)) public ghostVotes;
    mapping(uint256 => uint256) public ghostTotal;
    mapping(uint256 => uint8) public lastPhase;
    bool public phaseWentBackwards;
    bool public finalizedBeforeEnded;

    constructor(Ostrakon o_, address admin_, uint256[2] memory ids_) {
        o = o_;
        admin = admin_;
        ids = ids_;
        for (uint256 i = 0; i < 8; ++i) {
            actors.push(address(uint160(0xBEEF00 + i)));
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _id(uint256 seed) internal view returns (uint256) {
        return ids[seed % 2];
    }

    function _checkPhases() internal {
        for (uint256 k = 0; k < 2; ++k) {
            uint8 p = uint8(o.phaseOf(ids[k]));
            if (p < lastPhase[ids[k]]) phaseWentBackwards = true;
            lastPhase[ids[k]] = p;
        }
    }

    function register(uint256 seed, uint256 actorSeed) external {
        uint256 id = _id(seed);
        address[] memory batch = new address[](3);
        for (uint256 i = 0; i < 3; ++i) {
            batch[i] = actors[(actorSeed + i * 3) % actors.length];
        }
        vm.prank(admin);
        try o.registerVoters(id, batch) {} catch {}
        _checkPhases();
    }

    function advance(uint256 seed) external {
        vm.prank(admin);
        try o.advancePhase(_id(seed)) {} catch {}
        _checkPhases();
    }

    function vote(uint256 seed, uint256 actorSeed, uint256 candidate) external {
        uint256 id = _id(seed);
        address who = actors[actorSeed % actors.length];
        candidate = bound(candidate, 0, 3); // includes one invalid index
        vm.prank(who);
        try o.vote(id, candidate) {
            ghostVotes[id][who] += 1;
            ghostTotal[id] += 1;
        } catch {}
        _checkPhases();
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 3 days));
        _checkPhases();
    }

    function finalize(uint256 seed) external {
        uint256 id = _id(seed);
        uint8 before = uint8(o.phaseOf(id));
        try o.finalize(id) {
            if (before != uint8(Ostrakon.Phase.Ended)) finalizedBeforeEnded = true;
        } catch {}
        _checkPhases();
    }
}

contract OstrakonInvariantTest is Test {
    Ostrakon internal o;
    Handler internal h;
    uint256[2] internal ids;

    function setUp() public {
        vm.warp(1_700_000_000);
        o = new Ostrakon();
        address admin = makeAddr("admin");
        string[] memory c = new string[](3);
        c[0] = "A";
        c[1] = "B";
        c[2] = "C";
        vm.startPrank(admin);
        ids[0] = o.createElection("Manual", c, 0, 0);
        ids[1] = o.createElection("Scheduled", c, uint64(block.timestamp + 1 days), uint64(block.timestamp + 3 days));
        vm.stopPrank();
        h = new Handler(o, admin, ids);
        targetContract(address(h));
    }

    /// Sum of candidate tallies always equals total votes, which equals successful vote calls.
    function invariant_talliesSumToTotal() public view {
        for (uint256 k = 0; k < 2; ++k) {
            uint256[] memory t = o.getTallies(ids[k]);
            uint256 sum;
            for (uint256 i = 0; i < t.length; ++i) {
                sum += t[i];
            }
            Ostrakon.ElectionView memory v = o.getElection(ids[k]);
            assertEq(sum, v.totalVotes, "sum(tallies) == totalVotes");
            assertEq(v.totalVotes, h.ghostTotal(ids[k]), "totalVotes == successful votes");
            assertLe(v.totalVotes, v.voterCount, "totalVotes <= voterCount");
        }
    }

    /// No address can ever vote twice, and hasVoted agrees with history.
    function invariant_noDoubleVote() public view {
        uint256 n = h.actorCount();
        for (uint256 k = 0; k < 2; ++k) {
            for (uint256 i = 0; i < n; ++i) {
                address a = h.actors(i);
                uint256 g = h.ghostVotes(ids[k], a);
                assertLe(g, 1, "voted at most once");
                assertEq(o.hasVoted(ids[k], a), g == 1, "hasVoted matches");
                if (g == 1) assertTrue(o.isRegistered(ids[k], a), "only registered voters voted");
            }
        }
    }

    /// The effective phase never moves backwards.
    function invariant_phaseMonotonic() public view {
        assertFalse(h.phaseWentBackwards(), "phase went backwards");
    }

    /// Finalization only ever happens after Ended, and a finalized election stays Ended.
    function invariant_finalizeOnlyWhenEnded() public view {
        assertFalse(h.finalizedBeforeEnded(), "finalized before Ended");
        for (uint256 k = 0; k < 2; ++k) {
            Ostrakon.ElectionView memory v = o.getElection(ids[k]);
            if (v.finalized) assertEq(uint8(v.phase), uint8(Ostrakon.Phase.Ended));
        }
    }
}
