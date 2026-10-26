// The members area (R 3.9): optional, and off by default. Chat (R 2.7) needs the owner to set _mw.cfg.chat and then the member to turn it on;
// public file listings (R 2.8) need the owner to set _mw.cfg.files, and a file is fetched only when the member taps Fetch. The owner's
// switches arrive as ready().features. Text from other visitors, names and file names included, is only ever set as text.
import { $, setText, show, h, toast, explain, loadSdk, readyInfo, hasAuth, armed, fmtBytes, shortId } from '/js/common.js';

const LOBBY = 'Lobby', MAX_LOG = 100;
const T = {
  chatOff: 'Messages are off on this site. The owner has not turned them on.', chatReady: 'Messages are off for you. Turn on chat to talk with other members.',
  chatOn: 'Chat is on. You are in the Lobby.', chatMissing: 'Chat is not available on this site.',
  filesOff: 'File listings are off on this site. The owner has not turned them on.', filesOn: 'File listings are on. Files are public on this site.',
  filesMissing: 'Files are not available on this loader.',
};
const stateOf = (s) => (typeof s === 'string' ? s : s && s.state);
const clock = (t) => (Number.isFinite(Number(t)) ? new Date(Number(t)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const textual = (f) => /^text\/plain/.test(f.mime || '') || /^image\//.test(f.mime || '');

async function main() {
  const mw = await loadSdk(), info = await readyInfo(mw);
  if (!info) return;
  if (!hasAuth(mw)) return show('#members-old', true);
  const ctx = { state: info.auth === 'signed-in' ? 'signed-in' : 'guest', me: info.identity || {}, features: info.features || {}, names: new Map(), seen: new Set(), joined: false, listening: false, filesWatched: false };
  try { mw.db.subscribe((snap) => { // names come from the ledger's profiles
    const p = (snap && snap.profiles) || {};
    for (const k of p instanceof Map ? p.keys() : Object.keys(p)) ctx.names.set(k, p instanceof Map ? p.get(k) : p[k]);
  }); } catch (err) { /* names fall back to short ids */ }

  // ---- chat
  async function who(from) {
    const pub = typeof from === 'string' ? from : from && from.pub;
    const name = (from && typeof from === 'object' && from.name) || ctx.names.get(pub);
    const short = (from && typeof from === 'object' && typeof from.short === 'string' && from.short) || (pub ? await shortId(String(pub)) : '?');
    return typeof name === 'string' && name ? name + ' (' + short + ')' : short; // MF-70: a chosen name never stands without the short id
  }
  async function addMessage(m) {
    if (!m || typeof m.text !== 'string' || (m.room && m.room !== LOBBY)) return;
    if (m.id) { if (ctx.seen.has(m.id)) return; ctx.seen.add(m.id); }
    const pub = typeof m.from === 'string' ? m.from : m.from && m.from.pub, name = await who(m.from), log = $('#lobby-log');
    log.append(h('li', { class: pub && pub === ctx.me.pub ? 'entry mine' : 'entry' },
      h('div', { class: 'entry-head' }, h('span', { class: 'who' }, name), h('span', { class: 'when' }, clock(m.t || Date.now()))), h('p', { class: 'msg' }, m.text)));
    while (log.children.length > MAX_LOG) log.firstElementChild.remove();
    show('#lobby-empty', false);
  }
  async function startChat() {
    const joined = await mw.chat.room.join(LOBBY);
    if (joined && typeof joined.label === 'string') setText('#lobby-note', joined.label);
    if (!ctx.listening) { ctx.listening = true; mw.chat.on('room', (m) => { addMessage(m); }); }
    ctx.joined = true;
    setText('#chat-status', T.chatOn); show('#chat-enable', false); show('#chat-consent', false); show('#lobby', true);
  }
  async function drawChat() {
    show('#lobby', false); show('#chat-enable', false); show('#chat-consent', false);
    if (!ctx.features.chat) return setText('#chat-status', T.chatOff);
    if (!mw.chat) return setText('#chat-status', T.chatMissing);
    let st = null;
    try { st = stateOf(await mw.chat.state()); } catch (err) { st = null; }
    if (st === 'on') return startChat().catch((err) => toast(explain(err), 'error'));
    setText('#chat-status', T.chatReady); show('#chat-enable', true); show('#chat-consent', true);
  }
  $('#chat-enable').addEventListener('click', async () => { // opens the loader's card, so it runs in this click
    try { await mw.chat.enable(); await startChat(); } catch (err) { toast(explain(err), err && err.code === 'E_USER_CANCELLED' ? 'info' : 'error'); }
  });
  $('#lobby-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#lobby-msg'), text = input.value.trim();
    if (!text) return;
    try { const sent = await mw.chat.room.send(LOBBY, { text }); input.value = ''; await addMessage({ room: LOBBY, id: sent && sent.id, from: ctx.me, t: Date.now(), text }); } catch (err) { toast(explain(err), 'error'); }
  });

  // ---- public file listings: nothing is fetched until the member taps Fetch (R 2.8.4)
  const fileRow = (f) => {
    const preview = h('div', { class: 'preview' });
    const note = (text) => preview.replaceChildren(h('p', { class: 'small muted' }, text));
    const actions = [];
    if (!f.fetched) {
      actions.push(h('button', { class: 'link', type: 'button' }, 'Fetch'));
      actions[0].addEventListener('click', async () => {
        actions[0].disabled = true; note('Fetching...');
        try { await mw.files.fetch(f.ref); await refreshFiles(); } catch (err) { actions[0].disabled = false; note(explain(err)); }
      });
    } else {
      if (textual(f)) {
        const show1 = h('button', { class: 'link', type: 'button' }, 'Show');
        show1.addEventListener('click', async () => {
          try { // the loader's preview is the only way a shared file reaches the screen
            const p = (await mw.files.preview(f.ref)) || {};
            if (p.kind === 'image' && typeof p.url === 'string') preview.replaceChildren(h('img', { src: p.url, alt: 'Shared picture: ' + f.name, width: 320 }));
            else if (p.kind === 'text') preview.replaceChildren(h('pre', null, String(p.text || '')));
            else note('There is no preview for this kind of file. Use Save.');
          } catch (err) { note(explain(err)); }
        });
        actions.push(show1);
      }
      const save = h('button', { class: 'link', type: 'button' }, 'Save');
      save.addEventListener('click', async () => { try { await mw.files.save(f.ref); } catch (err) { toast(explain(err), err && err.code === 'E_USER_CANCELLED' ? 'info' : 'error'); } });
      actions.push(save);
    }
    if (f.mine) actions.push(armed('act-remove', 'Remove', async () => { await mw.files.remove(f.ref); await refreshFiles(); }));
    return h('li', { class: f.mine ? 'entry mine' : 'entry', 'data-ref': f.ref },
      h('div', { class: 'entry-head' }, h('span', { class: 'who' }, f.name || 'file', f.ext ? h('span', { class: 'tag' }, f.ext) : null, f.mine ? h('span', { class: 'tag' }, 'you') : null),
        h('span', { class: 'when' }, fmtBytes(f.len))),
      h('p', { class: 'small muted' }, (f.mime || 'unknown type') + (f.fetched ? ', fetched' : ', not fetched')),
      h('div', { class: 'actions' }, ...actions), preview);
  };
  async function refreshFiles() {
    let list = [];
    try { list = await mw.files.list(); } catch (err) { return toast(explain(err), 'error'); }
    list = Array.isArray(list) ? list.filter((f) => f && typeof f.ref === 'string') : [];
    $('#file-list').replaceChildren(...list.map(fileRow));
    show('#file-empty', list.length === 0);
  }
  async function drawFiles() {
    show('#files-on', false);
    if (!ctx.features.files) return setText('#files-status', T.filesOff);
    if (!mw.files) return setText('#files-status', T.filesMissing);
    setText('#files-status', T.filesOn); show('#files-on', true);
    let consent = 'accepted';
    try { if (mw.consent && typeof mw.consent.state === 'function') consent = await mw.consent.state(); } catch (err) { /* assume sharing is on */ }
    show('#file-fetch-note', consent === 'accepted');
    if (!ctx.filesWatched) {
      ctx.filesWatched = true;
      for (const ev of ['shared', 'removed']) { try { mw.files.on(ev, () => { refreshFiles(); }); } catch (err) { /* an older loader */ } }
    }
    await refreshFiles();
  }
  $('#file-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#file-input').files[0];
    if (!file) return toast('Choose a file first.', 'info');
    try { await mw.files.share(file, { public: true }); $('#file-input').value = ''; toast('Shared. Your file is listed for members.', 'ok'); await refreshFiles(); } catch (err) { toast(explain(err), err && err.code === 'E_USER_CANCELLED' ? 'info' : 'error'); }
  });

  function draw() {
    const signed = ctx.state === 'signed-in';
    show('#members-guest', !signed); show('#members-signed', signed);
    if (!signed) { ctx.joined = false; $('#lobby-log').replaceChildren(); show('#lobby-empty', true); return; }
    drawChat(); drawFiles();
  }
  $('#members-sign-in').addEventListener('click', async () => { try { await mw.auth.signIn(); } catch (err) { toast(explain(err), err && err.code === 'E_USER_CANCELLED' ? 'info' : 'error'); } });
  mw.auth.onChange((a) => {
    if (!a || typeof a !== 'object') return;
    ctx.state = a.state === 'signed-in' ? 'signed-in' : 'guest'; ctx.me = a.identity || {};
    draw();
  });
  draw();
}
main();
