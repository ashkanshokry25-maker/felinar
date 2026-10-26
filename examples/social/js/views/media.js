// Private photos and videos (R 2.9, 3.5): encrypted on the device, in the site's swarm, readable by you after you sign in, by the site's own
// code on this origin while you are signed in (on a hub, the hub's code) and by
// the people you share them with. The grid shows poster frames (open(id, { part: 'poster' })); the viewer plays with a plain
// <video src>, which the loader's Service Worker answers with Range requests. Each item says whether the hub keeps it or whether
// it is available only while someone who has it is connected.

import { h, setChildren, armedButton, formatBytes } from '../dom.js';
import { hrefFor } from '../router.js';
import { AVAILABLE, errorMessage } from '../strings.js';
import { stateCard, link, openDialog } from './common.js';
import { pickKind } from '../media-prep.js';

const PHASE = { strip: 'Removing location and camera details', poster: 'Making a preview', encrypt: 'Encrypting on this device', seed: 'Getting ready to share' };
const PAGE = 24;

export async function mount(ctx, route, container) {
  const d = ctx.data, mw = ctx.mw;
  if (!d.signedIn()) { container.append(stateCard('', 'Sign in to see your private photos and videos.', [h('button', { type: 'button', class: 'btn primary', on: { click: () => ctx.signIn() } }, 'Sign in')])); return { title: 'Media' }; }
  if (!mw.media) { container.append(stateCard('', errorMessage({ code: 'NOT_AVAILABLE' }), [])); return { title: 'Media' }; }
  const opened = new Set();
  const destroy = () => { for (const id of opened) { try { mw.media.close(id); } catch (e) { /* gone */ } } };
  return route.id ? viewer(ctx, route, container, opened, destroy) : grid(ctx, container, opened, destroy);
}

function availability(item) {
  return item.available === 'kept' ? AVAILABLE.kept : AVAILABLE.other;
}

