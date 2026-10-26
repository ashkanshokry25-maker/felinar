#!/usr/bin/env node
// Dependency-free HTML checker for examples/peer-guestbook/ and examples/social/ (not published: publish.mjs skips dot-directories).
// It tokenizes each page (doctype, comments, tags, double-quoted attributes, text, raw-text and
// RCDATA elements), keeps an open-element stack and reports nesting errors, content-model slips that
// make browsers silently restructure the page, attribute rules and per-page counts.
// The pages are written in a strict subset of HTML: every non-void element is closed explicitly,
// attribute values are double-quoted, text is ASCII and only the entities listed below are used.
//
// Usage: node test/example/check-html.mjs [siteDir...]   (default examples/peer-guestbook and examples/social; exit 1 when any page has an error)
// Library: import { checkHtml, checkSite } from './check-html.mjs'

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);
const RCDATA = new Set(['textarea', 'title']);
const HEAD_ONLY = new Set(['meta', 'title', 'link', 'base']);
const HEAD_ALLOWED = new Set(['meta', 'title', 'link', 'style', 'script', 'base', 'noscript']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'ul', 'li', 'dt', 'dd']);
// Elements whose content model is phrasing content only (a block inside them makes the parser restructure the page).
const PHRASING_ONLY = new Set(['p', 'span', 'strong', 'em', 'b', 'i', 'code', 'small', 'time', 'label', 'button',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'title', 'q', 'abbr', 'kbd', 'samp', 'var', 'sub', 'sup', 'mark']);
const INTERACTIVE = new Set(['a', 'button', 'input', 'textarea', 'select', 'video', 'details', 'iframe']);
const NAMED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos', 'nbsp', 'copy']);
const URL_ATTRS = ['href', 'src', 'poster', 'action', 'formaction', 'srcset', 'data'];

