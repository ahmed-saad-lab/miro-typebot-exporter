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

  // ───────── progress ─────────
  const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120)));
  let busy = false;
  const progress = {
    start(withSave) {
      $('progress').classList.remove('hidden');
      $('lastRun').textContent = '';
      document.querySelectorAll('#steps li').forEach((li) => (li.className = ''));
      document.querySelector('#steps [data-step="save"]').classList.toggle('hidden', !withSave);
      this.total = withSave ? 4 : 3; this.doneCount = 0; this.setBar();
      setBusy(true);
    },
    step(name) { const li = document.querySelector(`#steps [data-step="${name}"]`); li.className = 'doing'; },
    done(name) { document.querySelector(`#steps [data-step="${name}"]`).className = 'done'; this.doneCount++; this.setBar(); },
    fail(name, msg) {
      document.querySelector(`#steps [data-step="${name}"]`).className = 'failed';
      $('lastRun').textContent = msg;
      setBusy(false);
    },
    finish(msg) { $('bar').style.width = '100%'; $('lastRun').textContent = msg; setBusy(false); },
    setBar() { $('bar').style.width = Math.round((this.doneCount / this.total) * 100) + '%'; },
  };
  function setBusy(on) {
    busy = on;
    ['testBtn', 'bypassBtn', 'retestBtn', 'anywayBtn'].forEach((id) => ($(id).disabled = on));
    $('testBtn').textContent = on ? 'Working…' : 'Test flow';
  }
  const timeNow = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // read → build → check, shown step by step
  async function runSteps(autoAll, withSave) {
    if (!state.frameId) { setStatus('testStatus', 'Choose the frame to export first.'); return null; }
    if (busy) return null;
    setStatus('testStatus', '');
    progress.start(withSave);
    $('progress').scrollIntoView({ block: 'nearest' });
    progress.step('read'); await paint();
    try { state.input = await readFrame(state.frameId); }
    catch (err) { progress.fail('read', err.message || 'Couldn’t read the frame. Try again.'); return null; }
    progress.done('read');
    progress.step('build'); await paint();
    let r;
    try { r = convertNow(autoAll); }
    catch (err) { progress.fail('build', 'Something in this frame couldn’t be converted: ' + err.message); return null; }
    progress.done('build');
    progress.step('check'); await paint();
    const technical = r.typebot ? MiroTypebot.validate(r.typebot).filter((x) => !/^(Button without edge|Reply title|List row)/.test(x)) : ['Nothing to export'];
    if (technical.length && r.typebot) { progress.fail('check', 'The import check failed: ' + technical.join('; ')); return null; }
    progress.done('check');
    state.result = r;
    render(r, autoAll);
    const errs = r.issues.filter((i) => i.severity === 'error').length;
    const summary = `${r.stats.blocks} components, ${errs ? errs + ' to fix' : 'no problems'}`;
    if (!withSave) progress.finish(`Tested at ${timeNow()}: ${summary}.`);
    else progress.lastSummary = summary;
    return r;
  }

  // ───────── test ─────────
  async function testFromBoard() {
    const r = await runSteps(false, false);
    if (r) $('verdict').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  $('testBtn').addEventListener('click', testFromBoard);
  $('retestBtn').addEventListener('click', testFromBoard);
  function run() {
    state.result = convertNow(false);
    render(state.result, false);
  }

  // ───────── export without testing ─────────
  // Every safe fix is applied automatically and the file still goes through the import check.
  async function exportAuto() {
    if (!state.frameId) return setStatus('testStatus', 'Choose the frame to export first.');
    if (busy) return;
    const win = openSaveTab(); // open now, while the click still counts, then fill it in
    const r = await runSteps(true, true);
    if (!r || !r.canExport) {
      if (win) win.close();
      if (r) {
        const why = r.issues.find((i) => i.severity === 'error');
        progress.fail('save', why ? why.detail : 'This frame has nothing to export.');
      }
      return;
    }
    progress.step('save'); await paint();
    deliver(win, fileNameValue(), JSON.stringify(r.typebot, null, 2));
    progress.done('save');
    progress.finish(`Exported at ${timeNow()}: ${progress.lastSummary}.`);
  }
  $('bypassBtn').addEventListener('click', exportAuto);
  $('anywayBtn').addEventListener('click', exportAuto);

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
    $('saveBtn').disabled = false;
    $('saveBtn').classList.toggle('is-blocked', !r.canExport);
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
    lastFile = { name, text };
    $('fallback').classList.remove('hidden');
    $('copyHelp').classList.add('hidden');
    setOpen(document.querySelector('.sec[data-sec="save"]'), true, false);
    if (win && !win.closed) {
      try {
        win.location.href = new URL('save.html', location.href).href + '#' + encodeURIComponent(name) + '|' + toBase64(text);
        setStatus('saveStatus', 'Opening the save tab…', true);
        $('fallbackText').textContent = 'Didn’t see a save tab? Use one of these instead:';
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => {
          setStatus('saveStatus', 'The save tab didn’t answer. Use “Download” or “Copy file contents”.');
        }, 4000);
        return;
      } catch (_) { /* fall through */ }
    }
    setStatus('saveStatus', 'Your browser blocked the save tab. Use “Download” or “Copy file contents”.');
    $('fallbackText').textContent = 'Save the file with one of these:';
  }
  $('saveBtn').addEventListener('click', () => {
    if (!state.result) return setStatus('saveStatus', 'Press “Test flow” first.');
    if (!state.result.canExport) {
      const n = state.result.issues.filter((i) => i.severity === 'error').length;
      setStatus('saveStatus', `Can’t save yet: ${n} red problem${n > 1 ? 's' : ''} in “Must fix”. Fix ${n > 1 ? 'them' : 'it'}, or press “Export anyway”.`);
      const sec = $('secErrors');
      setOpen(sec, true, false);
      sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
      sec.classList.remove('flash'); void sec.offsetWidth; sec.classList.add('flash');
      return;
    }
    deliver(openSaveTab(), fileNameValue(), JSON.stringify(state.result.typebot, null, 2));
  });

  // the save tab tells us it received the file
  let lastFile = null, confirmTimer = null;
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'tbx-received') return;
    clearTimeout(confirmTimer);
    setStatus('saveStatus', 'The save tab is open. Switch to it and choose the folder.', true);
    $('fallbackText').textContent = 'Save tab not working? Use one of these instead:';
  });
  $('dlHere').addEventListener('click', () => {
    if (!lastFile) return;
    downloadHere(lastFile.name, lastFile.text);
    setStatus('saveStatus', `Downloading “${lastFile.name}” to your Downloads folder. If nothing appears, use “Copy file contents”.`, true);
  });
  $('copyJson').addEventListener('click', async () => {
    if (!lastFile) return;
    let ok = false;
    try { await navigator.clipboard.writeText(lastFile.text); ok = true; } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = lastFile.text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
    }
    $('copyName').textContent = lastFile.name;
    $('copyHelp').classList.toggle('hidden', !ok);
    if (!ok) setStatus('saveStatus', 'Copying was blocked by the browser. Use “Download”.');
  });

  function setStatus(id, msg, good) {
    const el = $(id);
    el.textContent = msg;
    el.classList.toggle('good', !!good);
  }

  loadFrames().catch(() => setStatus('testStatus', 'Couldn’t list frames. Reopen the app.'));
})();
