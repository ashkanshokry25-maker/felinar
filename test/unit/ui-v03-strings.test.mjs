// Unit tests for the v0.3 strings: every error code of R 2.11.2 (and the shared codes) in English and French,
// every card text of R 2.14.1, the R 2.14.2 replacements (and none of the old sentences anywhere), the two
// flags default false, no banned word, no em dash, noscript text and the no-referrer meta in index.html.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as M from '../../src/loader/strings.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const {
  ERROR_TEXT, CARD_TEXT, UI_TEXT, REPLACED_SENTENCES, DELIVERY_TEXT, IOS_TOR_TEXT, NOSCRIPT_TEXT, STRING_FLAGS,
  V03_ERROR_CODES, V03_SHARED_CODES, errorText, cardText, uiText, deliveryText, iosTorText, setStringFlag, fmt, pickLang, STRINGS
} = M;

afterEach(() => { setStringFlag('deliveryStates', false); setStringFlag('iosTorStrings', false); });

const BANNED = [/blockchain/i, /serverless/i, /unstoppable/i, /censorship[- ]resistant/i, /production[- ]ready/i];
const NO_DASH = /[\u2013\u2014\u2018\u2019\u201C\u201D]/;
const tables = () => {
  const out = [];
  for (const [name, t] of Object.entries({ ERROR_TEXT, CARD_TEXT, UI_TEXT, REPLACED_SENTENCES, DELIVERY_TEXT, IOS_TOR_TEXT, NOSCRIPT_TEXT: { en: { n: NOSCRIPT_TEXT.en }, fr: { n: NOSCRIPT_TEXT.fr } } })) {
    for (const lang of ['en', 'fr']) for (const [k, v] of Object.entries(t[lang])) out.push({ name, lang, key: k, text: v });
  }
  return out;
};

test('R 2.11.2: every code added has an English and a French string, and so do the shared codes', () => {
  assert.equal(V03_ERROR_CODES.length, 29, 'the 29 codes R 2.11.2 lists');
  for (const code of [...V03_ERROR_CODES, ...V03_SHARED_CODES]) {
    for (const lang of ['en', 'fr']) {
      const t = ERROR_TEXT[lang][code];
      assert.ok(typeof t === 'string' && t.length > 8, code + ' ' + lang);
      assert.ok(!errorText(code, lang, { name: 'Bo' }).includes('{'), code + ' placeholders filled');
    }
    assert.notEqual(ERROR_TEXT.en[code], ERROR_TEXT.fr[code], code + ' French differs');
  }
  assert.deepEqual(Object.keys(ERROR_TEXT.en).sort(), Object.keys(ERROR_TEXT.fr).sort());
  assert.equal(errorText('E_NO_CHAT_KEY', 'en', { name: 'Bo' }), 'Bo has not turned on messages on this site.');
  assert.equal(errorText('E_FILE_UNAVAILABLE', 'en'), 'Nobody who has this file is online right now.');
  assert.ok(errorText('E_SOMETHING_NEW', 'fr').includes('E_SOMETHING_NEW'));
});