async function grid(ctx, container, opened, destroy) {
  const mw = ctx.mw;
  const st = { from: 'mine', shown: PAGE, items: [], busy: false };
  const list = h('ul', { class: 'poster-grid', id: 'poster-grid', 'aria-label': 'Photos and videos' });
  const empty = h('div', {});
  const bar = h('div', { class: 'progress', hidden: true }, h('span', { id: 'upload-bar' }));
  const line = h('p', { class: 'small', role: 'status', id: 'upload-line' });
  const more = h('button', { type: 'button', class: 'btn', hidden: true, on: { click: () => { st.shown += PAGE; draw(); } } }, 'Show more');
  const pick = h('input', { type: 'file', id: 'media-file', accept: 'image/*,video/*', 'aria-describedby': 'media-hint', on: { change: choose } });
  const chosenRow = h('div', { class: 'row between', id: 'media-chosen', hidden: true });
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Whose photos and videos' });
  let chosen = null;

  // mw.media.upload opens a card and the loader accepts it only for a call that comes from a click (R 2.11.1). A file chooser closing is
  // not one, so choosing only picks the file and "Encrypt and upload" is the tap that uploads it.
  function choose(ev) {
    const f = ev.target.files[0]; ev.target.value = '';
    if (!f) return;
    if (!pickKind(f)) { ctx.fail({ code: 'E_MEDIA_TYPE' }); return; }
    chosen = f; drawChosen();
  }
  function drawChosen() {
    chosenRow.hidden = !chosen;
    setChildren(chosenRow, chosen ? [h('span', {}, chosen.name + ' (' + formatBytes(chosen.size) + ')'), h('span', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', id: 'media-upload', on: { click: upload } }, 'Encrypt and upload'),
      h('button', { type: 'button', class: 'btn', on: { click: () => { chosen = null; drawChosen(); } } }, 'Cancel'))] : []);
  }
  async function upload() {
    const f = chosen;
    if (!f) return;
    chosen = null; drawChosen();
    bar.hidden = false; line.textContent = 'Starting...';
    const fill = bar.firstChild;
    try {
      await ctx.data.ensureFeature('media'); // on your own page the first private photo turns the switch on; the loader refuses an upload without it
      const res = await mw.media.upload(f, { onProgress: ({ phase, done, total }) => {
        line.textContent = PHASE[phase] || phase;
        fill.style.width = (total ? Math.round((done / total) * 100) : 5) + '%';
      } });
      line.textContent = 'Done. ' + (res.kind === 'video' ? 'Video' : 'Photo') + ' (' + formatBytes(res.len) + ') is encrypted and ready.';
      await load();
    } catch (e) { line.textContent = ''; if (!e || e.code !== 'E_USER_CANCELLED') ctx.fail(e); } finally { bar.hidden = true; }
  }
  async function load() {
    try { st.items = await mw.media.list({ from: st.from }); } catch (e) { ctx.fail(e); st.items = []; }
    draw();
  }
  async function poster(item, holder) {
    try {
      const out = await mw.media.open(item.id, { part: 'poster' });
      opened.add(item.id);
      if (holder.isConnected) setChildren(holder, [h('img', { src: out.url, alt: (item.kind === 'video' ? 'Video' : 'Photo') + ' from ' + new Date(item.t || Date.now()).toLocaleDateString(), loading: 'lazy' })]);
    } catch (e) { if (holder.isConnected) setChildren(holder, [h('span', { class: 'ph' }, errorMessage(e))]); }
  }
  function draw() {
    setChildren(tabs, [['mine', 'Mine'], ['received', 'Shared with me']].map(([k, label]) => h('button', { type: 'button', class: 'tab', 'aria-pressed': st.from === k ? 'true' : 'false', on: { click: () => { st.from = k; st.shown = PAGE; load(); } } }, label)));
    const items = st.items.slice().sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, st.shown);
    setChildren(list, items.map((it) => {
      const holder = h('span', { class: 'ph' }, it.kind === 'video' ? 'Video' : 'Photo');
      const a = h('a', { href: hrefFor('media', { id: it.id }), 'aria-label': (it.kind === 'video' ? 'Open video ' : 'Open photo ') + formatBytes(it.len) }, holder);
      const li = h('li', { class: 'poster', 'data-media': it.id }, a, h('p', { class: 'small muted' }, availability(it)));
      poster(it, a);
      return li;
    }));
    more.hidden = st.items.length <= st.shown;
    setChildren(empty, st.items.length ? [] : [stateCard('', st.from === 'mine' ? 'You have no private photos or videos yet. Choose one above: it is encrypted before it leaves this device.' : 'Nobody has shared a photo or video with you yet.', [])]);
  }
  container.append(h('section', { class: 'card stack' }, h('h2', {}, 'Add a photo or video'),
    h('p', { id: 'media-hint', class: 'hint' }, 'Encrypted before it leaves this device. Only you, after signing in, and the people you share it with can open it. The site\'s own code can open it while you are signed in; on a hub, that code is the hub\'s. People you share with can keep a copy. Up to ' + (ctx.env.deviceClass() === 'desktop' ? '100 MiB' : '25 MiB') + ' on this device.'),
    h('label', { for: 'media-file', class: 'sr-only' }, 'Choose a photo or video'), pick, chosenRow, bar, line),
  tabs, list, empty, h('div', { class: 'row' }, more));
  for (const ev of ['received', 'shared', 'revoked', 'unavailable']) { try { const off = mw.media.on(ev, () => load()); if (typeof off === 'function') ctx.subs.push(off); } catch (e) { /* older loader */ } }
  await load();
  return { title: 'Photos and videos', destroy };
}

