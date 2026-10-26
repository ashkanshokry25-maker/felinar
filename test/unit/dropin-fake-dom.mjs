// A very small fake DOM for the drop-in unit tests (no browsers in unit tests). It models only what
// src/dropin touches: elements with attributes, children, CSSOM-style setProperty, event listeners,
// closed shadow roots, a document with readyState / visibilityState / events, and metas / scripts
// lookups. Not a general DOM: anything else throws, so tests notice new dependencies.

export class FakeStyle {
  constructor() { this.props = new Map(); }
  setProperty(name, value, priority = '') { this.props.set(String(name), { value: String(value), priority }); }
  removeProperty(name) { this.props.delete(String(name)); }
  getPropertyValue(name) { const p = this.props.get(String(name)); return p ? p.value : ''; }
}

export class FakeNode {
  constructor(tagName, ownerDocument = null) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.listeners = new Map();
    this.style = new FakeStyle();
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this._shadow = null;
    this.focused = false;
    this.className = '';
  }

  get textContent() {
    return this._text + this.children.map((c) => (c.textContent !== undefined ? c.textContent : '')).join('');
  }

  set textContent(v) {
    this.children = [];
    this._text = v === null || v === undefined ? '' : String(v);
  }

  get shadowRoot() { return this._shadow && this._shadow.mode === 'open' ? this._shadow : null; }
  get firstChild() { return this.children[0] || null; }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = this.children.indexOf(ref);
    child.parentNode = this;
    this.children.splice(i < 0 ? this.children.length : i, 0, child);
    return child;
  }

  setAttribute(name, value) { this.attrs.set(String(name).toLowerCase(), String(value)); }
  getAttribute(name) { const k = String(name).toLowerCase(); return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(name) { return this.attrs.has(String(name).toLowerCase()); }
  removeAttribute(name) { this.attrs.delete(String(name).toLowerCase()); }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) { const s = this.listeners.get(type); if (s) s.delete(fn); }

  dispatchEvent(event) {
    const ev = typeof event === 'string' ? { type: event } : event;
    if (!ev.target) ev.target = this;
    const s = this.listeners.get(ev.type);
    if (s) for (const fn of Array.from(s)) fn.call(this, ev);
    return true;
  }

  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  focus() { this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; }

  attachShadow({ mode }) {
    if (this._shadow) throw new Error('already has a shadow root');
    const root = new FakeNode('#shadow-root', this.ownerDocument);
    root.mode = mode;
    root.host = this;
    this._shadow = root;
    return root;
  }

  /** Test helper: every descendant (depth first) matching pred, including inside shadow roots. */
  findAll(pred, out = []) {
    for (const c of this.children) {
      if (pred(c)) out.push(c);
      c.findAll(pred, out);
    }
    if (this._shadow) this._shadow.findAll(pred, out);
    return out;
  }

  find(pred) { return this.findAll(pred)[0] || null; }
  buttonByText(text) { return this.find((n) => n.tagName === 'BUTTON' && n.textContent === text); }
  getElementsByTagName(tag) { const t = String(tag).toUpperCase(); return this.findAll((n) => n.tagName === t); }
}

export class FakeDocument extends FakeNode {
  constructor({ metas = [], scripts = [], readyState = 'complete', visibilityState = 'visible', baseURI = 'https://site.test/' } = {}) {
    super('#document', null);
    this.ownerDocument = this;
    this.readyState = readyState;
    this.visibilityState = visibilityState;
    this.baseURI = baseURI;
    this.documentElement = new FakeNode('html', this);
    this.head = new FakeNode('head', this);
    this.body = new FakeNode('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    for (const m of metas) this.head.appendChild(this.createElement('meta', m));
    for (const s of scripts) this.head.appendChild(this.createElement('script', s));
    this.activeElement = null;
  }

  createElement(tag, attrs = null) {
    const el = new FakeNode(tag, this);
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    return el;
  }

  createTextNode(text) {
    const n = new FakeNode('#text', this);
    n._text = String(text);
    return n;
  }

  setVisibility(state) {
    this.visibilityState = state;
    this.dispatchEvent({ type: 'visibilitychange' });
  }
}
