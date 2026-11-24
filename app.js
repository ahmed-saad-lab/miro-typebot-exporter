/* global miro, MiroTypebot */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { limit: 30, frameId: '', frameTitle: '', overrides: {}, input: null, result: null };

  // ───────── expand / collapse ─────────
  const STORE = 'tbx-collapsed';
  let collapsed = {};
  try { collapsed = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (_) { collapsed = {}; }
  const sections = () => [...document.querySelectorAll('.sec')];
  function setOpen(sec, open, remember) {
    sec.dataset.open = String(open);
    sec.querySelector('.sec-head').setAttribute('aria-expanded', String(open));
    if (remember) {
      collapsed[sec.dataset.sec] = !open;
      try { localStorage.setItem(STORE, JSON.stringify(collapsed)); } catch (_) {}
    }
    updateToggleAll();
  }
  function updateToggleAll() {
    const visible = sections().filter((s) => s.offsetParent !== null || s.closest('.savebar:not(.hidden)'));
    const anyOpen = visible.some((s) => s.dataset.open !== 'false');
    $('toggleAll').textContent = anyOpen ? 'Collapse all' : 'Expand all';
  }
  sections().forEach((sec) => {
    setOpen(sec, !collapsed[sec.dataset.sec], false);
    sec.querySelector('.sec-head').addEventListener('click', () => setOpen(sec, sec.dataset.open === 'false', true));
  });
  $('toggleAll').addEventListener('click', () => {
    const open = $('toggleAll').textContent === 'Expand all';
    sections().forEach((s) => setOpen(s, open, true));
  });

  if (typeof miro === 'undefined' || !miro.board) {
    $('notInMiro').classList.remove('hidden');
    $('setup').classList.add('hidden');
    return;
  }

  // ───────── package ─────────
  $('packages').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-limit]');
    if (!b) return;
    state.limit = +b.dataset.limit;
    [...$('packages').children].forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('sumPackage').textContent = state.limit;
    if (state.input) run();
  });

  // ───────── frames ─────────
  const plain = (t) => MiroTypebot.htmlToText(t || '');
  async function loadFrames() {
    const sel = $('frameSelect');
    const frames = await miro.board.get({ type: 'frame' });
    frames.sort((a, b) => plain(a.title).localeCompare(plain(b.title)));
    sel.innerHTML = '';
    if (!frames.length) { sel.innerHTML = '<option value="">No frames on this board</option>'; return; }
    sel.append(new Option('Choose a frame…', ''));
    frames.forEach((f) => sel.append(new Option(plain(f.title) || 'Untitled frame', f.id)));
    if (state.frameId && frames.some((f) => f.id === state.frameId)) sel.value = state.frameId;
  }
  $('frameSelect').addEventListener('change', (e) => selectFrame(e.target.value));
  $('refreshFrames').addEventListener('click', loadFrames);
  $('useSelected').addEventListener('click', async () => {
    const sel = await miro.board.getSelection();
    let frame = sel.find((i) => i.type === 'frame');
    if (!frame && sel[0] && sel[0].parentId) {
      const [p] = await miro.board.get({ id: [sel[0].parentId] });
      if (p && p.type === 'frame') frame = p;
    }
    if (!frame) return setStatus('testStatus', 'Select a frame (or a box inside it) on the board first.');
    await loadFrames();
    $('frameSelect').value = frame.id;
    selectFrame(frame.id);
  });
  function selectFrame(id) {
    if (id !== state.frameId) { state.overrides = {}; state.input = null; hideResults(); }
    state.frameId = id;
    const opt = $('frameSelect').selectedOptions[0];
    $('sumFrame').textContent = id && opt ? opt.textContent : 'None';
    setStatus('testStatus', '');
  }
  $('keyword').addEventListener('input', () => ($('sumKeyword').textContent = $('keyword').value.trim() || '1006'));
  $('keyword').addEventListener('change', () => state.input && run());

  // ───────── read the board ─────────
  async function readFrame(frameId) {
    const [frame] = await miro.board.get({ id: [frameId] });
    if (!frame) throw new Error('That frame was deleted. Refresh the list.');
    const children = await frame.getChildren();
    const ids = new Set(children.map((c) => c.id));
    const items = children
      .filter((c) => c.type !== 'connector')
      .map((c) => ({
        id: c.id,
        type: c.type,
        shape: c.shape || '',
        html: c.type === 'card' || c.type === 'app_card' ? [c.title, c.description].filter(Boolean).join('<br>') : c.content || c.title || '',
        url: c.url || '',
        x: c.x,
        y: c.y,
      }));
    const all = await miro.board.get({ type: 'connector' });
    const connectors = all
      .filter((c) => (c.start && ids.has(c.start.item)) || (c.end && ids.has(c.end.item)))
      .map((c) => {
        let from = c.start && c.start.item;
        let to = c.end && c.end.item;
        const sc = c.style && c.style.startStrokeCap, ec = c.style && c.style.endStrokeCap;
        if (sc && sc !== 'none' && (!ec || ec === 'none')) [from, to] = [to, from];
        return { id: c.id, from, to, caption: (c.captions || []).map((x) => x.content).join(' ') };
      });
    return { frame: { id: frame.id, title: frame.title }, items, connectors };
  }

  const keyword = () => $('keyword').value.trim() || '1006';
  function convertNow(autoAll) {
    const overrides = Object.assign({}, state.overrides, { keyword: keyword(), autoAll: !!autoAll });
    return MiroTypebot.convert(state.input, { limit: state.limit, overrides });
  }

  // ───────── test ─────────
  async function testFromBoard() {
    if (!state.frameId) return setStatus('testStatus', 'Choose the frame to export first.');
    setStatus('testStatus', 'Reading the frame…');
    try { state.input = await readFrame(state.frameId); }
    catch (err) { return setStatus('testStatus', err.message || 'Couldn’t read the frame. Try again.'); }
    setStatus('testStatus', '');
    run();
  }
  $('testBtn').addEventListener('click', testFromBoard);
  $('retestBtn').addEventListener('click', testFromBoard);
  function run() {
    state.result = convertNow(false);
    render(state.result, false);
  }

  // ───────── export without testing ─────────
  // Every safe fix is applied automatically and the file still goes through the import check.
  $('bypassBtn').addEventListener('click', async () => {
    if (!state.frameId) return setStatus('testStatus', 'Choose the frame to export first.');
    const win = openSaveTab(); // open now, while the click still counts, then fill it in
    setStatus('testStatus', 'Reading the frame…');
    try { state.input = await readFrame(state.frameId); }
    catch (err) { if (win) win.close(); return setStatus('testStatus', err.message || 'Couldn’t read the frame. Try again.'); }
    setStatus('testStatus', '');
    exportAuto(win);
  });
  $('anywayBtn').addEventListener('click', () => exportAuto(openSaveTab()));

  function exportAuto(win) {
    const r = convertNow(true);
    state.result = r;
    render(r, true);
    if (!r.canExport) {
      if (win) win.close();
      const why = r.issues.find((i) => i.severity === 'error');
      return setStatus('saveStatus', why ? why.detail : 'This frame has nothing to export.');
    }
    deliver(win, fileNameValue(), JSON.stringify(r.typebot, null, 2));
  }

  function applyPatch(p) {
    const o = state.overrides;
    if (p.op === 'add') o[p.key] = (o[p.key] || []).concat(p.value);
    else if (p.op === 'set') o[p.key] = p.value;
    else if (p.op === 'map') o[p.key] = Object.assign({}, o[p.key], { [p.mapKey]: p.value });
  }

  // ───────── results ─────────
  function hideResults() {
    $('results').classList.add('hidden');
    $('savebar').classList.add('hidden');
    updateToggleAll();
  }

  function render(r, auto) {
    $('results').classList.remove('hidden');
    $('savebar').classList.remove('hidden');

    const used = r.stats.blocks, limit = state.limit;
    const cells = Math.max(limit, used);
    const meter = $('meter');
    meter.style.gridTemplateColumns = `repeat(${cells <= 30 ? 15 : 20}, 1fr)`;
    meter.innerHTML = '';
    for (let i = 0; i < cells; i++) {
      const s = document.createElement('span');
      if (i < Math.min(used, limit)) s.className = 'on';
      else if (i >= limit) s.className = 'over';
      meter.appendChild(s);
    }
    const over = used > limit;
    $('meterWrap').classList.toggle('is-over', over);
    $('meterCount').innerHTML = `${used} <small>of ${limit} components</small>`;
    $('fit').textContent = over
      ? `${used - limit} over the package.`
      : used === limit ? 'Uses the whole package.' : `Fits the package, with ${limit - used} to spare.`;
    $('types').textContent = Object.entries(r.stats.byType).map(([t, n]) => `${n} ${t}`).join(', ');
    $('sumMeter').textContent = `${used} / ${limit}`;
    $('secMeter').classList.toggle('is-error', over && !auto);

    const errors = r.issues.filter((i) => i.severity === 'error');
    const warnings = r.issues.filter((i) => i.severity === 'warning');
    const v = $('verdict');
    v.className = 'verdict ' + (r.canExport ? 'ok' : 'bad');
    v.textContent = auto
      ? (r.canExport ? `Exported without testing. ${r.autoFixes.length} fix${r.autoFixes.length === 1 ? '' : 'es'} applied automatically; the file passed the Typebot import check.` : 'The file couldn’t be exported.')
      : r.canExport ? 'Ready to export. The file passed the Typebot import check.'
      : `${errors.length} problem${errors.length > 1 ? 's' : ''} to fix before export, or use “Export anyway”.`;

    fill($('errors'), errors.map(issueCard));
    $('secErrors').classList.toggle('hidden', !errors.length);
    $('sumErrors').textContent = errors.length;

    fill($('warnings'), warnings.map(issueCard));
    $('secWarnings').classList.toggle('hidden', !warnings.length);
    $('sumWarnings').textContent = warnings.length;

    fill($('autoList'), r.autoFixes.map((a) => { const li = document.createElement('li'); li.textContent = a.text; return li; }));
    $('secAuto').classList.toggle('hidden', !r.autoFixes.length);
    $('sumAuto').textContent = r.autoFixes.length;

    fill($('outline'), r.typebot ? r.typebot.groups.map((g) => {
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = g.title;
      li.append(b, document.createTextNode(': ' + g.blocks.map((x) => x.type).join(', ')));
      return li;
    }) : []);
    $('secOutline').classList.toggle('hidden', !r.typebot);
    $('sumOutline').textContent = r.typebot ? `${r.stats.groups} groups` : '';

    if (!$('fileName').value || $('fileName').dataset.auto === '1') {
      $('fileName').value = r.fileName;
      $('fileName').dataset.auto = '1';
    }
    $('saveBtn').disabled = !r.canExport;
    $('anywayRow').classList.toggle('hidden', r.canExport || !r.typebot);
    $('sumSave').textContent = r.canExport ? 'Ready' : 'Blocked';
    if (!auto) setStatus('saveStatus', '');
    updateToggleAll();
  }
  function fill(el, children) { el.innerHTML = ''; children.forEach((c) => el.appendChild(c)); }
  $('fileName').addEventListener('input', () => ($('fileName').dataset.auto = '0'));

  function issueCard(i) {
    const el = document.createElement('div');
    el.className = 'issue ' + i.severity;
    const h = document.createElement('h3');
    h.textContent = i.title;
    const p = document.createElement('p');
    p.textContent = i.detail;
    const actions = document.createElement('div');
    actions.className = 'actions';
    i.fixes.forEach((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-small btn-fix';
      b.textContent = f.label;
      b.addEventListener('click', () => { applyPatch(f.patch); run(); });
      actions.appendChild(b);
    });
    if (i.nodeId) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-small';
      b.textContent = 'Show on board';
      b.addEventListener('click', () => showOnBoard(i.nodeId));
      actions.appendChild(b);
    }
    el.append(h, p);
    if (actions.children.length) el.appendChild(actions);
    return el;
  }

  async function showOnBoard(id) {
    try {
      const [item] = await miro.board.get({ id: [id] });
      if (!item) return setStatus('saveStatus', 'That box is no longer on the board. Press Re-test.');
      await miro.board.viewport.zoomTo(item);
      try { await miro.board.deselect(); await miro.board.select({ id }); } catch (_) { /* zooming is enough */ }
    } catch (_) {
      setStatus('saveStatus', 'Couldn’t show that box. Press Re-test.');
    }
  }

  // ───────── save ─────────
  // Browsers only show the "choose a folder" window from a normal tab, not from inside Miro,
  // so saving happens in a small tab of this app. The file travels in the link's # part and never leaves the computer.
  function openSaveTab() { return window.open('save.html#pending', '_blank'); }
  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function fileNameValue() {
    let n = $('fileName').value.trim() || (state.result && state.result.fileName) || 'typebot.json';
    n = n.replace(/[\\/:*?"<>|]+/g, '');
    return /\.json$/i.test(n) ? n : n + '.json';
  }
  function downloadHere(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function deliver(win, name, text) {
    if (win && !win.closed) {
      try {
        win.location.href = new URL('save.html', location.href).href + '#' + encodeURIComponent(name) + '|' + toBase64(text);
        return setStatus('saveStatus', 'A save tab opened. Choose the folder there.', true);
      } catch (_) { /* fall through */ }
    }
    downloadHere(name, text);
    setStatus('saveStatus', `The save tab was blocked, so “${name}” went to your Downloads folder.`, true);
  }
  $('saveBtn').addEventListener('click', () => {
    if (!state.result || !state.result.canExport) return;
    deliver(openSaveTab(), fileNameValue(), JSON.stringify(state.result.typebot, null, 2));
  });

  function setStatus(id, msg, good) {
    const el = $(id);
    el.textContent = msg;
    el.classList.toggle('good', !!good);
  }

  loadFrames().catch(() => setStatus('testStatus', 'Couldn’t list frames. Reopen the app.'));
})();
