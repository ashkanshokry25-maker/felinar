// Stages the "existing site" fixture for tests (examples/existing-site-dropin/README.md): copies the
// files that belong to a site root into a directory you can hand to tools/publish.mjs --dropin.
// This tooling lives in test/fixtures/, outside the example, so it never lands in a torrent.
//
//   stage('main', out)                      the multi-page site (default)
//   stage('main', out, { version: 2 })      the same site after a redeploy (see applyVersion2)
//   stage('main', out, { plain: true })     without the /_mw/mw.js tag: the site before it migrated
//   stage('with-own-sw', out)               a site whose own worker (/sw.js) is hand-written
//   stage('with-own-sw-integrated', out)    the same worker with the two-line felinar integration
//   stage('with-widgets', out, { widgets }) the Example Forum: the <mw-signin> button and the <mw-chat-panel> (R 2.3.6, 3.8). The page
//                                           carries placeholders for what `publish --signin-widget --chat-panel` prints; widgets fills them:
//                                           { dist: 'dist' } hashes dist/_mw/signin.js and chat-panel.js the way publish does (sha384, base64),
//                                           { signin, chatPanel } give the integrity values, { tracker, stun } the hosts of the panel's attributes
//
// Returns { dir, variant, version, plain, files, changes, widgets }.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'existing-site-dropin');
export const VARIANTS = Object.freeze(['main', 'with-own-sw', 'with-own-sw-integrated']);
/** Variants of the v0.3 widgets (R 2.3.6, 3.8). Kept apart from VARIANTS, which lists the service-worker variants of the first fixture. */
export const WIDGET_VARIANTS = Object.freeze(['with-widgets']);
export const MW_TAG = '<script type="module" src="/_mw/mw.js" async></script>';
/** What the widgets variant carries until stage() fills it: the page is a template, because the hash of a built file changes with every build. */
export const WIDGET_PLACEHOLDER = 'sha384-REPLACE-WITH-THE-HASH-PUBLISH-PRINTS';
export const WIDGET_HOSTS = Object.freeze({ tracker: 'tracker.example.org', stun: 'stun.example.org' });

// Entries of the fixture directory that are not part of the main site root.
const NOT_SITE = new Set(['with-own-sw', 'with-own-sw-integrated', 'with-widgets', 'EXPECTED.md', 'README.md']);
// The variants reuse these files of the main site instead of keeping copies.
const SHARED = ['css/app.3f2a1b.css', 'js/app.9c0d2e.js', 'img/logo.png', 'data.json', '404.html'];

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, base, out);
    else out.push(relative(base, abs).split(sep).join('/'));
  }
  return out;
}

function copyFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

function htmlFiles(dir) {
  return walk(dir).filter((f) => /\.html?$/i.test(f));
}

function rewriteHtml(dir, fn) {
  for (const f of htmlFiles(dir)) {
    const abs = join(dir, f);
    const before = readFileSync(abs, 'utf8');
    const after = fn(before, f);
    if (after !== before) writeFileSync(abs, after);
  }
}

/**
 * applyVersion2(dir) → { changed, renamed, unchanged }
 * What a redeploy looks like to the runtime, in one small step:
 *   data.json                       same URL, new content (the un-hashed file that really changes)
 *   css/app.3f2a1b.css  -> css/app.8d1e44.css       new content, new hashed name
 *   js/chunk.5e7f1a.js  -> js/chunk.b63d90.js       new content, new hashed name (the lazy chunk)
 *   js/app.9c0d2e.js, img/logo.png  untouched: same URL, same bytes, so a new copy can reuse them
 *   index.html                      new title and lead text; every page points at the new names
 */
export function applyVersion2(dir) {
  const result = { changed: [], renamed: {}, unchanged: ['js/app.9c0d2e.js', 'img/logo.png'] };
  writeFileSync(join(dir, 'data.json'), '{ "message": "hello from the host", "version": 2 }\n');
  result.changed.push('data.json');
  const css = readFileSync(join(dir, 'css', 'app.3f2a1b.css'), 'utf8').replace('version 1', 'version 2').replace('--accent: #0a58ca', '--accent: #b3261e');
  writeFileSync(join(dir, 'css', 'app.8d1e44.css'), css);
  rmSync(join(dir, 'css', 'app.3f2a1b.css'));
  result.renamed['css/app.3f2a1b.css'] = 'css/app.8d1e44.css';
  writeFileSync(join(dir, 'js', 'chunk.b63d90.js'), "/* existing-site fixture, version 2: a lazily loaded chunk. */\nwindow.__chunk = 'v2';\n");
  rmSync(join(dir, 'js', 'chunk.5e7f1a.js'));
  result.renamed['js/chunk.5e7f1a.js'] = 'js/chunk.b63d90.js';
  rewriteHtml(dir, (html, f) => {
    let out = html.split('app.3f2a1b.css').join('app.8d1e44.css').split('chunk.5e7f1a.js').join('chunk.b63d90.js');
    if (f === 'index.html') {
      out = out.replace('<title>Existing Site: home</title>', '<title>Existing Site: home (v2)</title>')
        .replace('This page comes from the host.', 'This page comes from the host (version 2).');
    }
    return out;
  });
  return result;
}

