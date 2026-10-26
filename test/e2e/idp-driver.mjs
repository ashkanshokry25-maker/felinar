// test/e2e/idp-driver.mjs: drives the identity origin's popup (src/idp/idp.js, cards.js) the way a person does, for
// the v0.3 end-to-end scenarios (V03-DESIGN-REVIEW Part 4.2, E-ID-*, E-SO-*). Every button is pressed with a real
// mouse click (the cards ignore a script's click, isTrusted false, and any press in a card's first MIN_PRESS_MS).
//
//   driveIdp(popup, plan, { timeoutMs }) -> { cards: [title], messages: [text], closed }
//   plan: {
//     unlock: 'visit' | 'passphrase' | 'passkey'   how a NEW identity is protected on this device (chooseUnlock card)
//     passphrase: string                            for 'passphrase' (create and unlock; at least 12 characters)
//     stay: boolean                                 "Stay signed in on this device" (default false)
//     shared: boolean                               "Shared computer" (default false)
//     hub: boolean | undefined                      the "Use one identity on all of <hub>" box, when the card offers it
//     same: origin | null                           pick "Same as on <origin>" in the mode menu, then confirm it
//     restore: { words, extra } | null              choose "Restore an identity" and type the 12 words
//     confirm: boolean                              answer yes to createPage, owner, record and erase cards (default true)
//     kit: 'later'                                  the recovery kit card (iOS only) is answered "Later"
//     onCard(state) -> 'handled' | undefined       a hook for cards a scenario wants to inspect or answer itself
//   }
// The driver returns when the popup closes (the IdO closes itself after posting the answer to its opener), or, with the
// option until() (the redirect round trip, E-ID-11: the tab itself goes to the IdO and comes back), once until() is true.

import { sleep, withTimeout, StepError } from './lib.mjs';
import { MIN_PRESS_MS } from '../../src/idp/cards.js';
import { t } from '../../src/idp/strings.js';