async function viewer(ctx, route, container, opened, destroy) {
  const mw = ctx.mw, id = route.id;
  const stage = h('div', { class: 'viewer', id: 'viewer' });
  const meta = h('p', { class: 'small', id: 'media-meta', role: 'status' });
  const actions = h('div', { class: 'row', id: 'media-actions' });
  container.append(h('div', { class: 'row' }, link(ctx, hrefFor('media'), 'All photos and videos', 'btn small')), h('section', { class: 'card stack' }, stage, meta, actions));
  let item = null;
  try { item = (await mw.media.list({ from: 'all' })).find((x) => x.id === id) || null; } catch (e) { /* the open below reports it */ }
  try {
    const out = await mw.media.open(id);
    opened.add(id);
    let posterUrl = null;
    try { posterUrl = (await mw.media.open(id, { part: 'poster' })).url; } catch (e) { /* no poster */ }
    const isVideo = /^video\//.test(out.mime || '') || (item && item.kind === 'video');
    const node = isVideo
      ? h('video', { src: out.url, controls: true, playsinline: true, preload: 'metadata', poster: posterUrl || null, 'aria-label': 'Private video' })
      : h('img', { src: out.url, alt: 'Private photo', width: out.w || null, height: out.h || null });
    setChildren(stage, [node]);
    if (isVideo) node.addEventListener('error', () => setChildren(stage, [h('p', { class: 'error', role: 'alert' }, errorMessage({ code: 'E_MEDIA_UNPLAYABLE' })), h('a', { class: 'btn', href: out.url, download: 'video' }, 'Download instead')]));
    meta.textContent = (item ? availability(item) + '. ' : '') + (item && item.len ? formatBytes(item.len) + '. ' : '') + (out.duration ? Math.round(out.duration) + ' s. ' : '');
  } catch (e) { setChildren(stage, [h('p', { class: 'error', role: 'alert' }, errorMessage(e))]); }

  const keep = h('input', { type: 'checkbox', id: 'keep-available', on: { change: async (ev) => { try { await mw.media.keepAvailable(id, ev.target.checked); ctx.note('Saved.', 'ok'); } catch (e) { ev.target.checked = !ev.target.checked; ctx.fail(e); } } } });
  setChildren(actions, [
    h('button', { type: 'button', class: 'btn', id: 'share', on: { click: () => shareDialog(ctx, id) } }, 'Share'),
    h('button', { type: 'button', class: 'btn', id: 'revoke', on: { click: () => revokeDialog(ctx, id) } }, 'Take back access'),
    typeof mw.media.pinRequest === 'function' ? h('button', { type: 'button', class: 'btn', on: { click: async () => { try { await mw.media.pinRequest(id); ctx.note('Asked the hub to keep it.', 'ok'); } catch (e) { ctx.fail(e); } } } }, 'Ask the hub to keep it') : null,
    h('label', { class: 'check', for: 'keep-available' }, keep, 'Keep it available while this page is open'),
    armedButton('Delete', async () => { await mw.media.delete(id); ctx.note('Deleted.', 'ok'); ctx.go(hrefFor('media')); }, { cls: 'btn danger' })]);
  return { title: 'Photo or video', destroy };
}

async function pickPeople(ctx) {
  const inbox = ctx.inbox;
  if (!ctx.chat || !inbox) throw Object.assign(new Error('NOT_AVAILABLE'), { code: 'NOT_AVAILABLE' });
  if (!inbox.state.loaded) await inbox.loadContacts();
  return inbox.state.contacts;
}
async function shareDialog(ctx, id) {
  let people;
  try { people = await pickPeople(ctx); } catch (e) { ctx.fail(e); return; }
  if (!people.length) { ctx.note('You have no contacts to share with yet.', 'info'); return; }
  const boxes = people.map((p, i) => h('label', { class: 'check', for: 'sh' + i }, h('input', { type: 'checkbox', id: 'sh' + i, value: p.pub }), (p.name || p.short) + ' (' + p.short + ')'));
  openDialog(ctx, { title: 'Share with', body: h('div', { class: 'stack' }, h('p', { class: 'small' }, PRIVACY_SHARE), boxes),
    actions: [{ label: 'Share', run: async (close) => {
      const to = boxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
      if (!to.length) return;
      const out = await ctx.mw.media.share(id, { to }); close();
      ctx.note('Shared with ' + out.granted.length + (out.granted.length === 1 ? ' person' : ' people') + (out.held && out.held.length ? '. ' + out.held.length + ' will get it when they are connected to you.' : '.'), 'ok');
    } }] });
}
async function revokeDialog(ctx, id) {
  let people;
  try { people = await pickPeople(ctx); } catch (e) { ctx.fail(e); return; }
  const boxes = people.map((p, i) => h('label', { class: 'check', for: 'rv' + i }, h('input', { type: 'checkbox', id: 'rv' + i, value: p.pub }), (p.name || p.short) + ' (' + p.short + ')'));
  const again = h('label', { class: 'check', for: 'reenc' }, h('input', { type: 'checkbox', id: 'reenc' }), 'Encrypt it again with a new key (slower; people who already saved a copy keep it)');
  openDialog(ctx, { title: 'Take back access', body: h('div', { class: 'stack' }, h('p', { class: 'small' }, 'This asks their browsers to delete their key and chunks. It cannot take back a copy someone already saved.'), boxes, again),
    actions: [{ label: 'Take back', cls: 'btn danger', run: async (close) => {
      const from = boxes.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
      const out = await ctx.mw.media.revoke(id, { from: from.length ? from : undefined, reencrypt: again.querySelector('input').checked }); close();
      ctx.note('Took back access from ' + out.revoked.length + (out.revoked.length === 1 ? ' person' : ' people') + '.', 'ok');
    } }] });
}
const PRIVACY_SHARE = 'People you share with can open it after they accept, and they can keep a copy. Encrypted before it leaves this device.';
