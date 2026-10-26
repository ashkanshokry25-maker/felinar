// Every constant of the calls lane (docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md section 3.5, "SZ 3.5") in one
// place. "chosen" marks a design parameter a gate row (G-CL-1 to G-CL-9) confirms or tunes; "measured" marks a number
// from the loopback lab (docs/research/labs/c2-calls-lab, Chromium 156 and WebKit 27.2); "arithmetic" a derived number.
// Nothing in src/calls reads src/loader/config.js: the loader passes overrides through the service deps.
//
// Shared code: Node >= 22 and browsers, no imports.

/** The site setting that turns calls on (`_mw.cfg.calls`; default 'off'). */
export const CALLS_ON = 'contacts';

/**
 * Behaviour that ships only after its gate rows pass (SZ section 4 P0, 3.1.10; MF-63, like STRING_FLAGS in
 * src/loader/strings.js). phoneNotes: the call state names 'call.ios' or 'call.android' (what a phone does to a call in
 * the background) only once G-PS-1 to G-PS-4 and G-CL-2 have run; until then `platform` is null on every device and
 * the panel keeps to "Keep this page open during the call." (code review v0.3).
 */
export const CALL_FLAGS = Object.seal({ phoneNotes: false });
export function setCallFlag(name, value) {
  if (!Object.prototype.hasOwnProperty.call(CALL_FLAGS, name)) throw new TypeError('unknown call flag ' + name);
  CALL_FLAGS[name] = value === true;
}

// ---------------------------------------------------------------------------------------------
// Signalling body (SZ 3.5 "Signalling"): JSON inside a SIG frame (0x0B, plaintext kind sig = 5, sealed with K_pair)
// ---------------------------------------------------------------------------------------------

export const SIG_VERSION = 1;
export const SIG_KINDS = Object.freeze(['ring', 'accept', 'decline', 'busy', 'offer', 'answer', 'ice', 'hangup', 'leave']);
export const CALL_ID_BYTES = 16;
/** The whole JSON body, UTF-8 bytes. With the 32-byte plaintext header it fits the 16,000-byte bucket (arithmetic). */
export const PAYLOAD_MAX = 15000;
/** One SDP, UTF-8 bytes (an offer with audio, two video slots and a data channel was 5,734 to 7,135 bytes, measured). */
export const SDP_MAX = 14000;
export const FINGERPRINT_ATTR = 'a=fingerprint:sha-256';
/** Candidates per ice message and the bytes of one candidate string. */
export const CAND_MAX = 16;
export const CAND_BYTES_MAX = 512;
/** Other participants a roster names (a mesh of 6 minus oneself, arithmetic). */
export const ROSTER_MAX = 5;
export const GROUP_ID_MAX = 64;
/** |now - t| for an accepted body. */
export const T_SKEW_MS = 60000;
/** Duplicates are dropped by (call, seq); a seq more than this far below the sender's highest is dropped (chosen). */
export const SEQ_WINDOW = 256;
export const GUARD_CALLS_MAX = 512;

// ---------------------------------------------------------------------------------------------
// Rings, caps and listen sets (SZ 3.5 "Scope" and "Signalling"; chosen, SZ-4)
// ---------------------------------------------------------------------------------------------

export const RING_TTL_MS = 45000;
export const RINGS_PER_HOUR = 10;
export const RING_WINDOW_MS = 3600000;
export const RINGS_PENDING_PER_CONTACT = 1;
/** Participants including oneself. */
export const CAP_AUDIO = 6;
export const CAP_VIDEO = 4;
/** A roster member who is not a contact may send SIG for at most this long (R 2.7.8; chosen). */
export const LISTEN_MAX_MS = 2 * 3600000;
/** Calls that ended are remembered this long, so late messages for them get a hangup and nothing else (chosen). */
export const ENDED_KEEP_MS = 600000;
export const ENDED_MAX = 64;

// ---------------------------------------------------------------------------------------------
// The in-call control channel (SZ 3.5 "Flow"): a negotiated data channel, id 0, label 'mw-call', JSON messages
// ---------------------------------------------------------------------------------------------

export const CONTROL_ID = 0;
export const CONTROL_LABEL = 'mw-call';
export const CONTROL_MAX = 16384;
export const CONTROL_TYPES = Object.freeze(['state', 'roster', 'leave', 'desc', 'cand']);
/** Chat-key records a roster message may carry for its members (src/chat/limits.js CK_MAX each). */
export const ROSTER_CK_MAX = 5;

// ---------------------------------------------------------------------------------------------
// Timing (chosen)
// ---------------------------------------------------------------------------------------------

