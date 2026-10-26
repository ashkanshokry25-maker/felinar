// Every constant of the chat lane (R 2.7, MF-32 to MF-46) in one place. "chosen" marks a design
// parameter a gate row confirms or tunes (R 1.5); "arithmetic" marks a derived number. Nothing in
// src/chat reads src/loader/config.js: the loader passes overrides through the service deps.
//
// Shared code: Node >= 22 and browsers, no imports.

/** Wire extension name (BEP 10) and the frame format version. */
export const EXT_NAME = 'mw_chat1';
export const FRAME_VERSION = 1;

/** Frame sizes (R 2.7.3). */
export const FRAME_MAX = 16384;
export const HEADER_BYTES = 14;
export const WIRE_GUARD = 262144; // the loader's per-message guard applies first (src/loader/torrent.js)
/** Post-handshake wire messages carry a 16-byte AEAD tag around the frame. */
export const WIRE_AEAD_TAG = 16;

/** Header flag bits. */
export const FLAG_HOLD = 0x01;
export const FLAG_STRANGER = 0x02;
export const FLAG_PAD_ONLY = 0x04;
export const FLAG_MASK = 0x07;

/** Body bounds per type (R 2.7.3 table, MF-43). */
export const HELLO_MAX = 512;
export const HELLO_LANES_MAX = 4;
export const LANE_NAME_MAX = 32;
export const XX_MAX = 256;
export const TAG_BYTES = 8;
export const POINT_BYTES = 65;
export const IV_BYTES = 12;
export const GCM_TAG = 16;
/** Plaintext buckets and the matching ENV ct lengths (bucket + 16) and frame sizes (arithmetic). */
export const BUCKETS = Object.freeze([256, 1024, 4096, 16000]);
export const CT_LENGTHS = Object.freeze(BUCKETS.map((b) => b + GCM_TAG)); // 272, 1040, 4112, 16016
export const ENV_FIXED = TAG_BYTES + POINT_BYTES + IV_BYTES; // 85
export const ENV_FRAME_SIZES = Object.freeze(CT_LENGTHS.map((c) => HEADER_BYTES + ENV_FIXED + c)); // 371 .. 16115
export const ROOM_NAME_MAX = 32;
export const ROOM_TEXT_MAX = 2000;
export const ROOM_ID_BYTES = 16;
/** A ROOM body is JSON; 2,000 characters escaped as \u00xx at worst plus the fixed fields (arithmetic). */
export const ROOM_BODY_MAX = 12288;
export const WANT_MAX = 32;
export const HELD_MAX_ITEMS = 32;
export const CK_MAX = 400;
export const FRAME_ID_BYTES = 32;
export const PROOF_BYTES = 32;
export const PRES_SLOTS = 8;
export const PRES_SLOT_BYTES = 8;
export const PRES_AUTH_BYTES = 64;
export const PRES_BODY = 1 + PRES_SLOTS * PRES_SLOT_BYTES + 1 + PRES_AUTH_BYTES; // 130
export const CHALLENGE_BYTES = 32;
/** HOLDING bodies are padded so the frame is as long as the smallest ENV frame (R 2.7.3 "ENV-sized"). */
export const HOLDING_BODY = ENV_FRAME_SIZES[0] - HEADER_BYTES; // 357

/** Hop limits (chosen). */
export const HOP_MAX_ENV = 4;
export const HOP_MAX_ROOM = 3;

/** Relay stamp (R 2.7.3): 10 bits without the stranger flag, the recipient's chatBits with it. */
export const STAMP_PREFIX = 'mw-relay-v1';
export const STAMP_BITS_CONTACT = 10;
export const STAMP_BITS_STRANGER_DEFAULT = 20; // chosen, G-CH-6
export const STAMP_BITS_MAX = 32;
export const NONCE_BYTES = 8;
export const DAY_MS = 86400000;

/** Wire discipline (chosen). */
export const STRIKES_CLOSE = 20;
export const DECRYPT_PER_WIRE_PER_S = 50;
export const DECRYPT_PER_TAG_PER_S = 200;
export const SEEN_MAX = 20000;
export const SEEN_TTL_MS = 600000;
export const RELAY_JITTER_MIN_MS = 500;
export const RELAY_JITTER_MAX_MS = 3000;
export const RELAY_BYTES_PER_S_DESKTOP = 65536;
export const RELAY_BYTES_PER_S_ANDROID = 8192;
export const RELAY_SESSION_BYTES_ANDROID = 2 * 1024 * 1024;
export const QUEUE_MAX_BYTES_PER_NEIGHBOUR = 262144;
export const ROUTE_TTL_MS = 600000;
export const LANE_MIN_RENDEZVOUS = 2; // join the separate chat lane only below this
export const LANE_PREFIX = 'mw-chat1|';
export const HANDSHAKE_TIMEOUT_MS = 15000;

