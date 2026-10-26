// The profile page (R 3.9): the public name, the private record (mw.me), the recovery kit and device links (the identity page, opened with
// mw.identity.openIdentity()) and sign out. The page has no field that asks for a recovery phrase or a password: those are typed only on
// the identity page. Calls that open a card or a window run inside the click that asked for them.
import { $, setText, show, toast, explain, loadSdk, readyInfo, hasAuth, armed } from '/js/common.js';

const IDLE = 'Tap Show my record to open it. Opening your record asks you to confirm once per visit.';
const SYNC_OFF = 'The owner has not turned on synced records, so your record stays on this device.';
const SYNC_POLICY = 'This site does not let visitors write to its ledger, so your record stays on this device.';
const STORED = { local: 'Saved on this device.', synced: 'Saved. An encrypted copy is on this site\'s ledger.' };
// The loader says why a record cannot sync ("This site has not turned on synced records." and others); a bare code gets R 2.5.4's sentence.
const reasonOf = (err) => (/^[A-Z][^]*\.$/.test(String(err.message || '')) ? err.message : SYNC_POLICY);
const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'Not yet' : '-');
const cleanLink = (text) => { // an https link of at most 200 characters, or '' for none, or null for an invalid one
  const v = text.trim();
  if (!v) return '';
  try { const u = new URL(v); if (u.protocol === 'https:' && u.href.length <= 200) return u.href; } catch (err) { /* not a URL */ }
  return null;
};

async function main() {
  const mw = await loadSdk(), info = await readyInfo(mw);
  if (!info) return;
  if (!hasAuth(mw)) return show('#profile-old', true);
  const ctx = { mw, state: info.auth === 'signed-in' ? 'signed-in' : 'guest', identity: info.identity || null, features: info.features || {} };
  const run = (fn, ok) => async () => { try { const out = await fn(); if (ok) toast(ok, 'ok'); return out; } catch (err) { toast(explain(err), err && err.code === 'E_USER_CANCELLED' ? 'info' : 'error'); } };

  async function loadBackup() {
    try {
      const b = (await mw.identity.backupStatus()) || {};
      setText('#bk-kit', yesNo(b.kitSaved)); setText('#bk-file', yesNo(b.fileSaved));
      setText('#bk-passkey', yesNo(b.passkey)); setText('#bk-persisted', yesNo(b.persisted));
      show('#bk-legacy', b.legacy === true); show('#bk-ios', b.kitSaved !== true);
    } catch (err) { /* the identity page could not be reached: the rows stay as they are */ }
  }
  function draw() {
    const signed = ctx.state === 'signed-in', id = ctx.identity || {};
    show('#profile-guest', !signed); show('#profile-signed', signed);
    if (!signed) { // nothing private stays in the page after sign out
      for (const sel of ['#rec-display', '#rec-link']) $(sel).value = '';
      setText('#rec-status', IDLE); $('#rec-sync').checked = false;
      return;
    }
    setText('#pf-name', id.name || 'Not set yet'); setText('#pf-short', id.short || '-');
    loadBackup();
  }

  // The private record. The first mw.me.get() of a visit opens the loader's card, so it runs in the click on "Show my record".
  const fill = (rec) => {
    const r = rec && typeof rec === 'object' ? rec : {};
    $('#rec-display').value = typeof r.display === 'string' ? r.display : '';
    $('#rec-link').value = Array.isArray(r.links) && typeof r.links[0] === 'string' ? r.links[0] : '';
  };
  $('#rec-load').addEventListener('click', async () => {
    try { fill(await mw.me.get()); setText('#rec-status', 'Your record is open. Only you and this site\'s code can read it.'); } catch (err) { toast(explain(err), 'error'); }
  });
  $('#rec-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const display = $('#rec-display').value.trim(), link = cleanLink($('#rec-link').value);
    if (link === null) return toast('The link must be an https link of at most 200 characters.', 'error');
    try {
      const a = display ? await mw.me.set('display', display) : await mw.me.del('display');
      const b = link ? await mw.me.set('links', [link]) : await mw.me.del('links');
      setText('#rec-status', STORED[(b || a || {}).stored] || 'Saved.');
    } catch (err) { toast(explain(err), 'error'); }
  });
  const sync = $('#rec-sync');
  sync.disabled = !ctx.features.records;
  if (sync.disabled) setText('#rec-sync-note', SYNC_OFF);
  sync.addEventListener('change', async () => {
    try { await mw.me.sync({ on: sync.checked }); toast(sync.checked ? 'An encrypted copy now goes to the site ledger.' : 'Your record stays on this device.', 'ok'); } catch (err) {
      sync.checked = !sync.checked;
      toast(err && err.code === 'E_POLICY' ? reasonOf(err) : explain(err), 'error');
    }
  });
  $('#rec-erase-slot').append(armed('act-erase', 'Remove my private data here', async () => {
    await mw.me.erase(); fill(null); setText('#rec-status', IDLE); toast('Your private data on this site was removed.', 'ok');
  }));

  // Recovery kit and device links live at the identity page; both buttons open it, and the status rows follow.
  for (const id of ['#open-kit', '#open-link']) $(id).addEventListener('click', async () => {
    try { if ((await mw.identity.openIdentity()) !== 'cancelled') loadBackup(); } catch (err) { toast(explain(err), 'error'); }
  });

  $('#profile-sign-in').addEventListener('click', run(() => mw.auth.signIn(), 'Signed in.'));
  $('#pf-sign-out').addEventListener('click', run(() => mw.auth.signOut(), 'Signed out. This site no longer holds your keys.'));
  $('#pf-forget').addEventListener('click', run(() => mw.auth.signOut({ forget: true }), 'Removed from this device.'));
  mw.auth.onChange((a) => {
    if (!a || typeof a !== 'object') return;
    ctx.state = a.state === 'signed-in' ? 'signed-in' : 'guest'; ctx.identity = a.identity || null;
    draw();
  });
  setText('#rec-status', IDLE);
  draw();
}
main();
