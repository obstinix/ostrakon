// SPDX-License-Identifier: BSL-1.0
pragma solidity ^0.8.24;

/// @title Ostrakon
/// @notice Multi-election registry with per-election admins, forward-only phases
///         (Registration -> Voting -> Ended), an address allowlist and on-chain tallies.
/// @dev    Ballots are NOT secret: the candidate index is visible in every `vote` calldata and in
///         the `Voted` event. This contract makes no external calls and holds no ether.
contract Ostrakon {
    // ------------------------------------------------------------------ types

    enum Phase {
        Registration,
        Voting,
        Ended
    }

    /// @dev Slot 0: admin(20) + votingStart(8) + storedPhase(1) + finalized(1) + tie(1) + winner(1).
    ///      Slot 1: votingEnd(8) + createdBlock(8) + totalVotes(8).
    struct Election {
        address admin;
        uint64 votingStart;
        Phase storedPhase;
        bool finalized;
        bool tie;
        uint8 winner;
        uint64 votingEnd;
        uint64 createdBlock;
        uint64 totalVotes;
        string name;
        string[] candidates;
        uint256[] tallies;
        address[] voters;
        mapping(address => bool) registered;
        mapping(address => bool) voted;
    }

    /// @notice Flat read model returned by `getElection` / `getElections`.
    struct ElectionView {
        uint256 id;
        address admin;
        string name;
        Phase phase;
        uint64 votingStart;
        uint64 votingEnd;
        uint64 createdBlock;
        uint256 candidateCount;
        uint256 voterCount;
        uint256 totalVotes;
        bool finalized;
        bool tie;
        uint8 winner;
    }

    // -------------------------------------------------------------- constants

    uint256 public constant MIN_CANDIDATES = 2;
    uint256 public constant MAX_CANDIDATES = 32;
    uint256 public constant MAX_CANDIDATE_NAME_BYTES = 64;
    uint256 public constant MAX_ELECTION_NAME_BYTES = 80;
    /// @notice Maximum addresses per `registerVoters` call. Sized so a full batch stays well under
    ///         a 30M block gas limit (see docs/SECURITY.md for the measured cost).
    uint256 public constant MAX_BATCH = 200;
    /// @notice Maximum page size for paginated views.
    uint256 public constant MAX_PAGE = 100;

    // ---------------------------------------------------------------- storage

    uint256 public electionCount;
    mapping(uint256 => Election) private _elections;

    // ----------------------------------------------------------------- events

    event ElectionCreated(
        uint256 indexed electionId,
        address indexed admin,
        string name,
        string[] candidates,
        uint64 votingStart,
        uint64 votingEnd
    );
    event VoterRegistered(uint256 indexed electionId, address indexed voter);
    event PhaseChanged(uint256 indexed electionId, Phase from, Phase to, bool byTimestamp);
    event Voted(uint256 indexed electionId, address indexed voter, uint256 candidateIndex);
    event Finalized(uint256 indexed electionId, bool tie, uint256 winner, uint256 winningVotes, uint256 totalVotes);
    event AdminTransferred(uint256 indexed electionId, address indexed previousAdmin, address indexed newAdmin);

    // ----------------------------------------------------------------- errors

    error ElectionNotFound(uint256 electionId);
    error NotAdmin(uint256 electionId, address caller);
    error WrongPhase(uint256 electionId, Phase expected, Phase actual);
    error EmptyElectionName();
    error ElectionNameTooLong(uint256 length);
    error CandidateCountOutOfRange(uint256 count);
    error EmptyCandidateName(uint256 index);
    error CandidateNameTooLong(uint256 index, uint256 length);
    error DuplicateCandidate(uint256 first, uint256 second);
    error InvalidSchedule();
    error ScheduleNotReached(uint64 at);
    error ZeroAddress();
    error AlreadyRegistered(address voter);
    error EmptyBatch();
    error BatchTooLarge(uint256 size, uint256 max);
    error NotRegistered(address voter);
    error AlreadyVoted(address voter);
    error InvalidCandidate(uint256 index, uint256 count);
    error AlreadyFinalized(uint256 electionId);
    error PageTooLarge(uint256 limit, uint256 max);

    // -------------------------------------------------------------- modifiers

    modifier exists(uint256 electionId) {
        if (electionId == 0 || electionId > electionCount) revert ElectionNotFound(electionId);
        _;
    }

    modifier onlyAdmin(uint256 electionId) {
        if (_elections[electionId].admin != msg.sender) revert NotAdmin(electionId, msg.sender);
        _;
    }

    // ------------------------------------------------------- admin functions

    /// @notice Create an election. The caller becomes its admin. Candidates are fixed forever.
    /// @param name        Election name, 1..80 bytes.
    /// @param candidates  2..32 unique, non-empty names of at most 64 bytes each (compared byte-exact).
    /// @param votingStart Optional unix time (0 = unset) at which Voting opens automatically.
    ///                    When set, the admin cannot open voting earlier.
    /// @param votingEnd   Optional unix time (0 = unset) at which the election ends automatically.
    ///                    When set, the admin cannot end voting earlier. Must be in the future and
    ///                    after `votingStart` if both are set.
    /// @return electionId The new election's id (ids start at 1).
    function createElection(string calldata name, string[] calldata candidates, uint64 votingStart, uint64 votingEnd)
        external
        returns (uint256 electionId)
    {
        uint256 nameLen = bytes(name).length;
        if (nameLen == 0) revert EmptyElectionName();
        if (nameLen > MAX_ELECTION_NAME_BYTES) revert ElectionNameTooLong(nameLen);

        uint256 n = candidates.length;
        if (n < MIN_CANDIDATES || n > MAX_CANDIDATES) revert CandidateCountOutOfRange(n);

        bytes32[] memory hashes = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            uint256 len = bytes(candidates[i]).length;
            if (len == 0) revert EmptyCandidateName(i);
            if (len > MAX_CANDIDATE_NAME_BYTES) revert CandidateNameTooLong(i, len);
            bytes32 h = keccak256(bytes(candidates[i]));
            for (uint256 j = 0; j < i; ++j) {
                if (hashes[j] == h) revert DuplicateCandidate(j, i);
            }
            hashes[i] = h;
        }

        if (votingEnd != 0) {
            if (votingEnd <= block.timestamp) revert InvalidSchedule();
            if (votingStart != 0 && votingStart >= votingEnd) revert InvalidSchedule();
        }

        electionId = ++electionCount;
        Election storage e = _elections[electionId];
        e.admin = msg.sender;
        e.name = name;
        e.votingStart = votingStart;
        e.votingEnd = votingEnd;
        // forge-lint: disable-next-line(unsafe-typecast) block numbers fit in 64 bits for ~10^11 years at 1 block/s
        e.createdBlock = uint64(block.number);
        for (uint256 i = 0; i < n; ++i) {
            e.candidates.push(candidates[i]);
        }
        e.tallies = new uint256[](n);

        emit ElectionCreated(electionId, msg.sender, name, candidates, votingStart, votingEnd);
    }

    /// @notice Register one voter. Admin only, Registration phase only.
    /// @dev Reverts on zero address or an already-registered voter.
    function registerVoter(uint256 electionId, address voter) external exists(electionId) onlyAdmin(electionId) {
        Election storage e = _elections[electionId];
        _requirePhase(electionId, e, Phase.Registration);
        if (voter == address(0)) revert ZeroAddress();
        if (e.registered[voter]) revert AlreadyRegistered(voter);
        _register(electionId, e, voter);
    }

    /// @notice Register up to `MAX_BATCH` voters. Admin only, Registration phase only.
    /// @dev Zero addresses, duplicates inside the batch and already-registered voters are skipped
    ///      silently; one `VoterRegistered` event is emitted per newly registered address.
    /// @return added Number of addresses actually registered.
    function registerVoters(uint256 electionId, address[] calldata voters)
        external
        exists(electionId)
        onlyAdmin(electionId)
        returns (uint256 added)
    {
        uint256 n = voters.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge(n, MAX_BATCH);
        Election storage e = _elections[electionId];
        _requirePhase(electionId, e, Phase.Registration);
        for (uint256 i = 0; i < n; ++i) {
            address v = voters[i];
            if (v == address(0) || e.registered[v]) continue;
            _register(electionId, e, v);
            ++added;
        }
    }

    /// @notice Move the election one phase forward. Admin only.
    /// @dev If a schedule timestamp is set for the target phase, it must already have passed; if it
    ///      has passed, the phase has already moved (lazily) and this call just records it.
    function advancePhase(uint256 electionId) external exists(electionId) onlyAdmin(electionId) {
        Election storage e = _elections[electionId];
        _syncPhase(electionId, e);
        Phase p = e.storedPhase;
        if (p == Phase.Ended) revert WrongPhase(electionId, Phase.Voting, Phase.Ended);
        if (p == Phase.Registration) {
            // votingStart passed would already have synced to Voting, so here it is either unset or future.
            if (e.votingStart != 0) revert ScheduleNotReached(e.votingStart);
            _setPhase(electionId, e, Phase.Voting, false);
        } else {
            if (e.votingEnd != 0) revert ScheduleNotReached(e.votingEnd);
            _setPhase(electionId, e, Phase.Ended, false);
        }
    }

    /// @notice Hand the admin role for one election to another address. Admin only.
    function transferAdmin(uint256 electionId, address newAdmin) external exists(electionId) onlyAdmin(electionId) {
        if (newAdmin == address(0)) revert ZeroAddress();
        Election storage e = _elections[electionId];
        address prev = e.admin;
        e.admin = newAdmin;
        emit AdminTransferred(electionId, prev, newAdmin);
    }

    // ------------------------------------------------------ public functions

    /// @notice Cast one vote. Caller must be registered, not have voted, and the election must be
    ///         in the Voting phase (manually or by schedule).
    /// @dev No external calls. Not secret: `candidateIndex` is public in calldata and the event.
    function vote(uint256 electionId, uint256 candidateIndex) external exists(electionId) {
        Election storage e = _elections[electionId];
        _requirePhase(electionId, e, Phase.Voting);
        if (!e.registered[msg.sender]) revert NotRegistered(msg.sender);
        if (e.voted[msg.sender]) revert AlreadyVoted(msg.sender);
        uint256 n = e.tallies.length;
        if (candidateIndex >= n) revert InvalidCandidate(candidateIndex, n);

        e.voted[msg.sender] = true;
        unchecked {
            // Bounded by voter count (< 2^64 in practice: each voter costs >40k gas to register).
            e.tallies[candidateIndex] += 1;
            e.totalVotes += 1;
        }
        emit Voted(electionId, msg.sender, candidateIndex);
    }

    /// @notice Compute and record the result. Anyone may call once the election has Ended.
    /// @dev `winner` is the lowest index with the top tally; `tie` is true when more than one
    ///      candidate shares the top tally (including the zero-vote case).
    function finalize(uint256 electionId) external exists(electionId) {
        Election storage e = _elections[electionId];
        _requirePhase(electionId, e, Phase.Ended);
        if (e.finalized) revert AlreadyFinalized(electionId);

        uint256 n = e.tallies.length;
        uint256 best = 0;
        uint256 bestIdx = 0;
        bool tie = false;
        for (uint256 i = 0; i < n; ++i) {
            uint256 t = e.tallies[i];
            if (t > best || i == 0) {
                best = t;
                bestIdx = i;
                tie = false;
            } else if (t == best) {
                tie = true;
            }
        }
        e.finalized = true;
        e.tie = tie;
        // forge-lint: disable-next-line(unsafe-typecast) bestIdx < MAX_CANDIDATES (32)
        e.winner = uint8(bestIdx);
        emit Finalized(electionId, tie, bestIdx, best, e.totalVotes);
    }

    /// @notice Record a schedule-driven phase change on chain (emits `PhaseChanged`). Anyone may call.
    /// @dev Purely bookkeeping: reads already report the effective phase without this.
    function syncPhase(uint256 electionId) external exists(electionId) {
        _syncPhase(electionId, _elections[electionId]);
    }

    // ----------------------------------------------------------------- views

    /// @notice The effective phase: the later of the stored phase and the schedule.
    function phaseOf(uint256 electionId) external view exists(electionId) returns (Phase) {
        return _effectivePhase(_elections[electionId]);
    }

    /// @notice Summary of one election.
    function getElection(uint256 electionId) external view exists(electionId) returns (ElectionView memory) {
        return _view(electionId);
    }

    /// @notice Summaries of elections `offset+1 .. offset+limit` (ids are 1-based; `offset` is 0-based).
    function getElections(uint256 offset, uint256 limit) external view returns (ElectionView[] memory out) {
        if (limit > MAX_PAGE) revert PageTooLarge(limit, MAX_PAGE);
        uint256 total = electionCount;
        if (offset >= total) return new ElectionView[](0);
        uint256 end = offset + limit > total ? total : offset + limit;
        out = new ElectionView[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            out[i - offset] = _view(i + 1);
        }
    }

    /// @notice `voter`'s registration and voting status for elections `offset+1 .. offset+limit`,
    ///         aligned with `getElections(offset, limit)`. Lets a UI show per-election status in one call.
    function getVoterStatuses(address voter, uint256 offset, uint256 limit)
        external
        view
        returns (bool[] memory registered, bool[] memory voted)
    {
        if (limit > MAX_PAGE) revert PageTooLarge(limit, MAX_PAGE);
        uint256 total = electionCount;
        if (offset >= total) return (new bool[](0), new bool[](0));
        uint256 end = offset + limit > total ? total : offset + limit;
        registered = new bool[](end - offset);
        voted = new bool[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            Election storage e = _elections[i + 1];
            registered[i - offset] = e.registered[voter];
            voted[i - offset] = e.voted[voter];
        }
    }

    /// @notice Candidate names, in index order.
    function getCandidates(uint256 electionId) external view exists(electionId) returns (string[] memory) {
        return _elections[electionId].candidates;
    }

    /// @notice All tallies in one call, aligned with `getCandidates`.
    function getTallies(uint256 electionId) external view exists(electionId) returns (uint256[] memory) {
        return _elections[electionId].tallies;
    }

    /// @notice Whether `voter` is on the election's allowlist.
    function isRegistered(uint256 electionId, address voter) external view exists(electionId) returns (bool) {
        return _elections[electionId].registered[voter];
    }

    /// @notice Whether `voter` has cast a vote in the election.
    function hasVoted(uint256 electionId, address voter) external view exists(electionId) returns (bool) {
        return _elections[electionId].voted[voter];
    }

    /// @notice Number of registered voters.
    function voterCount(uint256 electionId) external view exists(electionId) returns (uint256) {
        return _elections[electionId].voters.length;
    }

    /// @notice Registered voters `offset .. offset+limit-1` in registration order.
    /// @dev Public by design: the same list is derivable from `VoterRegistered` events.
    function getVoters(uint256 electionId, uint256 offset, uint256 limit)
        external
        view
        exists(electionId)
        returns (address[] memory out)
    {
        if (limit > MAX_PAGE) revert PageTooLarge(limit, MAX_PAGE);
        address[] storage all = _elections[electionId].voters;
        uint256 total = all.length;
        if (offset >= total) return new address[](0);
        uint256 end = offset + limit > total ? total : offset + limit;
        out = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            out[i - offset] = all[i];
        }
    }

    // -------------------------------------------------------------- internal

    function _register(uint256 electionId, Election storage e, address voter) private {
        e.registered[voter] = true;
        e.voters.push(voter);
        emit VoterRegistered(electionId, voter);
    }

    function _effectivePhase(Election storage e) private view returns (Phase) {
        Phase p = e.storedPhase;
        if (p == Phase.Ended) return p;
        uint64 end = e.votingEnd;
        if (end != 0 && block.timestamp >= end) return Phase.Ended;
        if (p == Phase.Voting) return p;
        uint64 start = e.votingStart;
        if (start != 0 && block.timestamp >= start) return Phase.Voting;
        return p;
    }

    /// @dev Reverts unless the effective phase is `expected`; records a lagging stored phase first.
    function _requirePhase(uint256 electionId, Election storage e, Phase expected) private {
        Phase actual = _syncPhase(electionId, e);
        if (actual != expected) revert WrongPhase(electionId, expected, actual);
    }

    function _syncPhase(uint256 electionId, Election storage e) private returns (Phase eff) {
        eff = _effectivePhase(e);
        if (eff != e.storedPhase) _setPhase(electionId, e, eff, true);
    }

    function _setPhase(uint256 electionId, Election storage e, Phase to, bool byTimestamp) private {
        Phase from = e.storedPhase;
        e.storedPhase = to;
        emit PhaseChanged(electionId, from, to, byTimestamp);
    }

    function _view(uint256 id) private view returns (ElectionView memory v) {
        Election storage e = _elections[id];
        v.id = id;
        v.admin = e.admin;
        v.name = e.name;
        v.phase = _effectivePhase(e);
        v.votingStart = e.votingStart;
        v.votingEnd = e.votingEnd;
        v.createdBlock = e.createdBlock;
        v.candidateCount = e.candidates.length;
        v.voterCount = e.voters.length;
        v.totalVotes = e.totalVotes;
        v.finalized = e.finalized;
        v.tie = e.tie;
        v.winner = e.winner;
    }
}