/** Replay (R 2.7.4, MF-36). */
export const REPLAY_PAST_MS = 7 * DAY_MS + 5 * 60000;
export const REPLAY_FUTURE_MS = 5 * 60000;
export const BLOOM_DAYS = 8; // 7 days plus today
export const BLOOM_BITS = 1 << 16; // 8 KiB per day; about 6,800 ids a day at 1% false positives (arithmetic)
export const BLOOM_HASHES = 7;
export const COUNTER_WINDOW = 1024;

/** Chat-key records (R 2.7.2). */
export const CK_PREFIX = 'mw-chat-key-v2\n';
export const CK_TTL_MS = 90 * DAY_MS; // chosen
export const CK_SKEW_MS = 5 * 60000;
export const CK_CACHE_MAX = 4096;
/**
 * Epoch growth (code review v0.3, round 2; MF-20): a CK may raise its signer's epoch over the one this cache holds by at most
 * 1 plus one more per CK lifetime (90 days) since that one was taken, so a stolen key cannot pin a far-future epoch that no
 * later CK of the person can supersede. A larger jump is not taken (CkCache.put: 'ck-epoch-jump'); the cached CK stays current
 * until it expires. No CK epoch is above CK_EPOCH_MAX (2^20, arithmetic: far beyond one rotation a day for a lifetime).
 */
export const CK_EPOCH_STEP = 1;
export const CK_EPOCH_MAX = 1048576;

/** Holders (R 2.7.5 item 4; chosen). */
export const HOLD_TTL_MS = 7 * DAY_MS;
export const HOLD_PER_TAG = 64;
export const HOLD_BYTES = 4 * 1024 * 1024;
export const HOLD_SOURCE_FRACTION = 8; // at most 1/8 of the store from one neighbour
export const HELD_INTERVAL_MS = 60000; // once per tag per wire per minute
export const COLLECT_WINDOW_MS = 600000;
/** Held mail keeps its original day: a HELD frame is accepted while its day is at most this many days old (HOLD_TTL_MS). */
export const HELD_DAYS = 7;

/** Delivery (R 2.7.5 items 2 and 3; chosen). */
/**
 * Review round (DS-9): 40 s, not R's 30 s. An ACK leaves 2 to 20 s after the message and every hop and first send adds 0.5 to
 * 3 s of jitter, so with two relays each way the round trip reaches 20 + 2 x (3 + 2 x 3) = 38 s (arithmetic); at 30 s a
 * message delivered live through relays was held as well (E-CH-9).
 */
export const ACK_TIMEOUT_MS = 40000;
export const ACK_DELAY_MIN_MS = 2000;
export const ACK_DELAY_MAX_MS = 20000;
export const OUTBOX_RETRY_MS = 60000;
export const OUTBOX_MAX = 256;
export const WANT_DECOYS = 4;
export const WANT_INTERVAL_MS = 60000;
/** A contact's message refused as a replay of one this tab delivered gets its ACK again, at most once a minute per id. */
export const ACK_REQUEUE_MS = 60000;
export const DELIVERED_MAX = 256;
/** The replay guard is saved this long after an accept (debounced), and at once on pagehide or a hidden page (MF-36). */
export const REPLAY_SAVE_MS = 2000;
/** Chat-key records of contacts and group members kept in the sealed chat store (until exp, R 2.7.2). */
export const CK_PERSIST_MAX = 512;

/** Presence (R 2.7.6). */
export const PRES_INTERVAL_MS = 30000;
export const PRES_STATUS = Object.freeze({ online: 1, away: 2 });
export const PRES_LABEL = 'Connected to you now';
export const PRES_PREFIX = 'mw-pres-v1\n';

/** Rooms (R 2.7.4; chosen). */
export const ROOM_PREFIX = 'mw-room-v1\n';
export const ROOM_SKEW_MS = 5 * 60000;
export const ROOM_BUCKET = 10;
export const ROOM_BUCKET_MS = 10000;
export const ROOM_HISTORY = 200;

/** Groups (R 2.7.7; chosen). */
export const GROUP_MAX = 32;
export const GROUP_GRACE_MS = 7 * DAY_MS;
/** A message under a replaced epoch is accepted only when written before the replacement plus this skew. */
export const GROUP_SKEW_MS = 5 * 60000;
export const GROUP_MSG_PREFIX = 'mw-grp-msg-v2';
export const GROUP_ADMIN_PREFIX = 'mw-grp-admin-v1\n';
export const GROUP_COMMIT_PREFIX = 'mw-grp-commit-v1\n';
export const GROUP_NAME_MAX = 64;

