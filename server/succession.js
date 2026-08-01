/**
 * Who takes over when someone leaves.
 *
 * Extracted from `finalizeRemoval` so the rule can be asserted deterministically
 * instead of only through a timing-sensitive end-to-end check. The E2E test that
 * guards this ("a lobby member is never promoted to host") waits on a broadcast
 * driven by the reconnect-grace timer, so under load it can read a stale
 * snapshot and fail for reasons that have nothing to do with the rule itself.
 * The rule is pure; it should be tested as such.
 *
 * Behaviour is unchanged — this is a move, not a redesign.
 */

/**
 * The next host after `leavingId` departs.
 *
 * Two invariants, both load-bearing:
 *
 *  - Only APPROVED MEMBERS are candidates. Lobby entries live in `room.lobby`,
 *    never in `room.members`, so a guest waiting for approval is structurally
 *    incapable of inheriting the room. That is the security property: a hostless
 *    room must not hand its controls to someone nobody let in.
 *  - A CONNECTED member is preferred. Someone inside their reconnect grace still
 *    holds a seat but has no transport, so promoting them would leave the room
 *    with a host who cannot act. If everyone left is mid-grace we still promote
 *    the longest-standing one rather than leaving the room hostless.
 *
 * Ties break by join order, so succession is deterministic: every observer
 * computes the same answer from the same room.
 *
 * @param {{members: Map<string, {id:string, joinedAt:number, connected?:boolean}>}} room
 * @param {string} [leavingId] member being removed, if they are still present
 * @returns {string|null} the new host's member id, or null if nobody remains
 */
function chooseSuccessor(room, leavingId) {
  const candidates = [...room.members.values()]
    .filter((m) => m && m.id !== leavingId)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  if (candidates.length === 0) return null;
  const connected = candidates.find((m) => m.connected !== false);
  return (connected || candidates[0]).id;
}

module.exports = { chooseSuccessor };
