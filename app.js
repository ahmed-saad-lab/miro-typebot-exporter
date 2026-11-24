/* global miro, MiroTypebot */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { limit: 30, frameId: '', overrides: {}, input: null, result: null };

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
    if (state.input) run(); // limit changes don't need a new board read
  });

  // ───────── frames ─────────
  async function loadFrames() {
    const sel = $('frameSelect');
    const frames = await miro.board.get({ type: 'frame' });
    frames.sort((a, b) => plain(a.title).localeCompare(plain(b.title)));
    sel.innerHTML = '';
    if (!frames.length) {
      sel.innerHTML = '<option value="">No frames on this board</option>';
      return;
    }
    sel.append(new Option('Choose a frame…', ''));
    frames.forEach((f) => sel.append(new Option(plain(f.title) || 'Untitled frame', f.id)));
    if (state.frameId && frames.some((f) => f.id === state.frameId)) sel.value = state.frameId;
  }
  const plain = (t) => MiroTypebot.htmlToText(t || '');

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
    setStatus('testStatus', '');
  }

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
        // an arrow drawn backwards (arrowhead only at the start) is read in the direction it points
        const sc = c.style && c.style.startStrokeCap, ec = c.style && c.style.endStrokeCap;
        if (sc && sc !== 'none' && (!ec || ec === 'none')) [from, to] = [to, from];
        return { id: c.id, from, to, caption: (c.captions || []).map((x) => x.content).join(' ') };
      });
    return { frame: { id: frame.id, title: frame.title }, items, connectors };
  }

  // ───────── test ─────────
  async function testFromBoard() {
    if (!state.frameId) return setStatus('testStatus', 'Choose the frame to export first.');
    setStatus('testStatus', 'Reading the frame…');
    try {
      state.input = await readFrame(state.frameId);
    } catch (err) {
      return setStatus('testStatus', err.message || 'Couldn’t read the frame. Try again.');
    }
    setStatus('testStatus', '');
    run();
  }
  $('testBtn').addEventListener('click', testFromBoard);
  $('retestBtn').addEventListener('click', testFromBoard);

  function run() {
    const overrides = Object.assign({}, state.overrides, { keyword: $('keyword').value.trim() || '1006' });
    state.result = MiroTypebot.convert(state.input, { limit: state.limit, overrides });
    render(state.result);
  }
  $('keyword').addEventListener('change', () => state.input && run());

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
  }

  function render(r) {
    $('results').classList.remove('hidden');
    $('savebar').classList.remove('hidden');

    // meter
    const used = r.stats.blocks, limit = state.limit;
    const cells = Math.max(limit, used);
    const cols = cells <= 30 ? 15 : 20;
    const meter = $('meter');
    meter.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    meter.innerHTML = '';
    for (let i = 0; i < cells; i++) {
      const s = document.createElement('span');
      if (i < Math.min(used, limit)) s.className = 'on';
      else if (i >= limit) s.className = 'over';
      meter.appendChild(s);
    }
    $('meterWrap').classList.toggle('is-over', used > limit);
    $('meterCount').innerHTML = `${used} <small>of ${limit} components · ${Math.max(0, limit - used)} left</small>`;
    $('types').textContent = Object.entries(r.stats.byType).map(([t, n]) => `${n} ${t}`).join(', ');

    // verdict
    const errors = r.issues.filter((i) => i.severity === 'error');
    const warnings = r.issues.filter((i) => i.severity === 'warning');
    const v = $('verdict');
    v.className = 'verdict ' + (r.canExport ? 'ok' : 'bad');
    v.textContent = r.canExport
      ? 'Ready to export. The file passed the Typebot import test.'
      : `${errors.length} problem${errors.length > 1 ? 's' : ''} must be fixed before export.`;

    $('errors').innerHTML = '';
    errors.forEach((i) => $('errors').appendChild(issueCard(i)));

    $('warnings').innerHTML = '';
    warnings.forEach((i) => $('warnings').appendChild(issueCard(i)));
    $('warnBox').classList.toggle('hidden', !warnings.length);
    $('warnTitle').textContent = `Please check (${warnings.length})`;
    if (!errors.length && warnings.length) $('warnBox').open = true;

    $('autoList').innerHTML = '';
    r.autoFixes.forEach((a) => {
      const li = document.createElement('li');
      li.textContent = a.text;
      $('autoList').appendChild(li);
    });
    $('autoBox').classList.toggle('hidden', !r.autoFixes.length);
    $('autoTitle').textContent = `Fixed automatically (${r.autoFixes.length})`;

    $('outline').innerHTML = '';
    if (r.typebot) {
      r.typebot.groups.forEach((g) => {
        const li = document.createElement('li');
        const b = document.createElement('b');
        b.textContent = g.title;
        li.append(b, document.createTextNode(': ' + g.blocks.map((x) => x.type).join(', ')));
        $('outline').appendChild(li);
      });
    }
    $('outlineBox').classList.toggle('hidden', !r.typebot);

    if (!$('fileName').value || $('fileName').dataset.auto === '1') {
      $('fileName').value = r.fileName;
      $('fileName').dataset.auto = '1';
    }
    $('saveBtn').disabled = !r.canExport;
    setStatus('saveStatus', r.canExport ? '' : 'Saving unlocks when the red problems are fixed.');
  }
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
      try { await miro.board.deselect(); await miro.board.select({ id }); } catch (_) { /* selecting needs extra permission; zooming is enough */ }
    } catch (_) {
      setStatus('saveStatus', 'Couldn’t show that box. Press Re-test.');
    }
  }

  // ───────── save ─────────
  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function fileNameValue() {
    let n = $('fileName').value.trim() || state.result.fileName;
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

  $('saveBtn').addEventListener('click', () => {
    if (!state.result || !state.result.canExport) return;
    const name = fileNameValue();
    const text = JSON.stringify(state.result.typebot, null, 2);
    // Browsers only show the "choose a folder" window from a normal tab, not from inside Miro,
    // so the save step opens in its own tab. The file travels in the link's # part and never leaves the computer.
    const url = 'save.html#' + encodeURIComponent(name) + '|' + toBase64(text);
    const win = window.open(url, '_blank');
    if (win) {
      setStatus('saveStatus', 'A save tab opened. Choose the folder there.', true);
    } else {
      downloadHere(name, text);
      setStatus('saveStatus', `Your browser blocked the save tab, so “${name}” went to your Downloads folder.`, true);
    }
  });

  function setStatus(id, msg, good) {
    const el = $(id);
    el.textContent = msg;
    el.classList.toggle('good', !!good);
  }

  loadFrames().catch(() => setStatus('testStatus', 'Couldn’t list frames. Reopen the app.'));
})();