/** Sealed box (R 2.7.4). */
export const PAIR_INFO = 'mw-pair-v2|';
export const DM_INFO = 'mw-dm-v2|';
export const DM_AAD = 'mw-dm-v2';
export const INBOX_PREFIX = 'mw-inbox-v2|';
/** Plaintext: id 16 | t 8 | n 4 | kind 1 | flags 1 | [stranger: ckLen 2 | CK | auth 32] | len 2 | body | padding. */
export const PT_FIXED = 16 + 8 + 4 + 1 + 1 + 2; // 32
export const STRANGER_AUTH = 32;
/** Plaintext kinds. */
export const KIND = Object.freeze({ text: 1, ack: 2, grant: 3, invite: 4, sig: 5, pad: 6, join: 7, group: 8 });

/** Rate limits for service calls (chosen). */
export const DM_PER_MIN = 60;
export const TEXT_MAX = 4000;

/** Device classes that relay nothing by default (R 2.7.3 budgets, 2.7.9). */
export const DEVICE = Object.freeze({ desktop: 'desktop', android: 'android', ios: 'ios' });

// ---------------------------------------------------------------------------------------------------------------------------
// Review round (R 5.3, 2026-10-24; docs/deviations/review-round-chat.md). Every value below is chosen; none is measured.
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * Own frames (PRIV-1, STALK-7): a frame this tab writes leaves at a random hop in [0, OWN_HOP_MAX] (never above the type's
 * limit minus 2), after the first-send jitter (RELAY_JITTER_*) when more than one neighbour could carry it, and a flood goes
 * to a random half of the neighbours (at least two when there are two).
 */
export const OWN_HOP_MAX = 2;
/** Per-wire WANT-TAGS routes (DS-1, MP-3, MP-4, SYB-3, SYB-9): a wire's prefixes are those of its latest WANT only. */
export const ROUTE_TAGS_PER_WIRE = 16;
export const ROUTE_TAGS_MAX = 4096;
/**
 * Per-wire ingress budgets of the frames that carry no stamp (MP-8, SYB-10), as token buckets { burst, perMs }: a frame
 * over its budget is dropped and is a strike. An honest peer sends one WANT a minute, one CK per wire (and per rotation),
 * one PRES per 30 s, one ICHAL per minute (pin mailbox), HELD only after a WANT.
 */
export const INGRESS = Object.freeze({
  WANT: Object.freeze({ burst: 4, perMs: 15000 }),
  CK: Object.freeze({ burst: 4, perMs: 15000 }),
  PRES: Object.freeze({ burst: 4, perMs: 5000 }),
  ICHAL: Object.freeze({ burst: 2, perMs: 30000 }),
  IRESP: Object.freeze({ burst: 2, perMs: 30000 }),
  HELD: Object.freeze({ burst: 64, perMs: 1000 }),
});
/** ROOM frames reach the signature check at most 20 a second per wire and 100 a second in all (SYB A7, SYB-10). */
export const ROOM_VERIFY_PER_WIRE_PER_S = 20;
export const ROOM_VERIFY_PER_S = 100;
/** A wire whose unread backlog passes this many bytes is closed (MP-5, MP-8, SYB-10). */
export const RX_BACKLOG_BYTES = 1048576;
/** Chat-key records of signers this tab has no reason to know are kept apart, at most this many (MP-5, SYB-5). */
export const CK_UNKNOWN_MAX = 256;
/** Replay guard (DS-6, SYB-6): one sender adds at most this many ids a UTC day; more are refused, not recorded. */
export const REPLAY_SENDER_DAY_MAX = 5000;
/** Message requests (SYB-14): one open request per sender key; the oldest goes when the inbox is full. */
export const REQUESTS_MAX = 200;
/** Groups (SYB-16): at most this many groups, and this many adopted from one inviter's invites. */
export const GROUPS_MAX = 64;
export const GROUPS_PER_INVITER = 16;
/** Rooms (MP-13): a (author, id) pair is shown once while its t can still pass the skew check. */
export const ROOM_SEEN_MAX = 4096;
/** Rooms (STALK-12): t in a ROOM frame is rounded down to the minute; a frame with another t is refused. */
export const ROOM_T_STEP_MS = 60000;
/** Holders (SYB-15, HUB-8): at most this many frames handed to one wire a minute. */
export const HELD_PER_WIRE_PER_MIN = 64;
/** COLLECTED hash lock (SYB-15, HUB-8): iv = SHA-256(COLLECT_PREFIX | s)[:12], s = HMAC(K_pair, "collect|" | tag | epk). */
export const COLLECT_PREFIX = 'mw-collect-v1';
