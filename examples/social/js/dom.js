// Small DOM helpers. Text from other people only ever becomes a Text node or textContent; nothing here parses markup, and the
// social-site test rejects every API that turns a string into elements, anywhere in this folder.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * h(tag, attrs, ...children). attrs: class, text, on: { event: fn }, props: { name: value } (set as properties), and any other
 * key as an attribute (false, null and undefined are skipped, true sets an empty attribute). Children: nodes, strings, numbers
 * (arrays are flattened); null, false and '' are skipped.
 */
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const key of Object.keys(attrs || {})) {
    const value = attrs[key];
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'on') for (const ev of Object.keys(value)) node.addEventListener(ev, value[ev]);
    else if (key === 'props') for (const p of Object.keys(value)) node[p] = value[p];
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}
export function append(node, children) {
  for (const child of children) {
    if (Array.isArray(child)) append(node, child);
    else if (child !== null && child !== undefined && child !== false && child !== '') node.append(child instanceof Node ? child : String(child));
  }
  return node;
}
export function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs || {})) if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, String(attrs[key]));
  append(node, children);
  return node;
}
export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
export function setChildren(node, children) { clear(node); return append(node, children); }

/**
 * reconcile(container, items, { key, sig, build }): keep one child per item in order, rebuilding a child only when its
 * signature changed, so focus, half-typed replies and open disclosures survive an update. Returns the number rebuilt.
 */
export function reconcile(container, items, { key, sig, build }) {
  const old = new Map();
  for (const child of Array.from(container.children)) if (child.dataset && child.dataset.rk) old.set(child.dataset.rk, child);
  let rebuilt = 0;
  const next = [];
  for (const item of items) {
    const k = String(key(item)), s = sig ? String(sig(item)) : '';
    let node = old.get(k);
    if (!node || node.dataset.rs !== s) {
      node = build(item);
      node.dataset.rk = k; node.dataset.rs = s;
      rebuilt++;
    }
    next.push(node);
  }
  const keep = new Set(next);
  let cursor = container.firstElementChild;
  for (const node of next) {
    while (cursor && !keep.has(cursor)) cursor = cursor.nextElementSibling; // a node that is about to go does not count as a position
    if (node === cursor) cursor = cursor.nextElementSibling; else container.insertBefore(node, cursor);
  }
  for (const child of Array.from(container.children)) if (!keep.has(child)) child.remove();
  return rebuilt;
}

/** The two live regions of the page: a polite one for "N new posts" and messages, an assertive one for errors. */
export function announce(message, { assertive = false } = {}) {
  const region = document.getElementById(assertive ? 'live-assertive' : 'live-polite');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => { region.textContent = message; }, 30); // a changed node is read; the same text twice is not
}
export function toast(message, kind) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const node = h('div', { class: 'toast ' + (kind || 'info'), role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 9000 : 5000);
  if (kind === 'error') announce(message, { assertive: true });
}

export const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (err) { return false; } };
export function scrollToTop() { try { window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (err) { window.scrollTo(0, 0); } }

/** Two taps instead of a modal dialog: the shell sandbox has no allow-modals, and phones tap better than they confirm(). */
export function armedButton(label, run, { cls = 'btn danger', confirmLabel = 'Tap again to confirm' } = {}) {
  const btn = h('button', { type: 'button', class: cls }, label);
  let timer = 0;
  const reset = () => { clearTimeout(timer); btn.dataset.armed = ''; btn.textContent = label; btn.disabled = false; };
  btn.addEventListener('click', async () => {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1'; btn.textContent = confirmLabel;
      timer = setTimeout(reset, 4000);
      return;
    }
    clearTimeout(timer); btn.disabled = true;
    try { await run(); } finally { if (btn.isConnected) reset(); }
  });
  return btn;
}

export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}
/** Run fn at most once per ms, with a trailing call, so a stream of snapshots renders a few times a second. */
export function throttle(fn, ms) {
  let last = 0, t = 0, pending = null;
  const wrapped = (...args) => {
    pending = args;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) { last = Date.now(); fn(...pending); pending = null; } else if (!t) {
      t = setTimeout(() => { t = 0; last = Date.now(); const a = pending; pending = null; if (a) fn(...a); }, wait);
    }
  };
  wrapped.cancel = () => { clearTimeout(t); t = 0; pending = null; };
  wrapped.flush = () => { if (!t) return; clearTimeout(t); t = 0; last = Date.now(); const a = pending; pending = null; if (a) fn(...a); };
  return wrapped;
}
export function formatClock(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
export function formatBytes(n) {
  let i = 0;
  for (n = Number(n) || 0; n >= 1024 && i < 3; i++) n /= 1024;
  return (i ? n.toFixed(1) : String(n)) + ' ' + ['B', 'KB', 'MB', 'GB'][i];
}
export const isTouch = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch (err) { return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || ''); } };
export const deviceClass = () => (isTouch() || (window.innerWidth || 1024) < 700 ? 'phone' : 'desktop');