export function checkHtml(source, file = 'page.html') {
  const errors = [];
  const counts = { elements: 0, tags: {}, ids: 0, comments: 0, textChars: 0, inlineScripts: 0, inlineStyles: 0 };
  const ids = new Map(), refs = [], idRefs = [], urls = [];
  const stack = [];
  let i = 0, line = 1, sawDoctype = false, firstElement = null;
  const err = (msg) => errors.push(file + ':' + line + ': ' + msg);
  const advance = (n) => { for (let k = 0; k < n; k++) if (source.charCodeAt(i + k) === 10) line++; i += n; };
  const top = () => stack[stack.length - 1];

  function checkText(text, where) {
    counts.textChars += text.trim().length;
    for (let k = 0; k < text.length; k++) if (text.charCodeAt(k) > 126 || (text.charCodeAt(k) < 32 && !/[\t\n\r]/.test(text[k]))) {
      err('non-ASCII or control character U+' + text.charCodeAt(k).toString(16).padStart(4, '0') + ' in ' + where); break;
    }
    const amp = /&([^;\s<&]*)(;?)/g;
    let m;
    while ((m = amp.exec(text))) {
      const name = m[1];
      if (!m[2]) err('bare "&" in ' + where + ' (write &amp;)');
      else if (name[0] === '#') { if (!/^#(\d{1,7}|x[0-9a-fA-F]{1,6})$/.test(name)) err('bad character reference &' + name + ';'); else if (Number(name.slice(1).replace(/^x/, '0x')) > 126) err('non-ASCII character reference &' + name + ';'); }
      else if (!NAMED_ENTITIES.has(name)) err('entity &' + name + '; is not allowed (ASCII text only; no &mdash;, &hellip; or curly quotes)');
    }
  }

  function openTag(tag, attrs, selfClosing) {
    counts.elements++;
    counts.tags[tag] = (counts.tags[tag] || 0) + 1;
    const parent = top();
    if (!firstElement) { firstElement = tag; if (tag !== 'html') err('first element must be <html>, got <' + tag + '>'); }
    if (selfClosing && !VOID.has(tag)) err('<' + tag + '/> is not a void element; close it with </' + tag + '>');
    if (parent) {
      const p = parent.tag;
      if (p === 'html' && tag !== 'head' && tag !== 'body') err('<' + tag + '> directly inside <html>');
      if (p === 'head' && !HEAD_ALLOWED.has(tag)) err('<' + tag + '> is not allowed in <head>');
      if (p === 'head' && parent.children === 0 && !(tag === 'meta' && attrs.charset)) err('the first element in <head> must be <meta charset>');
      if (HEAD_ONLY.has(tag) && p !== 'head') err('<' + tag + '> outside <head>');
      if (tag === 'li' && p !== 'ul' && p !== 'ol') err('<li> inside <' + p + '>');
      if ((tag === 'dt' || tag === 'dd') && p !== 'dl' && !(p === 'div' && stack.length > 1 && stack[stack.length - 2].tag === 'dl')) err('<' + tag + '> outside <dl>');
      if (p === 'ul' || p === 'ol') { if (tag !== 'li') err('<' + tag + '> directly inside <' + p + '>'); }
      if (BLOCK.has(tag) && PHRASING_ONLY.has(p)) err('block <' + tag + '> inside phrasing <' + p + '> (browsers would restructure this)');
      if (INTERACTIVE.has(tag) && stack.some((e) => e.tag === 'a' || e.tag === 'button')) err('interactive <' + tag + '> inside <a> or <button>');
      if (tag === 'figcaption' && p !== 'figure') err('<figcaption> outside <figure>');
      if (tag === 'source' && p !== 'video' && p !== 'audio' && p !== 'picture') err('<source> outside a media element');
      parent.children++;
    } else if (tag !== 'html') err('<' + tag + '> outside <html>');
    if (tag === 'html' && !attrs.lang) err('<html> needs lang');
    if (tag === 'img') for (const a of ['alt', 'width', 'height']) if (!(a in attrs)) err('<img> needs ' + a);
    if (tag === 'a') {
      if (!attrs.href) err('<a> needs href');
      if (attrs.target === '_blank' && !/\bnoopener\b/.test(attrs.rel || '')) err('<a target="_blank"> needs rel="noopener"');
    }
    if (tag === 'button' && !attrs.type) err('<button> needs an explicit type');
    if ((tag === 'input' || tag === 'textarea' || tag === 'select') && !attrs.id && !attrs['aria-label']) err('<' + tag + '> needs an id with a <label for> or an aria-label');
    if (tag === 'video' || tag === 'audio') counts.media = (counts.media || 0) + 1;
    if (tag === 'script' && !attrs.src) counts.inlineScripts++;
    if (tag === 'style') counts.inlineStyles++;
    for (const name of Object.keys(attrs)) {
      if (/^on/i.test(name)) err('inline event handler ' + name + ' on <' + tag + '>');
      if (name === 'style') err('style attribute on <' + tag + '> (use css/app.css)');
      if (URL_ATTRS.includes(name)) {
        if (/^\s*javascript:/i.test(attrs[name])) err('javascript: URL in ' + name);
        urls.push({ tag, attr: name, value: attrs[name], line });
      }
      if (name === 'for' || name === 'aria-labelledby' || name === 'aria-describedby' || name === 'aria-controls') {
        for (const ref of attrs[name].split(/\s+/).filter(Boolean)) idRefs.push({ attr: name, ref, tag, line });
      }
      checkText(attrs[name], 'attribute ' + name + ' of <' + tag + '>');
    }
    if (attrs.id) {
      counts.ids++;
      if (ids.has(attrs.id)) err('duplicate id "' + attrs.id + '"');
      ids.set(attrs.id, tag);
    }
    if (tag === 'label' && attrs.for) refs.push({ for: attrs.for, line });
    if (!VOID.has(tag) && !selfClosing) stack.push({ tag, line, children: 0, attrs });
  }

  function closeTag(tag) {
    if (VOID.has(tag)) { err('end tag </' + tag + '> for a void element'); return; }
    const t = top();
    if (t && t.tag === tag) { stack.pop(); return; }
    const at = stack.map((e) => e.tag).lastIndexOf(tag);
    if (at === -1) { err('stray </' + tag + '>'); return; }
    err('</' + tag + '> closes <' + stack.slice(at + 1).map((e) => e.tag).join('>, <') + '> implicitly (opened at line ' + stack[at + 1].line + ')');
    stack.length = at;
  }

  while (i < source.length) {
    const rest = source.startsWith.bind(source);
    if (rest('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end === -1) { err('unterminated comment'); break; }
      counts.comments++;
      advance(end + 3 - i);
    } else if (rest('<!', i)) {
      const m = /^<!doctype html>/i.exec(source.slice(i, i + 15));
      if (!m) { err('unknown markup declaration'); advance(2); continue; }
      if (sawDoctype || counts.elements) err('doctype must come first and only once');
      sawDoctype = true;
      advance(m[0].length);
    } else if (rest('</', i)) {
      const m = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(source.slice(i, i + 64));
      if (!m) { err('malformed end tag'); advance(2); continue; }
      closeTag(m[1].toLowerCase());
      advance(m[0].length);
    } else if (source[i] === '<' && /[a-zA-Z]/.test(source[i + 1] || '')) {
      const nm = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(source.slice(i, i + 64));
      const tag = nm[1].toLowerCase();
      if (nm[1] !== tag) err('tag names are lowercase: <' + nm[1] + '>');
      advance(nm[0].length);
      const attrs = {};
      let selfClosing = false, closed = false;
      while (i < source.length) {
        const ws = /^\s+/.exec(source.slice(i, i + 256));
        if (ws) advance(ws[0].length);
        if (source[i] === '>') { advance(1); closed = true; break; }
        if (rest('/>', i)) { selfClosing = true; advance(2); closed = true; break; }
        const an = /^[^\s"'>/=]+/.exec(source.slice(i, i + 256));
        if (!an) { err('malformed attribute in <' + tag + '>'); advance(1); continue; }
        const name = an[0];
        if (name !== name.toLowerCase()) err('attribute names are lowercase: ' + name);
        if (name in attrs) err('duplicate attribute ' + name + ' on <' + tag + '>');
        advance(name.length);
        let value = '';
        if (source[i] === '=') {
          advance(1);
          if (source[i] !== '"') { err('attribute ' + name + ' on <' + tag + '> must be double-quoted'); }
          const end = source[i] === '"' ? source.indexOf('"', i + 1) : source.slice(i).search(/[\s>]/) + i;
          if (end < i) { err('unterminated attribute value'); break; }
          value = source.slice(source[i] === '"' ? i + 1 : i, end);
          advance(end - i + (source[i] === '"' ? 1 : 0));
        }
        attrs[name.toLowerCase()] = value;
      }
      if (!closed) { err('unterminated <' + tag + '> tag'); break; }
      openTag(tag, attrs, selfClosing);
      if ((RAW_TEXT.has(tag) || RCDATA.has(tag)) && !selfClosing) {
        const endRe = new RegExp('</' + tag + '\\s*>', 'i');
        const m = endRe.exec(source.slice(i));
        if (!m) { err('unterminated <' + tag + '>'); break; }
        const body = source.slice(i, i + m.index);
        if (RCDATA.has(tag)) checkText(body, '<' + tag + '>');
        else if (body.trim() && tag === 'script' && attrs.src) err('<script src> must be empty');
        if (tag === 'title' && !body.trim()) err('<title> is empty');
        advance(m.index);
      }
    } else if (source[i] === '<') {
      err('stray "<" in text (write &lt;)');
      advance(1);
    } else {
      const next = source.indexOf('<', i);
      const end = next === -1 ? source.length : next;
      const text = source.slice(i, end);
      if (text.trim() && (!stack.length || top().tag === 'html' || top().tag === 'head')) err('text outside <body>: ' + JSON.stringify(text.trim().slice(0, 30)));
      checkText(text, 'text');
      advance(end - i);
    }
  }
  for (const open of stack) errors.push(file + ':' + open.line + ': <' + open.tag + '> is never closed');
  if (!sawDoctype) errors.push(file + ': missing <!doctype html>');
  for (const r of idRefs) if (!ids.has(r.ref)) errors.push(file + ':' + r.line + ': ' + r.attr + '="' + r.ref + '" on <' + r.tag + '> points to no element');
  for (const r of refs) if (ids.has(r.for) && !['input', 'textarea', 'select'].includes(ids.get(r.for))) errors.push(file + ':' + r.line + ': <label for="' + r.for + '"> does not name a form control');
  for (const one of ['html', 'head', 'body', 'title', 'main', 'h1']) if (counts.tags[one] !== 1) errors.push(file + ': expected exactly one <' + one + '>, found ' + (counts.tags[one] || 0));
  if (!/<meta charset="utf-8">/.test(source)) errors.push(file + ': missing <meta charset="utf-8">');
  if (!/<meta name="viewport" content="width=device-width, initial-scale=1[^"]*">/.test(source)) errors.push(file + ': missing viewport meta');
  return { file, errors, counts, ids: [...ids.keys()], urls };
}

// Every .html file under dir, skipping dot-directories (they are not part of the site).
export function htmlFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...htmlFiles(full, base));
    else if (name.endsWith('.html')) out.push(relative(base, full));
  }
  return out;
}

export function checkSite(dir) {
  return htmlFiles(dir).map((rel) => checkHtml(readFileSync(join(dir, rel), 'utf8'), rel));
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const root = join(dirname(self), '..', '..', 'examples');
  const dirs = (process.argv.length > 2 ? process.argv.slice(2) : ['peer-guestbook', 'social'].map((n) => join(root, n))).map((d) => resolve(d));
  let failed = 0, pages = 0, elements = 0;
  for (const dir of dirs) {
    console.log(relative(process.cwd(), dir) || dir);
    const reports = checkSite(dir);
    for (const r of reports) {
      const c = r.counts;
      const tagList = Object.keys(c.tags).sort().map((t) => t + ':' + c.tags[t]).join(' ');
      console.log('  ' + r.file.padEnd(12) + ' errors=' + r.errors.length + ' elements=' + c.elements + ' distinctTags=' + Object.keys(c.tags).length +
        ' ids=' + c.ids + ' links=' + (c.tags.a || 0) + ' urls=' + r.urls.length + ' inlineScripts=' + c.inlineScripts + ' inlineStyles=' + c.inlineStyles +
        ' comments=' + c.comments + ' textChars=' + c.textChars);
      console.log('               ' + tagList);
      for (const e of r.errors) console.log('    ERROR ' + e);
      failed += r.errors.length; pages += 1; elements += c.elements;
    }
  }
  console.log(dirs.length + ' sites, ' + pages + ' pages, ' + elements + ' elements, ' + failed + ' errors');
  process.exitCode = failed ? 1 : 0;
}
