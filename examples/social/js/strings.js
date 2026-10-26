// Every sentence the template shows that is not a person's own text. The R 3.7 strings are verbatim; the card and privacy
// sentences are the R 2.14.1 and 2.14.2 ones (the old wording must not appear); ERROR_TEXT is the SDK's English table of
// R 2.11.2 plus the 0.2.1 codes, and test/example/social-lib.test.mjs compares it with src/loader/strings.js so the two cannot
// drift. English only; an operator who wants another language translates this one file. ASCII only, straight quotes.

export const ERROR_TEXT = Object.freeze({
  // R 2.11.2 and 2.9.11 (same wording as src/loader/strings.js ERROR_TEXT.en)
  E_NOT_SIGNED_IN: 'Sign in to do this.',
  E_USER_CANCELLED: 'You cancelled.',
  E_UNSUPPORTED: 'This browser cannot do this. Use a current version of Chrome, Edge, Firefox or Safari.',
  E_FIELD: 'That field name is reserved. Choose another.',
  E_DECRYPT: 'This could not be opened with your keys.',
  E_HOST_ONLY_IDENTITY: 'This address shares one origin with other sites, so your identity applies to this visit only.',
  E_POPUP_BLOCKED: 'Your browser blocked the sign-in window. Tap Sign in again.',
  E_IDP_UNREACHABLE: 'The identity page could not be reached. Check your connection and try again.',
  E_NEEDS_GESTURE: 'Tap the button on the page to continue.',
  E_NONCE_REQUIRED: 'This site did not send a sign-in code. Reload the page and try again.',
  E_LEDGER_FULL: 'This site cannot take more entries right now.',
  E_SYNCING: 'Still catching up with the site. Try again in a moment.',
  E_HOST_ONLY: 'This feature needs peer connections, and you chose host only.',
  E_NO_OWN_TRACKER: 'This site has not set up its own connection server, so chat is off here.',
  E_NO_CHAT_KEY: '{name} has not turned on messages on this site.',
  E_BLOCKED: 'You cannot send to {name}.',
  E_STAMP: 'Working out the spam fee did not finish. Try again.',
  E_NOT_MEMBER: 'You are not a member of this group.',
  E_NOT_ADMIN: 'Only an admin of this group can do this.',
  E_NOT_CONTACT: 'Direct connections are only for your contacts.',
  E_PEER_UNREACHABLE: '{name} could not be reached directly.',
  E_FILE_UNAVAILABLE: 'Nobody who has this file is online right now.',
  E_FILE_TOMBSTONED: 'This file was removed.',
  E_FILE_HASH: 'This file did not match its checksum and was dropped.',
  E_DENIED: 'You do not have access to this.',
  E_MEDIA_TYPE: 'This kind of file is not accepted here.',
  E_MEDIA_STRIP: 'Location and camera details could not be removed, so the file was not sent.',
  E_MEDIA_UNPLAYABLE: 'This browser cannot play this file.',
  E_REVOKED: 'Access to this was taken back.',
  E_POLICY: 'This site does not allow that.',
  E_LIMIT: 'That is over the limit.',
  E_RATE: 'Too fast. Wait a few seconds and try again.',
  E_POW_ABORTED: 'Cancelled before the spam fee finished.',
  E_BANNED: 'You cannot post here.',
  E_BAD_REQUEST: 'That request was not valid.',
  // v0.3 C2 calls (same wording as src/loader/strings.js ERROR_TEXT.en; the template makes no calls, the table stays the SDK's)
  E_BUSY: 'The other person is in another call.',
  E_DECLINED: 'The call was declined.',
  E_NO_ANSWER: 'Nobody answered the call.',
  E_MEDIA_DENIED: 'The browser did not allow the microphone or camera. Allow it in the site settings of your browser and try again.',
  E_NO_DEVICE: 'No microphone or camera was found on this device.',
  E_CALL_FAILED: 'The call could not be connected, or its connection could not be checked.',
  // 0.2.1 codes (docs/SDK.md) that this template can meet
  E_NOT_OWNER: 'Only the owner of this site can do this.',
  E_NOT_MODERATOR: 'Only a moderator of this site can do this.',
  E_CAP: 'This device is out of storage for this site. Free some space, or remove saved sites in Settings.',
  E_IDENTITY: 'Your keys or this site ledger are not available in this browser right now. Reload the page, or sign out and sign in again.',
  E_NO_HOST: 'felinar is not running on this page. Reload the page and try again.',
  E_TIMEOUT: 'This took too long. Check your connection and try again.',
  E_INTERNAL: 'Something went wrong on this page. Reload it and try again.',
  // Template codes: checks the page makes before it calls the SDK
  EMPTY: 'Write something first.',
  ALT_REQUIRED: 'Describe each picture before you post. A short description helps people who cannot see it.',
  MENTIONS: 'You can mention at most 10 people in one post.',
  LINK_HTTPS: 'Links must start with https.',
  HANDLE: 'A handle is a domain name you own, such as example.org.',
  NOT_AVAILABLE: 'This copy of the loader does not offer that yet.',
  NO_HOME: 'This browser does not know your page yet. Create it first.',
  HUB_IDENTITY: 'Your page needs one identity on all of this hub, and the key you are signed in with here is not that identity. A page made with it would not take your own posts. The identity page asks about one identity once per hub. In its Settings, choose "Ask me again" for this hub, then sign in here again.',
});