const L = (key, params) => t(key, params, 'en');
const exact = (text) => new RegExp('^\\s*' + String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');

/** The card on screen: { fresh, title, buttons, inputs, text, errors } (fresh: not seen before by this driver). */
export async function cardState(popup) {
  return popup.evaluate(() => {
    const main = document.querySelector('main.mw-idp');
    const card = main && main.querySelector('section.mw-card');
    if (!card) return { none: true };
    const fresh = !card.hasAttribute('data-e2e-seen');
    if (fresh) card.setAttribute('data-e2e-seen', String(Date.now()));
    const h1 = card.querySelector('h1');
    return {
      fresh,
      seenAt: Number(card.getAttribute('data-e2e-seen')),
      title: h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : '',
      buttons: Array.from(card.querySelectorAll('button')).map((b) => ({ text: b.textContent.replace(/\s+/g, ' ').trim(), cls: b.className, disabled: b.disabled })),
      inputs: Array.from(card.querySelectorAll('input, textarea, select')).map((i) => ({ name: i.getAttribute('name'), type: i.type || i.tagName.toLowerCase() })),
      text: card.textContent.replace(/\s+/g, ' ').trim().slice(0, 1200),
      errors: Array.from(card.querySelectorAll('.mw-error')).map((e) => e.textContent.trim()).filter(Boolean),
      busy: Boolean(card.querySelector('.mw-busy')),
    };
  });
}

/** Presses the card's button whose text is exactly label (a trusted click, after the card's press guard). */
export async function pressCard(popup, label, state) {
  const wait = state && state.seenAt ? Math.max(0, state.seenAt + MIN_PRESS_MS + 150 - Date.now()) : MIN_PRESS_MS + 150;
  if (wait) await sleep(wait);
  const button = popup.locator('main.mw-idp section.mw-card button').filter({ hasText: exact(label) }).first();
  if ((await button.count()) === 0) throw new StepError('identity origin: no button "' + label + '" on the card "' + (state && state.title) + '"');
  // 15 s: in Firefox the passphrase card's "Continue" takes 3.7 to 4.1 s to become clickable (docs/deviations/firefox.md).
  await button.click({ timeout: 15000 });
}

async function setBox(popup, name, on) {
  const box = popup.locator('main.mw-idp section.mw-card input[name="' + name + '"]').first();
  if ((await box.count()) === 0) return false;
  if ((await box.isChecked()) !== on) await box.setChecked(on, { timeout: 2000 });
  return true;
}

/**
 * driveIdp(popup, plan) -> { cards, messages, closed: true }: answers each card of the identity origin until the popup
 * closes. A card it does not know fails the step with the card's text (never a silent guess).
 */
export async function driveIdp(popup, plan = {}, { timeoutMs = 60000, until = null } = {}) {
  const p = Object.assign({ unlock: 'visit', passphrase: 'e2e passphrase for a loopback test', stay: false, shared: false, hub: undefined, same: null, restore: null, confirm: true, kit: 'later' }, plan);
  const cards = [];
  const messages = [];
  let closed = popup.isClosed();
  popup.once('close', () => { closed = true; });
  await popup.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  const end = Date.now() + timeoutMs;
  let restoreDone = false;
  let lastAction = '';
  let repeats = 0;
  while (!closed) {
    if (until && await until()) break;
    if (Date.now() > end) throw new StepError('identity origin: the popup did not close within ' + timeoutMs + ' ms (cards: ' + cards.join(' | ') + ')');
    let st;
    try {
      st = await popup.evaluate(() => 1).then(() => cardState(popup));
    } catch (_) {
      if (closed || popup.isClosed()) break;
      await sleep(100);
      continue;
    }
    if (!st || st.none || st.busy) { await sleep(100); continue; }
    if (!st.fresh) {
      // The same card is still up: a press inside the guard window, a validation message, or work in progress.
      if (st.errors.length && /passphrase|word|phrase/i.test(st.errors.join(' ')) && lastAction === 'passphrase') {
        throw new StepError('identity origin: ' + st.errors.join(' '));
      }
      repeats++;
      if (repeats % 15 === 0 && lastAction) await act(st, true);
      await sleep(150);
      continue;
    }
    repeats = 0;
    cards.push(st.title || '(untitled: ' + st.text.slice(0, 60) + ')');
    if (typeof p.onCard === 'function') {
      const r = await p.onCard(st, { popup, press: (label) => pressCard(popup, label, st) });
      if (r === 'handled') continue;
    }
    await act(st, false);
  }
  return { cards, messages, closed: true };

  async function act(st, again) {
    const title = st.title;
    const has = (label) => st.buttons.some((b) => b.text === label);
    if (title.startsWith(L('signInTo'))) {
      if (p.restore && !restoreDone && has(L('restoreTitle'))) {
        restoreDone = true;
        lastAction = 'restore';
        return pressCard(popup, L('restoreTitle'), st);
      }
      if (!again) {
        await setBox(popup, 'stay', p.stay === true);
        await setBox(popup, 'shared', p.shared === true);
        if (p.hub !== undefined) await setBox(popup, 'hub', p.hub === true);
        if (p.same) {
          const sel = popup.locator('main.mw-idp section.mw-card select[name="mode"]').first();
          if ((await sel.count()) === 0) throw new StepError('identity origin: no identity menu to choose "same as ' + p.same + '"');
          await sel.selectOption('same:' + p.same);
        }
      }
      const primary = st.buttons.find((b) => /mw-primary/.test(b.cls));
      if (!primary) throw new StepError('identity origin: the sign-in card has no primary button: ' + st.text);
      lastAction = 'signin';
      return pressCard(popup, primary.text, st);
    }
    if (title === L('chooseUnlockTitle')) {
      const label = p.unlock === 'passkey' ? L('unlockPasskey') : p.unlock === 'passphrase' ? L('unlockPassphrase') : L('unlockVisit');
      lastAction = 'unlock';
      return pressCard(popup, label, st);
    }
    if (title === L('unlockPassphrase') || title === L('continuePassphrase')) {
      // A refused passphrase draws the card again with its message (a fresh card): fail at once with the identity origin's words
      // instead of typing the same passphrase until the step times out (code review v0.3, round 2: the strength estimate).
      if (lastAction === 'passphrase' && st.errors.length) throw new StepError('identity origin refused the passphrase: ' + st.errors.join(' '));
      if (!again) {
        await popup.locator('main.mw-idp section.mw-card input[name="passphrase"]').fill(p.passphrase);
        const two = popup.locator('main.mw-idp section.mw-card input[name="passphrase2"]');
        if ((await two.count()) > 0) await two.fill(p.passphrase);
      }
      lastAction = 'passphrase';
      return pressCard(popup, L('cont'), st);
    }
    if (title === L('restoreTitle')) {
      if (!p.restore) throw new StepError('identity origin: a restore card the plan does not expect');
      if (!again) {
        await popup.locator('main.mw-idp section.mw-card textarea[name="phrase"]').fill(Array.isArray(p.restore.words) ? p.restore.words.join(' ') : String(p.restore.words || ''));
        if (p.restore.extra) await popup.locator('main.mw-idp section.mw-card input[name="extra"]').fill(p.restore.extra);
      }
      lastAction = 'restore-phrase';
      return pressCard(popup, L('restorePhrase'), st);
    }
    if (title === L('restored')) {
      messages.push(st.text);
      lastAction = 'check-code';
      const yes = st.buttons.find((b) => /mw-primary/.test(b.cls)) || st.buttons[0];
      return pressCard(popup, yes.text, st);
    }
    if (title === L('createPageButton') || title === L('confirm') || title === L('allow') || title === L('remove')) {
      lastAction = 'yes-no';
      const yes = p.confirm === false ? L('cancel') : st.buttons.find((b) => /mw-primary|mw-danger/.test(b.cls) && b.text !== L('cancel'));
      return pressCard(popup, typeof yes === 'string' ? yes : yes.text, st);
    }
    if (p.same && st.buttons.some((b) => b.text === L('sameConfirm'))) {
      lastAction = 'same';
      await sleep(900); // the confirm button takes a deliberate second press (SECOND_PRESS_MS)
      return pressCard(popup, L('sameConfirm'), st);
    }
    if (title === L('kitTitle') && has(L('kitLater'))) {
      lastAction = 'kit';
      return pressCard(popup, L('kitLater'), st);
    }
    if (has(L('close')) && st.buttons.length === 1) {
      messages.push(st.text);
      lastAction = 'close';
      return pressCard(popup, L('close'), st);
    }
    throw new StepError('identity origin: a card the plan does not answer: "' + title + '" ' + st.text.slice(0, 400));
  }
}

/**
 * signInThrough(page, click, plan) -> { popup, drive }: runs click() (a real click on a site's Sign in control, or the
 * loader's card), waits for the identity origin's popup and drives it.
 */
export async function signInThrough(page, click, plan = {}, { timeoutMs = 60000 } = {}) {
  const popupPromise = page.context().waitForEvent('page', { timeout: timeoutMs });
  await click();
  const popup = await popupPromise;
  const drive = await withTimeout(driveIdp(popup, plan, { timeoutMs }), timeoutMs + 5000, 'identity origin popup');
  return { popup, drive };
}
