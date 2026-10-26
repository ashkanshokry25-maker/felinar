// Sign in and sign out for every page of the guestbook (R 3.9). Sign in opens the identity page in its own window and gives this site a key
// that works only here; Sign out deletes this site's keys from this browser. The buttons call the SDK inside the click, because opening
// that window needs the person's own tap. A loader older than v0.3 has no mw.auth: the controls stay hidden and the device key signs, as before.
// The other scripts of a page listen to mw.auth.onChange themselves; this file only draws the header bar.
import { $, setText, show, toast, loadSdk, explain, hasAuth } from '/js/common.js';

async function main() {
  const mw = await loadSdk();
  if (!hasAuth(mw)) return;
  let info;
  try { info = (await mw.ready()) || {}; } catch (err) { return; }
  let current = { state: info.auth === 'signed-in' ? 'signed-in' : 'guest', identity: info.identity || null, role: info.role };
  const draw = () => {
    const guest = current.state !== 'signed-in', id = current.identity || {};
    show('#auth-bar', true); show('#sign-in', guest); show('#sign-out', !guest);
    setText('#auth-state', guest ? 'You are browsing as a guest.' : 'Signed in as ' + (id.name ? id.name + ' ' : '') + '(' + (id.short || '-') + ').');
    document.documentElement.dataset.auth = current.state;
  };
  draw();
  const run = (fn, ok) => async () => {
    try { await fn(); toast(ok, 'ok'); } catch (err) { toast(explain(err), err && err.code === 'E_USER_CANCELLED' ? 'info' : 'error'); }
  };
  $('#sign-in').addEventListener('click', run(() => mw.auth.signIn(), 'Signed in.'));
  $('#sign-out').addEventListener('click', run(() => mw.auth.signOut(), 'Signed out. This site no longer holds your keys.'));
  if (typeof mw.auth.onChange === 'function') {
    mw.auth.onChange((a) => {
      if (!a || typeof a !== 'object') return;
      current = { state: a.state === 'signed-in' ? 'signed-in' : 'guest', identity: a.identity || null, role: a.role };
      draw();
    });
  }
}
main();