/** widgetIntegrity(distDir) → { signin, chatPanel }: the integrity value publish prints for each widget file in <distDir>/_mw (null when the file is not built). */
export function widgetIntegrity(distDir) {
  const hash = (name) => {
    const file = join(resolve(distDir), '_mw', name + '.js');
    return existsSync(file) ? 'sha384-' + createHash('sha384').update(readFileSync(file)).digest('base64') : null;
  };
  return { signin: hash('signin'), chatPanel: hash('chat-panel') };
}

const SCRIPT_ATTR = (name) => new RegExp('(src="/_mw/' + name + '\\.js" integrity=")[^"]*(")');
const WIDGET_SCRIPT = /<script type="module" src="\/_mw\/(?:signin|chat-panel)\.js"[^>]*><\/script>\n?/g;
const WIDGET_ELEMENT = /<mw-(?:signin|chat-panel)\b[^>]*><\/mw-(?:signin|chat-panel)>\n?/g;

/** fillWidgets(html, widgets) → the page with the integrity values and the hosts of the chat panel put in (a template page stays a template where a value is missing). */
function fillWidgets(html, widgets) {
  let out = html;
  if (widgets.signin) out = out.replace(SCRIPT_ATTR('signin'), '$1' + widgets.signin + '$2');
  if (widgets.chatPanel) out = out.replace(SCRIPT_ATTR('chat-panel'), '$1' + widgets.chatPanel + '$2');
  if (widgets.tracker) out = out.replace(/(<mw-chat-panel tracker=")[^"]*(")/, '$1' + widgets.tracker + '$2');
  if (widgets.stun) out = out.replace(/(<mw-chat-panel [^>]*stun=")[^"]*(")/, '$1' + widgets.stun + '$2');
  return out;
}

/** stage(variant, outDir, { version, plain, widgets }) → { dir, variant, version, plain, files, changes, widgets }. */
export function stage(variant, outDir, { version = 1, plain = false, widgets = null } = {}) {
  if (!VARIANTS.includes(variant) && !WIDGET_VARIANTS.includes(variant)) throw new Error('unknown fixture variant ' + variant + ' (one of ' + VARIANTS.concat(WIDGET_VARIANTS).join(', ') + ')');
  if (widgets && !WIDGET_VARIANTS.includes(variant)) throw new Error('widgets exist for the widgets variant only');
  const dir = resolve(outDir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (variant === 'main') {
    for (const name of readdirSync(FIXTURE_DIR)) {
      if (NOT_SITE.has(name)) continue;
      cpSync(join(FIXTURE_DIR, name), join(dir, name), { recursive: true });
    }
  } else {
    for (const f of SHARED) copyFile(join(FIXTURE_DIR, f), join(dir, f));
    cpSync(join(FIXTURE_DIR, variant), dir, { recursive: true });
  }
  let changes = null;
  if (version === 2) {
    if (variant !== 'main') throw new Error('version 2 exists for the main site only');
    changes = applyVersion2(dir);
  } else if (version !== 1) {
    throw new Error('unknown fixture version ' + version);
  }
  let filled = null;
  if (WIDGET_VARIANTS.includes(variant)) {
    const fromDist = widgets && widgets.dist ? widgetIntegrity(widgets.dist) : { signin: null, chatPanel: null };
    filled = {
      signin: (widgets && widgets.signin) || fromDist.signin, chatPanel: (widgets && widgets.chatPanel) || fromDist.chatPanel,
      tracker: (widgets && widgets.tracker) || null, stun: (widgets && widgets.stun) || null,
    };
    rewriteHtml(dir, (html) => fillWidgets(html, filled));
  }
  if (plain) {
    rewriteHtml(dir, (html) => html.split(MW_TAG + '\n').join('').split(MW_TAG).join(''));
    if (filled) rewriteHtml(dir, (html) => html.replace(WIDGET_SCRIPT, '').replace(WIDGET_ELEMENT, ''));
  }
  return { dir, variant, version, plain, files: walk(dir), changes, widgets: filled };
}

/** Where the main site's staged copy of a path is (used by tests that compare bytes). */
export function sourcePath(rel) {
  return join(FIXTURE_DIR, ...rel.split('/'));
}
