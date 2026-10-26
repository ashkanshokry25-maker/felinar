// The composer (R 3.5, 3.7): a text box with a counter, up to 4 pictures or videos, a description for every public picture
// (the Post button stays off until each has one), the spam-fee progress line, and drafts kept on this device (at most 20; a post
// that fails is saved there). It also edits: the same form with the post's text and pictures, saved as a new version.
// A chosen file is shared with its own tap on "Share": mw.files.share opens a card and the loader accepts it only for a call that
// comes from a click (R 2.11.1), which a file chooser closing does not give (the click that opened it is long past).

import { h, setChildren, debounce, formatBytes } from '../dom.js';
import * as M from '../model.js';
import { LIMITS } from '../config.js';
import { errorMessage, fieldError } from '../strings.js';
import { KEYS as SK } from '../store.js';
import { pickKind } from '../media-prep.js';

let uid = 0;

/**
 * composer(ctx, { mode, item, to, placeholder, onDone }) -> { node, focus }
 * mode: 'post' (your wall), 'wall' (a post addressed to someone else's wall: to = their ledger id), 'edit' (item = the post being edited).
 */
export function composer(ctx, opts = {}) {
  const id = 'cmp' + (++uid), mode = opts.mode || 'post', item = opts.item || null;
  const state = { attachments: [], busy: false, error: '', draftId: mode === 'edit' ? '' : 'draft-' + Date.now() + '-' + id };
  if (item) {
    state.attachments = item.media.map((m, i) => ({ id: 'a' + i, name: m.alt || 'Picture', size: m.len || 0, kind: m.kind, ref: m.ref, alt: m.alt, status: 'ready' }));
  }
  const label = mode === 'edit' ? 'Edit your post' : mode === 'wall' ? 'Write on this wall' : 'Write a post';
  const area = h('textarea', { id: id + '-text', name: 'text', rows: 4, placeholder: opts.placeholder || 'What is on your mind?', 'aria-describedby': id + '-count ' + id + '-hint', maxlength: LIMITS.postChars });
  area.value = item ? item.text : mode === 'post' ? (ctx.store.get(SK.drafts, []).find((d) => d.id === 'current') || { text: '' }).text : '';
  const counter = h('span', { id: id + '-count', class: 'counter' }, '0 / ' + LIMITS.postChars);
  const hint = h('p', { id: id + '-hint', class: 'small muted', role: 'status' });
  const list = h('ul', { class: 'attach', 'aria-label': 'Attached pictures and videos' });
  const feeLine = h('p', { class: 'small', role: 'status', 'aria-live': 'polite' });
  const errors = h('p', { class: 'error', role: 'alert' });
  const post = h('button', { type: 'submit', class: 'btn primary', id: id + '-post' }, mode === 'edit' ? 'Save edit' : 'Post');
  const file = h('input', { type: 'file', id: id + '-file', accept: 'image/*,video/*', multiple: true, 'aria-label': 'Add pictures or videos' });
  const draftsBox = h('details', { class: 'history' });
  const mention = mode === 'edit' ? null : h('select', { id: id + '-mention', 'aria-label': 'Mention someone', hidden: true, on: { change: (ev) => {
    const short = ev.target.value; ev.target.value = '';
    if (!short) return;
    const at = area.selectionStart == null ? area.value.length : area.selectionStart, pad = at > 0 && !/\s/.test(area.value[at - 1]) ? ' ' : '';
    area.value = area.value.slice(0, at) + pad + '@' + short + ' ' + area.value.slice(at);
    area.focus(); state.error = ''; refresh(); if (mode === 'post') saveCurrent();
  } } });
  // The people you can mention are the pages this browser holds; the list follows the data as pages arrive.
  const refreshPeople = () => {
    if (!mention || document.activeElement === mention) return;
    const people = ctx.data.timelineViews().filter((v) => v.id !== ctx.data.state.siteId && v.owner && v.short).slice(0, 60);
    setChildren(mention, [h('option', { value: '' }, 'Mention someone...')].concat(people.map((v) => h('option', { value: v.short }, ctx.data.nameOf(v.id) + ' (' + v.short + ')'))));
    mention.hidden = !people.length;
  };
  if (mention) { refreshPeople(); ctx.onData('change', refreshPeople); }

  const ready = () => state.attachments.filter((a) => a.status === 'ready');
  const draft = () => ({ text: area.value, media: ready().map((a) => ({ ref: a.ref, kind: a.kind, alt: a.alt })), to: mode === 'wall' ? opts.to : undefined, edit: item ? item.h : undefined });
  function refresh() {
    const text = area.value;
    counter.textContent = text.length.toLocaleString('en-US') + ' / ' + LIMITS.postChars.toLocaleString('en-US');
    counter.classList.toggle('over', text.length > LIMITS.postChars);
    const check = M.validatePostDraft(draft());
    const uploading = state.attachments.some((a) => a.status === 'uploading' || a.status === 'chosen');
    const needAlt = check.errors.some((e) => e.code === 'ALT_REQUIRED');
    hint.textContent = needAlt ? fieldError({ code: 'ALT_REQUIRED' }) : state.attachments.length >= LIMITS.mediaPerPost ? 'You can attach up to 4 pictures or videos.' : 'Pictures are public. Location and camera details are removed. People who fetch them see your IP address.';
    const blocking = check.errors.filter((e) => e.code !== 'EMPTY');
    post.disabled = state.busy || uploading || !check.ok;
    errors.textContent = state.error || (blocking.length && !needAlt && text.length > 0 ? fieldError(blocking[0]) : '');
    file.disabled = state.attachments.length >= LIMITS.mediaPerPost || state.busy;
    renderAttachments();
  }
  function renderAttachments() {
    setChildren(list, state.attachments.map((a, i) => h('li', { 'data-attachment': a.id },
      h('div', { class: 'row between' }, h('span', {}, a.name + (a.size ? ' (' + formatBytes(a.size) + ')' : '') + (a.status === 'uploading' ? ' - sharing...' : a.status === 'error' ? ' - failed' : '')),
        h('span', { class: 'row' },
          a.status === 'chosen' ? h('button', { type: 'button', class: 'btn small primary', 'data-share': a.id, on: { click: () => upload(a) } }, a.kind === 'video' ? 'Share video' : 'Share picture') : null,
          h('button', { type: 'button', class: 'btn small', on: { click: () => { state.attachments.splice(i, 1); refresh(); } } }, 'Remove'))),
      a.status === 'ready' ? h('div', { class: 'field' },
        h('label', { for: id + '-alt' + a.id }, a.kind === 'video' ? 'Describe the video (optional)' : 'Describe this picture (required)', h('span', { class: 'hint' }, ' ' + (a.alt || '').length + ' / ' + LIMITS.altChars)),
        h('input', { type: 'text', id: id + '-alt' + a.id, value: a.alt || '', maxlength: LIMITS.altChars, required: a.kind !== 'video', 'aria-invalid': a.kind !== 'video' && !(a.alt || '').trim() ? 'true' : 'false',
          on: { input: (ev) => { a.alt = ev.target.value; refreshSoft(); } } })) : null,
      a.error ? h('p', { class: 'error', role: 'alert' }, a.error) : null)));
  }
  const refreshSoft = () => { const check = M.validatePostDraft(draft()); post.disabled = state.busy || state.attachments.some((a) => a.status === 'uploading' || a.status === 'chosen') || !check.ok; hint.textContent = check.errors.some((e) => e.code === 'ALT_REQUIRED') ? fieldError({ code: 'ALT_REQUIRED' }) : hint.textContent; };

  async function addFiles(files) {
    for (const f of Array.from(files)) {
      if (state.attachments.length >= LIMITS.mediaPerPost) break;
      const kind = pickKind(f);
      const att = { id: 'u' + Date.now() + state.attachments.length, name: f.name || 'file', size: f.size, kind, file: f, ref: null, alt: '', status: 'chosen' };
      if (!kind) { ctx.fail({ code: 'E_MEDIA_TYPE' }); continue; }
      if (kind === 'video' && f.size > LIMITS.publicVideoBytes) { ctx.fail({ code: 'E_LIMIT' }); continue; }
      state.attachments.push(att);
    }
    file.value = '';
    refresh();
  }
  async function upload(att) { // inside the click on "Share picture": the loader shows its card, strips location and camera details, then lists the file
    att.status = 'uploading'; refresh();
    try {
      await ctx.data.ensureFeature('files'); // on your own page the first picture turns the switch on; the loader refuses a share without it
      const out = await ctx.mw.files.share(att.file, { public: true });
      att.ref = out.ref; att.status = 'ready'; att.file = null;
    } catch (err) {
      att.status = 'chosen'; // still there to try again or to remove
      if (!err || err.code !== 'E_USER_CANCELLED') ctx.fail(err);
    }
    refresh();
  }
  file.addEventListener('change', () => addFiles(file.files));
  area.addEventListener('input', () => { state.error = ''; refresh(); if (mode === 'post') saveCurrent(); });
  const saveCurrent = debounce(() => {
    const rest = ctx.store.get(SK.drafts, []).filter((d) => d.id !== 'current');
    ctx.store.set(SK.drafts, area.value.trim() ? M.upsertDraft(rest, { id: 'current', text: area.value, savedAt: Date.now() }) : rest);
  }, 400);

  function renderDrafts() {
    const drafts = ctx.store.get(SK.drafts, []).filter((d) => d.id !== 'current');
    setChildren(draftsBox, [h('summary', {}, 'Drafts (' + drafts.length + ' of ' + LIMITS.drafts + ')'),
      drafts.length ? h('ul', { class: 'stack tight' }, drafts.map((d) => h('li', { class: 'row between' },
        h('span', {}, (d.failed ? 'Not posted: ' : '') + d.text.slice(0, 80)),
        h('span', { class: 'row' },
          h('button', { type: 'button', class: 'btn small', on: { click: () => { area.value = d.text; ctx.store.set(SK.drafts, M.removeDraft(ctx.store.get(SK.drafts, []), d.id)); refresh(); renderDrafts(); area.focus(); } } }, 'Restore'),
          h('button', { type: 'button', class: 'btn small', on: { click: () => { ctx.store.set(SK.drafts, M.removeDraft(ctx.store.get(SK.drafts, []), d.id)); renderDrafts(); } } }, 'Delete'))))) : h('p', { class: 'small muted' }, 'Drafts stay on this device. Nothing is sent until you post.')]);
  }
  const saveDraft = h('button', { type: 'button', class: 'btn small', on: { click: () => {
    if (!area.value.trim()) return;
    ctx.store.set(SK.drafts, M.upsertDraft(ctx.store.get(SK.drafts, []).filter((d) => d.id !== 'current'), { id: state.draftId, text: area.value, savedAt: Date.now() }));
    ctx.note('Saved to Drafts on this device.', 'ok'); renderDrafts();
  } } }, 'Save draft');

  const form = h('form', { class: 'composer stack', novalidate: true, 'data-composer': mode,
    on: { submit: async (ev) => {
      ev.preventDefault();
      const check = M.validatePostDraft(draft());
      if (!check.ok) { state.error = fieldError(check.errors[0]); refresh(); return; }
      state.busy = true; state.error = ''; refresh();
      const ctl = new AbortController();
      try {
        const onProgress = ({ hashes }) => { feeLine.textContent = 'Working out the spam fee for this post (' + Number(hashes || 0).toLocaleString('en-US') + ' tries)'; };
        const res = mode === 'edit' ? await ctx.data.editPost(item.h, check.value, { onProgress, signal: ctl.signal }) : await ctx.data.addPost(check.value, { onProgress, signal: ctl.signal });
        feeLine.textContent = '';
        if (mode !== 'edit') { area.value = ''; state.attachments = []; ctx.store.set(SK.drafts, M.removeDraft(ctx.store.get(SK.drafts, []), 'current')); }
        ctx.note(mode === 'edit' ? 'Saved. People see the edit as their copies sync.' : 'Posted. Your signed post is on its way to the people who follow you.', 'ok');
        state.busy = false; refresh(); renderDrafts();
        if (opts.onDone) opts.onDone(res);
      } catch (err) {
        state.busy = false; feeLine.textContent = '';
        if (mode !== 'edit') ctx.store.set(SK.drafts, M.upsertDraft(ctx.store.get(SK.drafts, []).filter((d) => d.id !== 'current'), { id: state.draftId, text: area.value, savedAt: Date.now(), failed: true }));
        state.error = errorMessage(err) + (mode !== 'edit' ? ' Your text is saved in Drafts.' : '');
        refresh(); renderDrafts();
      }
    } } },
    h('div', { class: 'field' }, h('label', { for: id + '-text' }, label), area, h('div', { class: 'row between' }, counter)),
    list, hint,
    h('div', { class: 'row' }, h('label', { for: id + '-file', class: 'sr-only' }, 'Add pictures or videos'), file), mention,
    feeLine, errors,
    h('div', { class: 'row between' }, mode === 'edit' ? h('button', { type: 'button', class: 'btn', on: { click: () => opts.onCancel && opts.onCancel() } }, 'Cancel') : saveDraft, post),
    mode === 'edit' ? null : draftsBox);
  renderDrafts(); refresh();
  return { node: form, focus: () => area.focus() };
}
