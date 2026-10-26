// The home timeline (R 3.5): your posts and the posts of the people you follow, merged in this browser by (time, hash), newest
// first, 30 to a page, with an "N new posts" button instead of a feed that moves under your thumb. No ranking and no
// recommendations; the filters are posts, replies, media and one person. On any other page of this origin (a visitor's, a group's)
// the route shows that site instead, because the timeline lives in the member's own home (R 3.1).

import { h, setChildren, reconcile, announce, scrollToTop, debounce } from '../dom.js';
import * as M from '../model.js';
import { LocalIndex } from '../search.js';
import { LIMITS } from '../config.js';
import { STATE, errorMessage } from '../strings.js';
import { hrefFor } from '../router.js';
import { stateCard, link } from './common.js';
import { postCard, cardSig } from './post-card.js';
import { composer } from './composer.js';
import { parseInviteLink } from '../hub.js';

export async function mount(ctx, route, container) {
  const d = ctx.data;
  if (d.state.kind === 'group') return (await import('./group.js')).mount(ctx, { name: 'group', label: d.state.label, site: true }, container);
  if (!d.isHome()) return (await import('./profile.js')).mount(ctx, { name: 'profile', label: d.state.label, site: true }, container);

  const st = { filter: 'all', person: '', pages: 1, topKey: '', announced: 0, q: '' };
  const index = new LocalIndex({ capBytes: ctx.env.deviceClass() === 'desktop' ? LIMITS.searchIndexBytesDesktop : LIMITS.searchIndexBytesPhone });
  const indexed = new Map();

  const comp = composer(ctx, { mode: 'post', onDone: () => { st.topKey = ''; st.pages = 1; draw(); } });
  const feed = h('div', { class: 'feed', id: 'feed', role: 'region', 'aria-label': 'Timeline' });
  const empty = h('div', { id: 'feed-empty' });
  const more = h('button', { type: 'button', class: 'btn', id: 'more', on: { click: () => { st.pages += 1; draw(); } } }, 'Show more');
  const fresh = h('button', { type: 'button', class: 'btn primary', id: 'new-posts', on: { click: () => { st.topKey = ''; st.pages = 1; draw(); scrollToTop(); } } });
  const freshBox = h('div', { class: 'new-posts', hidden: true }, fresh);
  const chips = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter the timeline' });
  const personSel = h('select', { id: 'person-filter', 'aria-label': 'Show one person', on: { change: (e) => { st.person = e.target.value; st.filter = st.person ? 'person' : 'all'; st.pages = 1; st.topKey = ''; draw(); } } });
  const results = h('div', { id: 'search-results', class: 'stack', 'aria-live': 'polite' });
  const search = h('input', { type: 'search', id: 'search', name: 'q', autocomplete: 'off', placeholder: 'Search what this browser holds', 'aria-describedby': 'search-note' });
  const runSearch = debounce(() => { st.q = search.value.trim(); drawSearch(); }, 200);
  search.addEventListener('input', runSearch);

  const FILTERS = [['all', 'All'], ['posts', 'Posts'], ['replies', 'Replies'], ['media', 'Media']];
  function drawChips() {
    setChildren(chips, FILTERS.map(([k, label]) => h('button', { type: 'button', class: 'tab', 'aria-pressed': st.filter === k ? 'true' : 'false', 'data-filter': k,
      on: { click: () => { st.filter = k; st.person = ''; personSel.value = ''; st.pages = 1; st.topKey = ''; draw(); } } }, label)));
    const people = d.timelineViews().filter((v) => v.id !== d.state.siteId);
    setChildren(personSel, [h('option', { value: '' }, 'One person...')].concat(people.map((v) => h('option', { value: v.id, selected: st.person === v.id }, d.nameOf(v.id) + ' (' + v.short + ')'))));
    personSel.value = st.person;
  }
  function updateIndex() {
    for (const v of d.timelineViews()) {
      for (const p of v.posts) { const k = p.key + '|' + p.latestH; if (indexed.get(p.key) !== k) { indexed.set(p.key, k); index.add({ id: p.key, kind: 'post', text: p.text, ts: p.ts, l: p.l, h: p.h }); } }
      const pk = 'profile|' + v.id + '|' + v.name + '|' + v.profile.bio;
      if (indexed.get('p' + v.id) !== pk) { indexed.set('p' + v.id, pk); index.add({ id: 'profile/' + v.id, kind: 'profile', text: (v.name || '') + ' ' + v.profile.bio, ts: 0, l: v.id }); }
    }
  }
  function drawSearch() {
    if (st.q.length < 2) { setChildren(results, []); return; }
    updateIndex();
    const hits = index.search(st.q, { limit: 20 });
    if (!hits.length) {
      setChildren(results, [h('p', { class: 'muted' }, 'Nothing in what this browser holds matches "' + st.q + '". There is no search across everyone; see About.')]);
      return;
    }
    const rows = hits.map((hit) => h('div', { class: 'card' }, hit.kind === 'profile'
      ? link(ctx, hrefFor('profile', { label: d.labelOf(hit.l) }), d.nameOf(hit.l) + ' (profile)')
      : [link(ctx, hrefFor('post', { label: d.labelOf(hit.l), h: hit.h }), d.nameOf(hit.l)), h('p', { class: 'small' }, hit.text.slice(0, 160))]));
    setChildren(results, [h('p', { class: 'small muted' }, hits.length + ' ' + (hits.length === 1 ? 'result' : 'results') + ' in what this browser holds, newest first.')].concat(rows));
  }
  function drawEmpty(all) {
    if (all.length) return setChildren(empty, []);
    const followCount = d.followedIds().size;
    setChildren(empty, [followCount === 0
      ? stateCard('', STATE.noFollows, [link(ctx, hrefFor('settings', { section: 'invite' }), 'Show my QR code', 'btn primary'), h('button', { type: 'button', class: 'btn', on: { click: () => { followBox.hidden = false; followInput.focus(); } } }, 'Follow by link')])
      : stateCard('', 'Nothing to show yet. Posts from the people you follow appear here as their pages sync.', [])]);
  }
  function draw() {
    updateIndex();
    const all = d.timeline({ filter: st.filter, person: st.person });
    st.topKey = M.timelineTop(all, st.topKey, d.state.siteId); // your own new post shows at once (E-SO-9)
    const newer = M.newerThan(all, st.topKey), shown = all.filter((it) => it.sortKey <= st.topKey);
    const page = shown.slice(0, st.pages * LIMITS.pageSize);
    drawChips();
    reconcile(feed, page, { key: (it) => it.key, sig: (it) => cardSig(ctx, it), build: (it) => postCard(ctx, it) });
    more.hidden = page.length >= shown.length;
    freshBox.hidden = !newer.length;
    fresh.textContent = newer.length + (newer.length === 1 ? ' new post' : ' new posts');
    if (newer.length > st.announced) announce(newer.length + (newer.length === 1 ? ' new post' : ' new posts')); st.announced = newer.length;
    drawEmpty(all);
    if (st.q) drawSearch();
  }

  const followInput = h('input', { type: 'text', id: 'follow-link', name: 'link', autocomplete: 'off', placeholder: 'Paste a link or a pointer' });
  const followNote = h('p', { class: 'small', role: 'status' });
  const followBox = h('form', { class: 'card stack', hidden: true, id: 'follow-form', on: { submit: async (ev) => {
    ev.preventDefault();
    const parsed = parseInviteLink(followInput.value);
    if (!parsed || !parsed.pointer) { followNote.textContent = 'That link has no pointer, so this browser cannot find the page. Ask for the whole link or the QR code.'; return; }
    try { await d.follow(parsed.pointer); followNote.textContent = 'Following. Their posts appear as their page syncs.'; followInput.value = ''; draw(); } catch (err) { followNote.textContent = errorMessage(err); }
  } } }, h('div', { class: 'field' }, h('label', { for: 'follow-link' }, 'Follow by link'), followInput,
    h('p', { class: 'hint' }, 'A link looks like the address of someone\'s page, with the long pointer after the # sign.')), followNote, h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'btn primary' }, 'Follow')));

  container.append(h('section', { class: 'card', 'aria-label': 'New post' }, comp.node),
    h('form', { class: 'card stack', role: 'search', on: { submit: (e) => { e.preventDefault(); st.q = search.value.trim(); drawSearch(); } } },
      h('div', { class: 'field' }, h('label', { for: 'search' }, 'Search'), search, h('p', { id: 'search-note', class: 'hint' }, 'Searches the posts and profiles this browser holds. There is no search across everyone.')), results),
    h('div', { class: 'row' }, chips, personSel), followBox, freshBox, feed, empty, h('div', { class: 'row' }, more));
  draw();
  const redraw = throttleDraw(draw);
  ctx.onData('change', redraw);
  ctx.onData('own-write', () => { st.topKey = ''; }); // what you just did shows at once; only other people's new posts wait for a tap
  return { title: 'Timeline' };
}
function throttleDraw(fn) {
  let t = 0;
  return () => { if (t) return; t = setTimeout(() => { t = 0; fn(); }, 120); };
}
