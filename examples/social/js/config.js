// Constants of the social template (V03-DESIGN-REVIEW "R" 3.2.3, 3.3, 3.5, 3.7). Pure data: the model, the views and the
// tests all import this file. A number is either a limit R states, or marked "chosen" there; none of them is a measurement.

export const APP_NAME = 'Social';

// Lists on the actor's own ledger (R 3.5). Reactions are keys, not a list: put('re/<ledger>/<h>').
export const LISTS = Object.freeze({
  post: 'mw.post', comment: 'mw.c', share: 'mw.q', follow: 'mw.f', ok: 'mw.ok', profile: 'mw.prof', count: 'mw.cnt',
});
export const KEYS = Object.freeze({ cfg: '_mw.cfg', reactionPrefix: 're/' });

// The features of the page's own ledger the template turns on, as the owner, the first time they are needed (src/chat/service.js,
// src/files/service.js and src/media/service.js refuse a call while _mw.cfg holds no switch for it). A personal site starts without
// _mw.cfg. The ledger's schema for _mw.cfg (src/chain/state.js cfgOk, R 2.5.5) hides the whole object when it has a key the schema does
// not know, so the template adds only FEATURE_SWITCHES keys, and writes back every key the page's _mw.cfg already has: a visible
// _mw.cfg passed the schema, and dropping a key (calls, from v0.3 C2, was dropped this way) switches that feature off. CFG_KEYS lists the
// schema keys this template knows; test/example/social-data.test.mjs checks each one against the schema.
export const FEATURE_SWITCHES = Object.freeze({ chat: 'members', files: 'members', media: 'members' });
export const CFG_KEYS = Object.freeze(['chat', 'files', 'media', 'records', 'requests', 'calls', 'maxItems', 'chatBits', 'pin', 'age', 'turn']);

export const LIMITS = Object.freeze({
  postChars: 2000, // mw.post text
  commentChars: 1000, // mw.c text and mw.q text
  bioChars: 280,
  nameChars: 48, // mw.identity.setName
  altChars: 200, // alt text for one picture (template rule)
  mediaPerPost: 4,
  mentionsPerPost: 10, // chosen, R 3.5
  profileLinks: 3,
  okRefs: 20, // refs in one mw.ok item
  valueBytes: 2048, // policy.maxValueBytes default: no item may be larger
  pageSize: 30, // timeline page, chosen
  drafts: 20, // chosen
  avatarPx: 512, // chosen
  avatarBytes: 256 * 1024, // chosen
  publicImageSide: 2048, // chosen: images are re-encoded to at most this on the long side
  publicVideoBytes: 25 * 1024 * 1024,
  blocks: 1000, // chosen
  requestsInbox: 200, // chosen
  searchIndexBytesPhone: 10 * 1024 * 1024, // chosen, R 3.4
  searchIndexBytesDesktop: 30 * 1024 * 1024, // template choice
});

// Follow caps by device class (chosen; gate rows G-SC-1 and G-SC-9 confirm or lower them).
export const FOLLOW_CAPS = Object.freeze({ phone: 250, desktop: 1000 });

export const REACTIONS = Object.freeze(['+1', 'heart', 'laugh', 'sad']);
export const REACTION_LABELS = Object.freeze({ '+1': 'Like', heart: 'Love', laugh: 'Laugh', sad: 'Sad' });

// Who may post on my wall (R 3.5). The default is people I follow.
export const WALL_MODES = Object.freeze(['everyone', 'follow', 'nobody', 'approve']);
export const DEFAULT_WALL = 'follow';

// Settings sections (R 3.7 plus the sections this template adds: profile, invite, appearance).
export const SETTINGS_SECTIONS = Object.freeze([
  'profile', 'identity', 'privacy', 'visibility', 'invite', 'notifications', 'storage', 'chat', 'media', 'appearance', 'export', 'delete',
]);

// Timeline filters (R 3.5): no ranking, ever.
export const FILTERS = Object.freeze(['all', 'posts', 'replies', 'media', 'person']);

// Features an operator can turn on in /config.json. The directory is code that ships OFF (R 3.4, N-7): it is "pending counsel".
export const DEFAULT_FLAGS = Object.freeze({ directory: false });
export const DIRECTORY_LABEL = 'pending counsel';

export const SHARD_COUNT = 4096; // directory shards (R 3.2.3 sizing); only used when the flag is on