export function errorMessage(err, params) {
  const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : typeof err === 'string' ? err : '';
  const text = Object.prototype.hasOwnProperty.call(ERROR_TEXT, code) ? ERROR_TEXT[code] : code ? 'Something went wrong (' + code + ').' : 'Something went wrong.';
  return fill(text, params);
}
export function fill(text, params) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (params && Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m));
}
/** fieldError(error) -> the sentence for a validation error { field, code } from the model. */
export const fieldError = (e) => errorMessage({ code: e.code });

// ---- R 3.7: empty, 404 and offline states, the sync line, the noscript notice (verbatim)
export const STATE = Object.freeze({
  noFollows: "You don't follow anyone yet. Share your QR code or open a friend's link.",
  unknownRoute: "This page doesn't exist in this app.",
  unknownPost: "This post isn't in the copies this browser has. It may have been removed, or nobody who has it is online.",
  unknownPage: "This page isn't in the copies this browser has. It may have been withdrawn, or nobody who has it is connected to you now.",
  noscript: "This site loads from other visitors' browsers and needs JavaScript.",
  withdrawn: 'This page was withdrawn by its owner',
  removedByHub: 'Removed by this hub',
  standalone: 'Open this site through the felinar loader. You are looking at the static files directly, so there is nothing to read or post here.',
});
export const syncLine = (done, total) => 'Catching up: ' + done.toLocaleString('en-US') + ' of ' + total.toLocaleString('en-US') + ' pages';
export const offlineLine = (hhmm) => 'Showing what this device has. Last updated ' + hhmm + '.';

// ---- R 3.5 availability and presence wording
export const AVAILABLE = Object.freeze({
  kept: 'Kept by the hub',
  other: 'Available only while someone who has it is online',
});
export const CONNECTED = 'Connected to you now';

// ---- R 3.3 "Download my data": the SDK gives the page the ledger's state, not its signed entries; the loader's own Settings exports those
export const SIGNED_ENTRIES_NOTE = "The signed entries of your page are not in this file: the loader does not give them to the page. Export them from the loader's own Settings: Site ledger, Export ledger JSON.";

// ---- R 2.14.1 and 2.14.2 sentences the page prints itself (the loader shows the cards; test/example/social-lib.test.mjs compares these with src/loader/strings.js)
export const PRIVACY = Object.freeze({
  recordNote: 'Encrypted. The site can read it while you are signed in.',
  whatOthersSee: 'People connected to this site see your IP address next to the key you use here when you post or chat. Signing in does not send your key or the list of your other sites to any identity company. The host of the identity page does see your IP address and the time whenever your browser has to load that page.',
  conversations: 'Conversations are never written to the site ledger. Anyone connected can record the encrypted copies.',
  presenceKey: 'Public presence shows your key.',
  presenceOff: "Nobody sees your name as connected unless you turn presence on. People connected to you can see that your address is on this site's chat.",
  rooms: 'Public and signed. Anyone connected can read this, and a recording proves what you wrote.',
  groups: 'Members can keep and forward anything sent here, and can prove to others what you wrote in this group.',
  fetchPublic: 'Fetching also shares it with others while this page is open, and they see your IP address next to it.',
  scriptsNote: 'Scripts on this page can act as you on this site while you are signed in. They cannot reach your other sites.',
  neverWords: 'felinar never asks for your 12 words on the site you are signing in to.',
  keyMatching: 'Sites cannot match you by key unless you choose to be recognised. They can still match you by IP address, a reused name or timing.',
  messagesArrive: 'Messages arrive while this page is open.',
  publicByDesign: 'Everything on your wall, your profile, your public follows and your reactions is public and is copied to every visitor who opens your page.',
  deleteLimits: 'Posts you delete are hidden from copies that sync. Copies on devices that never sync again stay where they are.',
});
