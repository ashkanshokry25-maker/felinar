// The invite: the link to your page with the pointer in the fragment (which never reaches the host), a QR code of it, and how to
// use your own domain as a handle (R 3.4). The QR encoder is js/qr.js; the code is drawn as one SVG path, never as HTML.

import { h, svg, setChildren } from '../dom.js';
import { encodeQr, qrPath } from '../qr.js';
import { inviteLink, hubHost } from '../hub.js';

export function qrNode(text, label) {
  let sym;
  try { sym = encodeQr(text, { ecc: 'L' }); } catch (err) { return h('p', { class: 'error', role: 'alert' }, 'This link is too long for a QR code. Copy the link instead.'); }
  const { d, size } = qrPath(sym, { border: 4 });
  return svg('svg', { viewBox: '0 0 ' + size + ' ' + size, role: 'img', 'aria-label': label || 'QR code', 'data-qr-version': sym.version, 'shape-rendering': 'crispEdges' },
    svg('rect', { width: size, height: size, fill: '#ffffff' }), svg('path', { d, fill: '#000000' }));
}

/** inviteCard(ctx) -> { node }: fills in once the page's pointer is known. */
export function inviteCard(ctx) {
  const d = ctx.data;
  const box = h('div', { class: 'stack', id: 'invite' });
  const out = h('div', { class: 'qr' });
  const input = h('input', { type: 'text', id: 'invite-link', readonly: true, 'aria-label': 'Link to your page' });
  const note = h('p', { class: 'small muted', role: 'status', id: 'invite-note' });
  const copy = h('button', { type: 'button', class: 'btn', id: 'invite-copy', on: { click: async () => {
    try { await navigator.clipboard.writeText(input.value); ctx.note('Link copied.', 'ok'); } catch (err) { input.select(); ctx.note('Press copy on your keyboard to copy the selected link.', 'info'); }
  } } }, 'Copy link');
  setChildren(box, [
    h('p', {}, 'Share this link or show the code. Opening it shows your page, and a member who is signed in can follow you in one tap. The long part after the # sign is your page\'s pointer; it stays in the browser and never reaches the host.'),
    h('div', { class: 'field' }, h('label', { for: 'invite-link' }, 'Your link'), input), h('div', { class: 'row' }, copy), note, out]);
  ctx.hub.ownPointer().then((pointer) => {
    const link = inviteLink({ label: d.state.label, pointer }, location);
    input.value = link;
    note.textContent = pointer ? '' : 'This browser cannot read your page\'s pointer yet, so the link below opens your page only for people who already follow it. Open your page from the link you made it with, or from the loader\'s settings, and try again.';
    setChildren(out, [qrNode(link, 'QR code of the link to your page'), h('p', { class: 'small muted' }, hubHost(location) ? 'Scan it with a phone camera to open your page.' : 'Preview: this address is not a hub address.')]);
  }).catch(() => { note.textContent = 'Could not build the link.'; });
  return { node: box };
}
