/* existing-site fixture, widgets variant: the page script of the Example Forum. It listens to the <mw-signin> button and writes what
   happened into the page, and it mirrors the same values on window.__forum so end-to-end tests assert on values instead of scraping
   text. A classic script, text set with textContent only. The widget fires "mw-signin" on its element with
   { state: 'pending' | 'signed-in' | 'error', code?, status?, body? }; body is what the forum's server answered to the proof. */
(function () {
  'use strict';
  var state = window.__forum = { jsRan: true, events: [], signedIn: false, pub: null, keyMode: null, error: null, status: null };
  var statusLine = document.getElementById('signin-status');
  var button = document.querySelector('mw-signin');
  function say(text) {
    if (statusLine) statusLine.textContent = text;
  }
  if (!button) {
    state.error = 'no-widget';
    return;
  }
  button.addEventListener('mw-signin', function (e) {
    var d = e && e.detail ? e.detail : {};
    state.events.push(d.state + (d.code ? ':' + d.code : ''));
    state.status = typeof d.status === 'number' ? d.status : state.status;
    if (d.state === 'signed-in') {
      var body = d.body && typeof d.body === 'object' ? d.body : {};
      state.signedIn = true;
      state.error = null;
      state.pub = typeof body.pub === 'string' ? body.pub : null;
      state.keyMode = typeof body.keyMode === 'string' ? body.keyMode : null;
      say((state.pub ? 'Signed in as ' + state.pub.slice(0, 14) + '...' : 'Signed in.') + ' The forum\'s server checked the proof.');
    } else if (d.state === 'error') {
      state.error = d.code || 'error';
      say('Sign-in did not finish (' + state.error + ').');
    } else {
      say('Waiting for the identity page...');
    }
  });
}());