test('R 2.14.1: every card has both languages with the same placeholders', () => {
  const keys = ['signIn', 'passkey', 'whatOthersSee', 'twelveWords', 'recoveryKitIos', 'sameIdentity', 'hubIdentity', 'staySignedIn', 'turnOnChat', 'presencePublic', 'holdMessages', 'messageRequests', 'rooms', 'groups', 'publicUpload', 'privateUpload', 'fetchPublic', 'helpShare', 'directConnection', 'turnRelay', 'chatKeyInLedger', 'syncRecord', 'removePrivateData', 'replaceKeys', 'phoneUpload'];
  const ph = (s) => (s.match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(',');
  for (const k of keys) {
    assert.ok(CARD_TEXT.en[k] && CARD_TEXT.fr[k], k);
    assert.equal(ph(CARD_TEXT.en[k]), ph(CARD_TEXT.fr[k]), k + ' placeholders');
  }
  assert.equal(cardText('rooms', 'en'), 'Public and signed. Anyone connected can read this, and a recording proves what you wrote.');
  assert.equal(cardText('phoneUpload', 'en'), 'Sending this file uses your mobile data. Keep this page open and on screen until it says sent.');
  assert.equal(cardText('twelveWords', 'en', { idp: 'id.example' }), 'These 12 words open every site you use with felinar. felinar never asks for them on the site you are signing in to. Type them only at id.example.');
  assert.equal(cardText('neverWords', 'en'), 'felinar never asks for your 12 words on the site you are signing in to.');
  assert.equal(cardText('removePrivateData', 'en').startsWith('This hides your encrypted record from copies that sync'), true);
  // v0.3 code review: the card states what can bring the key back (docs/deviations/idp.md item 18; PRIVACY.md "Your rights").
  assert.ok(cardText('removePrivateData', 'en').endsWith('A backup file made before now, or an earlier copy of your identity that a site keeps for the identity page, still holds the key, and restoring from it brings the key back.'));
  assert.ok(cardText('removePrivateData', 'fr').includes('Un fichier de sauvegarde fait avant maintenant'));
  assert.equal(Object.keys(UI_TEXT.en).sort().join(), Object.keys(UI_TEXT.fr).sort().join());
  assert.equal(Object.keys(CARD_TEXT.en).sort().join(), Object.keys(CARD_TEXT.fr).sort().join());
});

// R 2.14.2: the sentences that were replaced (PRIV M11, SEC M14, HON M8).
const OLD_SENTENCES = [
  'Sites cannot match a visitor by key', 'Nobody else can decrypt, including the owner reading the ledger', 'Only you can read this',
  'Nothing is sent anywhere.', 'Everything conversational is ephemeral', 'never sender or recipient', 'IP and an opaque id for groups',
  'Your IP only if they are your neighbour', 'Nobody sees you as online unless you turn presence on', 'Blinded public presence',
  'Signing in tells no company', 'Non-extractable: a script cannot copy the key', 'Uploaded content never executes at the site origin', 'Owner cannot read private lanes'
];

test('R 2.14.2: the replacement sentences exist in both languages and no old sentence appears anywhere', () => {
  assert.equal(Object.keys(REPLACED_SENTENCES.en).length, 14);
  assert.equal(Object.keys(REPLACED_SENTENCES.en).join(), Object.keys(REPLACED_SENTENCES.fr).join());
  const old = OLD_SENTENCES;
  const everything = tables().map((t) => t.text).concat(Object.values(STRINGS).filter((v) => typeof v === 'string'));
  for (const o of old) assert.ok(!everything.some((s) => s.includes(o)), 'old sentence present: ' + o);
  assert.equal(REPLACED_SENTENCES.en.keyMatching, 'Sites cannot match you by key unless you choose to be recognised. They can still match you by IP address, a reused name or timing.');
  assert.equal(REPLACED_SENTENCES.en.presenceKey, 'Public presence shows your key.');
});

// The same check over the user documents (v0.3 code review: docs/SDK.md said "the site's code never sees them, only the public key",
// against MF-15 and R 2.1 rule 2). docs/review quotes the old sentences on purpose and is left out.
test('R 2.14.2 and MF-15 over README.md, docs/*.md and the example READMEs: no replaced sentence, no claim that site code cannot use its keys', () => {
  const files = [resolve(root, 'README.md'), ...readdirSync(resolve(root, 'docs')).filter((n) => n.endsWith('.md')).map((n) => resolve(root, 'docs', n)),
    ...readdirSync(resolve(root, 'examples')).map((d) => resolve(root, 'examples', d, 'README.md')).filter((f) => existsSync(f))];
  const claims = [/code never sees (them|the keys|your keys)/i, /never sees them, only the public key/i, /scripts? (cannot|can't|can not) (copy|use) (the|your) keys?/i];
  const found = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8').replace(/\s+/g, ' ');
    for (const o of OLD_SENTENCES) if (text.includes(o)) found.push(f.slice(root.length + 1) + ': ' + o);
    for (const re of claims) if (re.test(text)) found.push(f.slice(root.length + 1) + ': ' + re);
  }
  assert.deepEqual(found, []);
  const sdk = readFileSync(resolve(root, 'docs/SDK.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(sdk.includes('No SDK method returns them, but code on this site, including scripts you include, can use and copy the keys for this site while the person is signed in'), 'docs/SDK.md states what site code can do with the working keys');
});

test('no banned word, no em or en dash, no curly quote, no erase wording, in any v0.3 string', () => {
  for (const t of tables()) {
    for (const re of BANNED) assert.ok(!re.test(t.text), t.name + '.' + t.lang + '.' + t.key + ' has ' + re);
    assert.ok(!NO_DASH.test(t.text), t.name + '.' + t.lang + '.' + t.key + ' has a dash or curly quote');
    assert.ok(!/\berase|delete everywhere|supprimer partout|effacer/i.test(t.text), t.name + '.' + t.key + ' erase wording');
  }
  for (const [k, v] of Object.entries(STRINGS)) if (typeof v === 'string') for (const re of BANNED) assert.ok(!re.test(v), k);
});

test('presence reads "Connected to you now"; the word online never describes presence', () => {
  assert.equal(uiText('chatConnected', 'en'), 'Connected to you now');
  for (const lang of ['en', 'fr']) {
    for (const group of [CARD_TEXT, UI_TEXT, REPLACED_SENTENCES]) {
      for (const [k, v] of Object.entries(group[lang])) assert.ok(!/\bonline\b|\ben ligne\b/i.test(v), lang + '.' + k + ' says online');
    }
  }
  assert.ok(!/online/i.test(CARD_TEXT.en.presencePublic));
});

test('MF-35 and MF-63: both flags default to false and gate their strings', () => {
  assert.deepEqual({ ...STRING_FLAGS }, { deliveryStates: false, iosTorStrings: false });
  assert.equal(deliveryText('delivered', 'en'), null);
  assert.equal(iosTorText('torNoChat', 'en'), null);
  setStringFlag('deliveryStates', true);
  assert.equal(deliveryText('delivered', 'en'), 'Delivered');
  assert.equal(deliveryText('handed', 'en', { count: 3, time: '14:02' }), '3 peers reported holding it at 14:02. They may go offline.');
  assert.equal(deliveryText('sent-unknown', 'en'), 'Sent to the network. You will not know if it arrived until they reply.');
  assert.equal(deliveryText('not-delivered', 'en'), 'Not delivered: nobody who can hold it is online.');
  assert.equal(deliveryText('outbox', 'en', { name: 'Bo' }), 'Will send when Bo is online while this page is open');
  assert.ok(deliveryText('delivered', 'fr'));
  assert.equal(deliveryText('nope', 'en'), null);
  setStringFlag('iosTorStrings', true);
  assert.ok(iosTorText('torNoChat', 'fr'));
  assert.throws(() => setStringFlag('bogus', true), TypeError);
  assert.deepEqual(Object.keys(DELIVERY_TEXT.en).sort(), Object.keys(DELIVERY_TEXT.fr).sort());
  assert.deepEqual(Object.keys(IOS_TOR_TEXT.en).sort(), Object.keys(IOS_TOR_TEXT.fr).sort());
});

test('the eviction sentence, the owner-changed and foreign-address notices, the scripts sentence', () => {
  assert.equal(uiText('evicted', 'en'), 'This browser deleted your sign-in for this site. Tap Sign in to get it back.');
  assert.ok(uiText('evicted', 'fr').length > 20);
  assert.equal(uiText('foreignAddress', 'en'), "This address is not one of this site's addresses.");
  assert.ok(uiText('ownerChanged', 'en', { minutes: 5 }).startsWith('The owner of this site changed 5 minutes ago.'));
  assert.equal(cardText('scriptsNote', 'en'), uiText('signinInfo', 'en'));
});

test('helpers: fmt leaves unknown placeholders, pickLang defaults to English', () => {
  assert.equal(fmt('a {x} {y}', { x: 1 }), 'a 1 {y}');
  assert.equal(pickLang('fr-CA'), 'fr');
  assert.equal(pickLang('en-US'), 'en');
  assert.equal(pickLang('fra'), 'en');
  assert.equal(pickLang(undefined), 'en');
});

test('index.html: no-referrer meta, the R 3.7 noscript sentence, still one boot script and the stylesheet', () => {
  const html = readFileSync(resolve(root, 'src/loader/index.html'), 'utf8');
  assert.ok(/<meta name="referrer" content="no-referrer">/.test(html));
  assert.ok(html.includes('<noscript>') && html.includes(NOSCRIPT_TEXT.en.replace(/'/g, "'")));
  assert.equal((html.match(/<script /g) || []).length, 1);
  assert.ok(html.includes('<script src="/_mw/boot.js"></script>'));
  assert.ok(html.includes('<link rel="modulepreload" href="/_mw/loader.js">'));
  assert.ok(!/<input/i.test(html));
  assert.ok(!NO_DASH.test(html.replace(/<!--[\s\S]*?-->/g, '')));
});
