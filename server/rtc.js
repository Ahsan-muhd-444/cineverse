/**
 * Server-side validation for relayed WebRTC signalling.
 *
 * The server stays a pure relay — it never touches media — but it must not blindly
 * forward whatever a client sends. This bounds the payload and rejects unknown
 * shapes so a member can't use the signalling channel to blast large or malformed
 * data at another member. Pure and dependency-free for unit testing.
 */

const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice']);

// An SDP offer/answer is a few KB; an ICE candidate is tiny. 64KB is generous
// headroom for large SDPs (many codecs/candidates) while still being three
// orders of magnitude below the 12MB socket buffer used for chat attachments.
const MAX_SIGNAL_BYTES = 64 * 1024;

/**
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function validateRtcSignal(data, maxBytes = MAX_SIGNAL_BYTES) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'BAD_SIGNAL' };
  if (!SIGNAL_TYPES.has(data.type)) return { ok: false, error: 'BAD_TYPE' };

  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(data));
  } catch {
    // Circular / non-serialisable payloads are never valid signalling.
    return { ok: false, error: 'BAD_SIGNAL' };
  }
  if (size > maxBytes) return { ok: false, error: 'TOO_LARGE' };

  if (data.type === 'offer' || data.type === 'answer') {
    if (!data.sdp || typeof data.sdp !== 'object') return { ok: false, error: 'BAD_SIGNAL' };
    if (typeof data.sdp.sdp !== 'string') return { ok: false, error: 'BAD_SIGNAL' };
  }
  if (data.type === 'ice') {
    // Candidate is an RTCIceCandidateInit object (the empty-candidate end marker
    // is filtered client-side, so a real object is expected here).
    if (!data.candidate || typeof data.candidate !== 'object') return { ok: false, error: 'BAD_SIGNAL' };
  }

  return { ok: true };
}

module.exports = { validateRtcSignal, SIGNAL_TYPES, MAX_SIGNAL_BYTES };