/** Own candidates are sent in batches: after 100 ms or at 16. */
export const CAND_BATCH_MS = 100;
/** An offer sent over SIG is sent again after 4 s without an answer, at most 3 times. */
export const OFFER_RETRY_MS = 4000;
export const OFFER_RETRIES = 3;
/** An offer from a roster member that the caller has not named yet waits this long. */
export const PENDING_OFFER_MS = 10000;
/** Received candidates kept per pair before its remote description is set. */
export const PENDING_CAND_MAX = 64;
/** A pair that has not connected after 30 s fails ("call.noPath"). */
export const CONNECT_TIMEOUT_MS = 30000;
/** A leaver's pairs close within 5 s (SZ 3.5). */
export const LEAVE_CLOSE_MS = 5000;
/** A pair that stays disconnected this long gets an ICE restart; one that does not recover in 15 s more closes. */
export const RESTART_AFTER_MS = 3000;
export const RECONNECT_MS = 15000;

// ---------------------------------------------------------------------------------------------
// Media and adaptation (SZ 3.5 "Media and adaptation"; per stream, chosen; 32,000 bit/s audio is the measured default)
// ---------------------------------------------------------------------------------------------

export const AUDIO_BPS = 32000;
export const AUDIO_METERED_BPS = 24000;
export const VIDEO_WIDTH = 640;
export const VIDEO_HEIGHT = 360;
export const VIDEO_FPS = 30;
/** Camera video by class: one = a call of two, mesh = three or more. */
export const VIDEO_BPS = Object.freeze({
  desktop: Object.freeze({ one: 800000, mesh: 400000 }),
  phone: Object.freeze({ one: 500000, mesh: 300000 }),
  metered: Object.freeze({ one: 300000, mesh: 300000 }),
});
/** On a metered network video runs scaled down by 2. */
export const METERED_VIDEO_SCALE = 2;
export const SCREEN_BPS = Object.freeze({ one: 1200000, mesh: 600000 });
export const SCREEN_FPS = 15;
export const SCREEN_HINT = 'detail';
/** The loop reads the stats every 2 s. */
export const ADAPT_INTERVAL_MS = 2000;
/** 5% loss, or 4 s limited, is one step down; one step back after 10 s clean. */
export const ADAPT_LOSS = 0.05;
export const ADAPT_LIMITED_MS = 4000;
export const ADAPT_CLEAN_MS = 10000;
/** Halving stops at 100 kbit/s; then the resolution is scaled by 2, then 4; then video pauses (audio stays). */
export const VIDEO_FLOOR_BPS = 100000;
export const VIDEO_SCALE_STEPS = Object.freeze([2, 4]);

/**
 * Policy classes (src/loader/policy.js POLICY_CLASSES) and what they mean for a call. A metered network starts audio
 * only whatever was asked; SZ-4 (owner decision pending) also starts an unknown phone network audio only unless the
 * person asked for video. A desktop is 'desktop' on any network that is not metered.
 */
export const METERED_CLASSES = Object.freeze(['mobileMetered']);
export const AUDIO_DEFAULT_CLASSES = Object.freeze(['mobileMetered', 'mobileUnknown']);
export const PHONE_CLASSES = Object.freeze(['mobileUnmetered', 'mobileUnknown', 'mobileMetered']);

// ---------------------------------------------------------------------------------------------
// The service surface (SZ 3.5 "SDK"; the SVC contract of src/chat/service.js)
// ---------------------------------------------------------------------------------------------

export const CALL_METHODS = Object.freeze([
  'calls.start', 'calls.accept', 'calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera', 'calls.screen',
  'calls.state', 'calls.list',
]);
export const CALL_EVENTS = Object.freeze(['ring', 'state', 'peer', 'ended']);
/** Methods that need a loader-verified click and then the loader's own card. */
export const UI_CALL_METHODS = Object.freeze(['calls.start', 'calls.accept', 'calls.screen']);
export const READ_CALL_METHODS = Object.freeze(['calls.state', 'calls.list']);
/** Card kinds the service asks the loader for (deps.prompt). */
export const CALL_CARDS = Object.freeze(['call.start', 'call.incoming', 'call.group', 'call.metered', 'call.screen']);
/** Error codes added by calls (the reused ones: E_NOT_SIGNED_IN, E_HOST_ONLY, E_POLICY, E_NOT_CONTACT, E_PEER_UNREACHABLE,
 *  E_LIMIT, E_UNSUPPORTED; and from the SVC contract E_NEEDS_GESTURE, E_USER_CANCELLED, E_BAD_REQUEST, E_NOT_MEMBER). */
export const CALL_ERRORS = Object.freeze(['E_BUSY', 'E_DECLINED', 'E_NO_ANSWER', 'E_MEDIA_DENIED', 'E_NO_DEVICE', 'E_CALL_FAILED']);
export const CALL_STATES = Object.freeze(['ringing', 'connecting', 'connected', 'reconnecting', 'ended']);
/** Participant states as the call panel shows them (SZ 3.5 "UI"). */
export const PEER_STATES = Object.freeze(['ringing', 'connecting', 'direct', 'relayed', 'reconnecting', 'left']);
/** Why a participant left or a call ended. */
export const END_REASONS = Object.freeze([
  'hangup', 'declined', 'busy', 'no-answer', 'cancelled', 'unreachable', 'failed', 'fingerprint', 'alone', 'closed',
  'signed-out', 'host-only',
]);
