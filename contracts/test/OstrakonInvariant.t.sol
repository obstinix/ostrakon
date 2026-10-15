// SPDX-License-Identifier: BSL-1.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ostrakon} from "../src/Ostrakon.sol";

/// Drives random but well-formed sequences of calls against three elections (open/manual,
/// open/scheduled, secret/manual) and records ghost state that the invariants compare with the
/// contract.
contract Handler is Test {
    uint256 public constant N = 3;
    uint256 public constant SECRET = 2; // index into ids

    Ostrakon public immutable o;
    address public immutable admin;
    uint256[3] public ids;
    address[] public actors;

    mapping(uint256 => mapping(address => uint256)) public ghostVotes;
    mapping(uint256 => uint256) public ghostTotal;
    mapping(uint256 => uint8) public lastPhase;
    bool public phaseWentBackwards;
    bool public finalizedBeforeEnded;

    // secret ballot ghosts
    mapping(address => uint256) public ghostCommits;
    mapping(address => uint256) public ghostReveals;
    mapping(address => uint256) public ghostChoice;
    bool public tamperedRevealAccepted;

    constructor(Ostrakon o_, address admin_, uint256[3] memory ids_) {
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
        return ids[seed % N];
    }

    function _salt(address who) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", who));
    }

    function _checkPhases() internal {
        for (uint256 k = 0; k < N; ++k) {
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

    function commit(uint256 actorSeed, uint256 candidate) external {
        uint256 id = ids[SECRET];
        address who = actors[actorSeed % actors.length];
        candidate = bound(candidate, 0, 3); // includes one invalid index
        bytes32 c = keccak256(abi.encode(block.chainid, address(o), id, who, candidate, _salt(who)));
        vm.prank(who);
        try o.commitVote(id, c) {
            ghostCommits[who] += 1;
            ghostChoice[who] = candidate;
        } catch {}
        _checkPhases();
    }

    function reveal(uint256 actorSeed, bool tamper) external {
        uint256 id = ids[SECRET];
        address who = actors[actorSeed % actors.length];
        bytes32 salt = tamper ? keccak256(abi.encode("wrong", who)) : _salt(who);
        vm.prank(who);
        try o.revealVote(id, ghostChoice[who], salt) {
            if (tamper) tamperedRevealAccepted = true;
            ghostReveals[who] += 1;
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
    uint256[3] internal ids;

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
        ids[2] = o.createSecretElection("Secret", c, 0, 0, 0);
        vm.stopPrank();
        h = new Handler(o, admin, ids);
        targetContract(address(h));
    }

    /// Sum of candidate tallies always equals total votes, which equals successful vote/reveal calls.
    function invariant_talliesSumToTotal() public view {
        for (uint256 k = 0; k < 3; ++k) {
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

    /// No address can ever vote twice in an open ballot, and hasVoted agrees with history.
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

    /// Secret ballot: one commitment and at most one reveal per voter; every counted vote was
    /// committed by a registered voter; a reveal with the wrong salt is never accepted; counted
    /// votes never exceed commitments.
    function invariant_secretBallot() public view {
        uint256 id = ids[2];
        uint256 n = h.actorCount();
        for (uint256 i = 0; i < n; ++i) {
            address a = h.actors(i);
            uint256 c = h.ghostCommits(a);
            uint256 r = h.ghostReveals(a);
            assertLe(c, 1, "committed at most once");
            assertLe(r, c, "revealed only what was committed");
            assertEq(o.hasVoted(id, a), c == 1, "hasVoted == committed");
            assertEq(o.hasRevealed(id, a), r == 1, "hasRevealed matches");
            if (c == 1) assertTrue(o.isRegistered(id, a), "only registered voters committed");
        }
        Ostrakon.ElectionView memory v = o.getElection(id);
        assertLe(v.totalVotes, v.committed, "counted <= committed");
        assertLe(v.committed, v.voterCount, "committed <= registered");
        assertFalse(h.tamperedRevealAccepted(), "reveal with wrong salt accepted");
        assertEq(o.getElection(ids[0]).committed, 0, "open ballots never record commitments");
    }

    /// The effective phase never moves backwards; open ballots never enter Reveal.
    function invariant_phaseMonotonic() public view {
        assertFalse(h.phaseWentBackwards(), "phase went backwards");
        assertTrue(o.phaseOf(ids[0]) != Ostrakon.Phase.Reveal, "open ballot in Reveal");
        assertTrue(o.phaseOf(ids[1]) != Ostrakon.Phase.Reveal, "open ballot in Reveal");
    }

    /// Finalization only ever happens after Ended, and a finalized election stays Ended.
    function invariant_finalizeOnlyWhenEnded() public view {
        assertFalse(h.finalizedBeforeEnded(), "finalized before Ended");
        for (uint256 k = 0; k < 3; ++k) {
            Ostrakon.ElectionView memory v = o.getElection(ids[k]);
            if (v.finalized) assertEq(uint8(v.phase), uint8(Ostrakon.Phase.Ended));
        }
    }
}
