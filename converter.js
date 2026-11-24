/*
 * Miro → Typebot converter (house conventions, WhatsApp build).
 * Pure logic: no Miro calls here, so it can be tested on its own.
 *
 * convert(input, options) → { typebot, stats, autoFixes, issues, botName, fileName }
 *   input   = { frame:{id,title}, items:[{id,type,shape,html|text,url,x,y}], connectors:[{id,from,to,caption}] }
 *   options = { limit:Number, overrides:{...} }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiroTypebot = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────── text helpers ─────────────────────────
  const ID_FIRST = 'abcdefghijklmnopqrstuvwxyz';
  const ID_REST = 'abcdefghijklmnopqrstuvwxyz0123456789';

  function makeIdFactory() {
    const used = new Set();
    return function () {
      let id;
      do {
        id = ID_FIRST[Math.floor(Math.random() * 26)];
        for (let i = 1; i < 24; i++) id += ID_REST[Math.floor(Math.random() * 36)];
      } while (used.has(id));
      used.add(id);
      return id;
    };
  }

  function decodeEntities(s) {
    return s
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, '&');
  }

  function cleanText(s) {
    return String(s || '')
      .replace(/\r/g, '')
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, '') // invisible characters
      .replace(/[ \t\u00a0]+/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function htmlToText(html, linkLog) {
    if (!html) return '';
    let s = String(html);
    s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
      const label = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim();
      href = decodeEntities(href).trim();
      if (!label || label === href || href.replace(/^https?:\/\//, '') === label.replace(/^https?:\/\//, '')) return href;
      if (linkLog) linkLog.push({ label, href });
      return label + ' ' + href;
    });
    s = s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, '');
    return cleanText(decodeEntities(s));
  }

  const short = (t, n) => {
    const one = String(t || '').replace(/\s+/g, ' ').trim();
    return one.length > n ? one.slice(0, n - 1) + '…' : one;
  };
  const charLen = (s) => Array.from(s || '').length; // counts emoji as 1, like WhatsApp

  // ───────────────────────── recognisers ─────────────────────────
  const RX = {
    end: /^(?:(?:إنهاء|انهاء|إغلاق|اغلاق|انتهاء)\s*(?:ال)?(?:محادثة|محادثه|شات|دردشة)|(?:end|close)\s*(?:the\s*)?(?:chat|conversation))[\s.!]*$/i,
    menu: /^(?:(?:العودة|الرجوع|رجوع|عودة|ارجع|إرجع)\s*(?:إلى|الى|ل)?\s*)?(?:ال|ل)?قائمة\s*(?:ال)?رئيسي[ةه][\s.!]*$|^(?:back\s*to\s*(?:the\s*)?)?main\s*menu[\s.!]*$/i,
    assignWord: /تعيين|إسناد|اسناد|assign/i,
    assignStart: /^(?:تعيين|إسناد|اسناد|assign)/i,
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    emailSlot: /\[[^\]]*(?:بريد|ايميل|إيميل|email|mail)[^\]]*\]/i,
    dummyEmail: /example\.|test@|xxx|@domain\.|@email\.|replace/i,
    wait: /^(?:wait|انتظار|انتظر)\s*(\d+)?\s*(?:s|sec|secs|seconds|ثانية|ثواني|ثوان)?[\s.!]*$/i,
    inputMarker: /^\[?(?:text\s*input|user\s*input|إدخال\s*نص|ادخال\s*نص|رد\s*العميل|انتظار\s*رد\s*العميل)\]?$/i,
    ask: /(?:توضيح|وضّح|وضح|وصف|اشرح|شرح|إرفاق|ارفاق|ارفق|أرفق|كتابة|اكتب|زودنا|تزويدنا|أدخل|ادخل|إدخال|describe|explain|attach|type your|write your|enter your|provide)/i,
    name: /(?:اسمك|الاسم|اسم حضرتك|your name|full name)/i,
    assist: /(?:هل|في)\s*(?:تحتاج|تريد|ترغب|عندك|لديك|يوجد).*(?:أخرى|اخرى|آخر|اخر|شيء|شي|مساعدة)|anything else|other help|need more help/i,
    welcome: /السلام|مرحب|أهلا|اهلا|أهلاً|اهلاً|welcome|hello|\bhi\b/i,
    condTrue: /قديم|حالي|سابق|مسجل|returning|existing|\bold\b/i,
    condAny: /جديد|قديم|حالي|سابق|مسجل|\bnew\b|returning|existing|\bold\b/i,
    arabic: /[\u0600-\u06FF]/,
    vars: /\{\{\s*([^{}]+?)\s*\}\}/g,
  };
  const DIAMONDS = new Set(['rhombus', 'flow_chart_decision', 'diamond']);
  const NOTE_TYPES = new Set(['sticky_note', 'embed', 'document', 'preview', 'frame', 'mindmap_node', 'unsupported']);

  const DEFAULT_BODY = 'الرجاء الاختيار من التالي:';
  const DEFAULT_MENU_TITLE = 'اختر من القائمة';
  const DEFAULT_PROMPT = 'الرجاء توضيح معلومات كافية في رسالة واحدة';
  const PLACEHOLDER_EMAIL = 'replace-with-team-email@example.com';

  // ───────────────────────── main ─────────────────────────
  function convert(input, options) {
    options = options || {};
    const limit = options.limit || 0;
    const ov = Object.assign(
      { asMessage: [], skip: [], deadEnd: {}, truncateRows: false, numberDuplicates: false, placeholderEmail: [], startNodeId: null, keyword: '', menuTitle: '', useBoxLabels: false, autoAll: false },
      options.overrides || {}
    );
    const asMessage = new Set(ov.asMessage);
    const skip = new Set(ov.skip);
    const placeholderEmail = new Set(ov.placeholderEmail);
    const AUTO = !!ov.autoAll; // export without testing: apply every safe fix automatically

    const newId = makeIdFactory();
    const autoFixes = [];
    const issues = [];
    let seq = 0;
    const addIssue = (severity, title, detail, nodeId, fixes) =>
      issues.push({ id: 'i' + ++seq, severity, title, detail, nodeId: nodeId || null, fixes: fixes || [] });
    const addAuto = (text, nodeId) => autoFixes.push({ text, nodeId: nodeId || null });

    // 1 ─ nodes
    const nodes = new Map();
    for (const it of input.items || []) {
      const n = { id: it.id, type: it.type || 'shape', shape: it.shape || '', x: +it.x || 0, y: +it.y || 0, w: +it.width || 0, h: +it.height || 0, links: [], out: [], in: [] };
      n.text = it.text != null ? cleanText(it.text) : htmlToText(it.html, n.links);
      n.url = it.url || '';
      nodes.set(n.id, n);
    }

    // 2 ─ arrows
    const seenArrow = new Set();
    let dupArrows = 0;
    for (const c of input.connectors || []) {
      const { from, to } = c;
      if (!from || !to) {
        if (from && nodes.has(from)) continue; // handled with the buttons (shared lines)
        addIssue('warning', 'Arrow with a loose end', 'One end of this arrow is not attached to a box, so the arrow was ignored. Attach both ends.', from || to);
        continue;
      }
      if (!nodes.has(from) || !nodes.has(to)) {
        addIssue('warning', 'Arrow leaves the frame', 'This arrow connects to something outside the selected frame, so it was ignored.', nodes.has(from) ? from : to);
        continue;
      }
      if (from === to) {
        addIssue('warning', 'Arrow loops onto the same box', 'This arrow starts and ends on the same box, so it was ignored.', from);
        continue;
      }
      const caption = htmlToText(c.caption || '');
      const key = from + '>' + to + '>' + caption;
      if (seenArrow.has(key)) { dupArrows++; continue; }
      seenArrow.add(key);
      const e = { id: c.id, from, to, caption };
      nodes.get(from).out.push(e);
      nodes.get(to).in.push(e);
    }
    if (dupArrows) addAuto(`Removed ${dupArrows} duplicate arrow${dupArrows > 1 ? 's' : ''} drawn on top of each other`);

    // 3 ─ what each box is
    const core = (t) => t.replace(/^\s*[\d\u0660-\u0669]+\s*[.\-)\u2013:]\s*/, '').trim(); // drop “1.” / “0-” numbering
    const notes = [];
    for (const n of nodes.values()) {
      const connected = n.in.length + n.out.length > 0;
      const t = n.text;
      if (NOTE_TYPES.has(n.type)) {
        n.kind = 'note';
        if (connected && n.type === 'sticky_note')
          addIssue('warning', 'Sticky note has arrows', 'Sticky notes are treated as designer notes and are not exported. If this is part of the chat, change it to a shape.', n.id);
      } else if (skip.has(n.id)) n.kind = 'pass';
      else if (n.type === 'image') n.kind = connected ? 'image' : 'note';
      else if (n.type === 'text' && !connected) n.kind = 'note';
      else if (!t) {
        n.kind = connected ? 'empty' : 'note';
      } else if (asMessage.has(n.id)) n.kind = 'message';
      else if (RX.end.test(core(t))) n.kind = 'end';
      else if (RX.menu.test(core(t))) n.kind = 'menuRef';
      else if (RX.wait.test(core(t))) n.kind = 'wait';
      else if (RX.inputMarker.test(core(t))) n.kind = 'inputMarker';
      else if (
        (DIAMONDS.has(n.shape) && (RX.email.test(t) || RX.assignWord.test(t))) ||
        (RX.assignWord.test(t) && RX.email.test(t) && t.length < 120) ||
        RX.assignStart.test(t)
      ) n.kind = 'assign';
      else n.kind = 'message';
      if (n.kind === 'note' && t) notes.push(n);
    }
    // a diamond at the end of a branch hands the chat to a team (e.g. “الفرع المختار = قرطبة؟”)
    for (const n of nodes.values())
      if (n.kind === 'message' && DIAMONDS.has(n.shape) && n.in.length && !n.out.length) { n.kind = 'assign'; n.assignGuess = true; }
    for (const n of nodes.values()) {
      if (n.kind === 'empty') {
        addAuto('Skipped an empty box and joined the arrows around it', n.id);
        n.kind = 'pass';
        n.blockedEmpty = true;
      }
    }
    if (notes.length) addAuto(`Left out ${notes.length} sticky note${notes.length > 1 ? 's' : ''} / unconnected text${notes.length > 1 ? 's' : ''} (designer notes)`);

    // 4 ─ branches and button boxes
    const optionBoxes = new Set();
    const resolve = (id) => {
      const t = nodes.get(id);
      if (t.kind === 'menuRef') return { t: 'menu' };
      if (t.kind === 'note') return null;
      return { t: 'node', id };
    };
    const lines = (t) => t.split('\n').filter((l) => l.trim()).length;
    const shortText = (t) => lines(t.text) <= 2 && charLen(t.text) <= 40 && !RX.ask.test(t.text);
    const isOptionLike = (t) => {
      if (t.kind === 'menuRef') return true;
      if (t.kind === 'end') return t.out.length <= 1;
      return t.kind === 'message' && t.in.length === 1 && shortText(t) && t.out.length <= 1;
    };
    const branching = (n) => ['message', 'image', 'pass'].includes(n.kind);
    const arrowBetween = (a, b) => a.out.some((e) => e.to === b.id) || b.out.some((e) => e.to === a.id);

    // buttons drawn as a stack of boxes right under the question (no arrows between them)
    const sized = [...nodes.values()].filter((n) => n.w > 0 && n.h > 0 && n.kind !== 'note' && n.type !== 'image');
    const overlapX = (a, b) => Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2);
    const gapY = (a, b) => (b.y - b.h / 2) - (a.y + a.h / 2);
    const nextBelow = (a) => sized
      .filter((b) => b !== a && gapY(a, b) >= -2 && gapY(a, b) <= Math.max(14, 0.9 * Math.min(a.h, b.h)) && overlapX(a, b) >= 0.5 * Math.min(a.w, b.w))
      .sort((p, q) => gapY(a, p) - gapY(a, q))[0];
    const inStack = new Set();
    for (const q of sized.slice().sort((a, b) => a.y - b.y)) {
      if (inStack.has(q.id) || !branching(q) || !q.text) continue;
      const members = [];
      let cur = q;
      for (;;) {
        const b = nextBelow(cur);
        if (!b || inStack.has(b.id) || members.includes(b)) break;
        if (cur !== q && arrowBetween(cur, b)) break; // boxes joined by arrows are a normal sequence
        if (cur === q && b.out.some((e) => e.to === q.id)) break;
        if (!(b.kind === 'menuRef' || b.kind === 'end' || (b.kind === 'message' && shortText(b)))) break;
        if (b.out.length > 1) break;
        members.push(b);
        cur = b;
      }
      const noArrowMembers = members.filter((m, i) => i > 0 || !q.out.some((e) => e.to === m.id));
      if (members.length >= 2 && noArrowMembers.length >= 1) {
        q.stack = members;
        members.forEach((m) => inStack.add(m.id));
      }
    }

    const looseFrom = new Map(); // box → arrows whose far end isn't attached
    for (const c of input.connectors || []) if (c.from && !c.to && nodes.has(c.from)) looseFrom.set(c.from, (looseFrom.get(c.from) || 0) + 1);

    const joined = new Map(); // shared-line destination → buttons that follow it
    function optionDest(t, label, siblings, stacked) {
      if (t.kind === 'menuRef') return { t: 'menu' };
      if (t.out.length === 1) return resolve(t.out[0].to);
      if (t.kind === 'end') return { t: 'end' };
      if (ov.deadEnd[t.id]) return { t: ov.deadEnd[t.id] };
      // lines from several buttons joined into one shared line: follow the sibling that is attached
      const shared = [...new Map(siblings.filter((s) => s !== t && s.kind === 'message' && s.out.length === 1)
        .map((s) => resolve(s.out[0].to)).filter((d) => d && d.t === 'node').map((d) => [d.id, d])).values()];
      if (shared.length === 1 && (looseFrom.has(t.id) || (stacked && siblings.length >= 3))) {
        const key = shared[0].id;
        if (!joined.has(key)) joined.set(key, []);
        joined.get(key).push({ id: t.id, label });
        return shared[0];
      }
      if (AUTO) {
        addAuto(`Sent the button “${short(label, 30)}” back to the main menu (it had no next step)`, t.id);
        return { t: 'menu' };
      }
      addIssue('warning', 'Button leads nowhere', `The button “${short(label, 30)}” has no arrow to a next step.`, t.id, [
        { label: 'Go to main menu', patch: { op: 'map', key: 'deadEnd', mapKey: t.id, value: 'menu' } },
        { label: 'End the chat', patch: { op: 'map', key: 'deadEnd', mapKey: t.id, value: 'end' } },
      ]);
      return null;
    }

    for (const n of nodes.values()) {
      if (n.kind === 'note' || inStack.has(n.id)) continue;
      const outs = n.out.filter((e) => nodes.get(e.to).kind !== 'note' && !(n.stack && n.stack.some((m) => m.id === e.to)));
      const stackCount = n.stack ? n.stack.length : 0;
      if (outs.length >= 2 && !branching(n)) {
        addIssue('error', 'Too many arrows leave this box', `A ${n.kind === 'assign' ? 'team-assign' : n.kind} box can only continue to one next step, but it has ${outs.length} arrows.`, n.id);
        n.next = resolve(outs[0].to);
        continue;
      }
      if (outs.length + stackCount >= 2) {
        if (!stackCount && outs.length === 2 && outs.every((e) => e.caption && RX.condAny.test(e.caption))) {
          const tIdx = outs.findIndex((e) => RX.condTrue.test(e.caption));
          const trueE = outs[tIdx >= 0 ? tIdx : 1];
          const elseE = outs[tIdx >= 0 ? 1 - tIdx : 0];
          n.branch = { kind: 'condition', trueDest: resolve(trueE.to), elseDest: resolve(elseE.to), trueLabel: trueE.caption, elseLabel: elseE.caption };
          addIssue('warning', 'Read as a condition', `The arrows “${trueE.caption}” / “${elseE.caption}” became a Condition on the variable “name” (Is set → “${trueE.caption}”). Check this matches your intent.`, n.id);
          continue;
        }
        // arrow-linked buttons, ordered right-to-left on Arabic boards when side by side
        const pos = outs.map((e) => nodes.get(e.to));
        const spreadX = pos.length ? Math.max(...pos.map((p) => p.x)) - Math.min(...pos.map((p) => p.x)) : 0;
        const spreadY = pos.length ? Math.max(...pos.map((p) => p.y)) - Math.min(...pos.map((p) => p.y)) : 0;
        const rtl = RX.arabic.test(n.text + pos.map((p) => p.text).join(''));
        const sorted = outs.slice().sort((a, b) => {
          const A = nodes.get(a.to), B = nodes.get(b.to);
          return spreadX > spreadY ? (rtl ? B.x - A.x : A.x - B.x) : A.y - B.y;
        });
        const arrowOptions = sorted.map((e) => nodes.get(e.to)).filter((t) => !sorted.find((e) => e.to === t.id).caption && isOptionLike(t));
        const items = [];
        for (const e of sorted) {
          const t = nodes.get(e.to);
          if (e.caption) {
            items.push({ label: short(e.caption, 200), dest: resolve(e.to), nodeId: n.id });
          } else if (isOptionLike(t)) {
            optionBoxes.add(t.id);
            const label = t.text.replace(/\s*\n\s*/g, ' ');
            items.push({ label, dest: optionDest(t, label, arrowOptions), nodeId: t.id, menuRef: t.kind === 'menuRef' });
          } else if ((ov.useBoxLabels || AUTO) && t.text) {
            items.push({ label: short(t.text.split('\n')[0], 20), dest: resolve(e.to), nodeId: t.id });
            addAuto(`Used the start of “${short(t.text, 30)}” as button text`, t.id);
          } else {
            addIssue('error', 'Branch without button text', `An arrow from this question goes straight to “${short(t.text || t.kind, 30)}”, so there is no button text. Add a label on the arrow, or put a short button box in between.`, n.id, t.text ? [
              { label: 'Use the box text as button', patch: { op: 'set', key: 'useBoxLabels', value: true } },
            ] : []);
          }
        }
        // stacked buttons, top to bottom
        if (stackCount) {
          for (const t of n.stack) {
            optionBoxes.add(t.id);
            const label = t.text.replace(/\s*\n\s*/g, ' ');
            items.push({ label, dest: optionDest(t, label, n.stack, true), nodeId: t.id, menuRef: t.kind === 'menuRef' });
          }
          addAuto(`Read ${stackCount} boxes stacked under “${short(n.text, 30)}” as its buttons`, n.id);
        }
        n.branch = { kind: 'choice', items };
        continue;
      }
      if (outs.length === 1) n.next = resolve(outs[0].to);
    }
    for (const [destId, list] of joined)
      addIssue('warning', 'Buttons joined to a shared line', `${list.map((b) => '“' + short(b.label, 24) + '”').join(', ')} have no arrow of their own, so they go where the shared line goes: “${short(nodes.get(destId).text, 30)}”.`, list[0].id);
    // loose arrows that were not used as a shared line
    for (const [id, count] of looseFrom) if (!optionBoxes.has(id))
        addIssue('warning', 'Arrow with a loose end', `${count > 1 ? count + ' arrows' : 'An arrow'} from this box ${count > 1 ? 'are' : 'is'} not attached at the far end, so ${count > 1 ? 'they were' : 'it was'} ignored.`, id);

    // boxes with no arrows that are not stacked buttons
    const anyArrows = [...nodes.values()].some((n) => n.out.length);
    for (const n of nodes.values()) {
      if (anyArrows && n.kind !== 'note' && !optionBoxes.has(n.id) && !n.branch && n.in.length + n.out.length === 0) {
        n.kind = 'note';
        addIssue('warning', 'Box not connected', `“${short(n.text || n.type, 40)}” has no arrows, so it won’t be exported.`, n.id);
      }
    }

    // arrows that land on a shared "end chat" button box go to the shared end step
    const fixDest = (d) => (d && d.t === 'node' && optionBoxes.has(d.id) ? (nodes.get(d.id).kind === 'end' ? { t: 'end' } : d) : d);
    for (const n of nodes.values()) {
      n.next = fixDest(n.next);
      if (n.branch && n.branch.kind === 'choice') n.branch.items.forEach((i) => (i.dest = fixDest(i.dest)));
      if (n.branch && n.branch.kind === 'condition') { n.branch.trueDest = fixDest(n.branch.trueDest); n.branch.elseDest = fixDest(n.branch.elseDest); }
    }

    // a box that asks the customer to write something
    for (const n of nodes.values()) {
      if (n.kind !== 'message' || n.branch || optionBoxes.has(n.id) || asMessage.has(n.id)) continue;
      const nextNode = n.next && n.next.t === 'node' ? nodes.get(n.next.id) : null;
      if (nextNode && nextNode.kind === 'inputMarker') continue;
      if (RX.ask.test(n.text) || (RX.name.test(n.text) && /[?؟]/.test(n.text))) {
        n.ask = true;
        n.askName = RX.name.test(n.text);
        addIssue('warning', 'Customer reply added', `This message asks the customer to write something, so a text input was added after it${n.askName ? ' (saved in the variable “name”)' : ''}.`, n.id, [
          { label: 'It’s only a message', patch: { op: 'add', key: 'asMessage', value: n.id } },
        ]);
      }
    }

    // 5 ─ flow nodes and start
    const isFlow = (n) => !['note', 'menuRef'].includes(n.kind) && !optionBoxes.has(n.id);
    const flow = [...nodes.values()].filter(isFlow);
    const incoming = new Map(flow.map((n) => [n.id, 0]));
    const destsOf = (n) => {
      const d = [];
      if (n.next) d.push(n.next);
      if (n.branch && n.branch.kind === 'choice') n.branch.items.forEach((i) => i.dest && d.push(i.dest));
      if (n.branch && n.branch.kind === 'condition') [n.branch.trueDest, n.branch.elseDest].forEach((x) => x && d.push(x));
      return d;
    };
    for (const n of flow) for (const d of destsOf(n)) if (d.t === 'node' && incoming.has(d.id)) incoming.set(d.id, incoming.get(d.id) + 1);

    if (!flow.length) {
      addIssue('error', 'Nothing to export', 'This frame has no connected boxes. Pick the frame that holds the chat flow.');
      return finish(null);
    }

    let start = ov.startNodeId && nodes.has(ov.startNodeId) ? nodes.get(ov.startNodeId) : null;
    const topLeft = (arr) => arr.slice().sort((a, b) => (Math.abs(a.y - b.y) > 40 ? a.y - b.y : (RX.arabic.test(a.text) ? b.x - a.x : a.x - b.x)))[0];
    if (!start) {
      const welcome = flow.filter((n) => n.kind === 'message' && RX.welcome.test(n.text)).sort((a, b) => a.y - b.y)[0];
      if (welcome && incoming.get(welcome.id) > 0) start = welcome;
    }
    if (!start) {
      const roots = flow.filter((n) => incoming.get(n.id) === 0 && n.kind !== 'end');
      if (roots.length === 1) start = roots[0];
      else if (roots.length > 1) {
        start = roots.find((n) => RX.welcome.test(n.text)) || topLeft(roots);
        addIssue('warning', 'More than one starting box', `${roots.length} boxes have no arrow coming in. The bot will start at “${short(start.text, 40)}”.`, start.id,
          roots.filter((r) => r !== start).slice(0, 3).map((r) => ({ label: `Start at “${short(r.text, 18)}”`, patch: { op: 'set', key: 'startNodeId', value: r.id } })));
      } else {
        const guess = flow.find((n) => RX.welcome.test(n.text)) || topLeft(flow);
        start = guess;
        addIssue('warning', 'Starting box chosen', `Every box has an arrow coming in, so the bot will start at “${short(guess.text, 40)}”.`, guess.id);
      }
    }

    // main menu = first question reachable from the start
    let menuNode = null;
    {
      const q = [start.id], seen = new Set();
      while (q.length && !menuNode) {
        const n = nodes.get(q.shift());
        if (!n || seen.has(n.id)) continue;
        seen.add(n.id);
        if (n.branch && n.branch.kind === 'choice') { menuNode = n; break; }
        destsOf(n).forEach((d) => d.t === 'node' && q.push(d.id));
      }
    }

    // 6 ─ groups
    const heads = new Set([start.id]);
    if (menuNode) heads.add(menuNode.id);
    for (const n of flow) {
      if (incoming.get(n.id) !== 1) heads.add(n.id);
      if (n.branch && n.branch.kind === 'choice' && n.kind === 'message') heads.add(n.id); // typed replies re-show just the question
      if (n.branch) for (const d of destsOf(n)) if (d.t === 'node') heads.add(d.id);
    }

    const groups = [];
    const groupOfNode = new Map();
    const edges = [];
    const variables = new Map();
    const varId = (name) => {
      if (!variables.has(name)) variables.set(name, { id: 'v' + newId().slice(1), name });
      return variables.get(name).id;
    };
    let endGroup = null;
    let menuGroup = null;
    let usedListTitle = false;

    const textBlock = (t) => ({
      id: newId(),
      type: 'text',
      content: { richText: t.split('\n').map((l) => ({ type: 'p', children: [{ text: l }] })) },
    });

    function checkLength(n, t, max, what) {
      if (charLen(t) > max) addIssue('error', `${what} is too long`, `WhatsApp allows ${max} characters; this one has ${charLen(t)}. Shorten it on the board.`, n.id);
    }

    function choiceBlock(n) {
      let body = n.text;
      if (!body) { body = DEFAULT_BODY; addAuto(`Added the question “${DEFAULT_BODY}” above buttons that had none`, n.id); }
      checkLength(n, body, 1024, 'Question text');
      let items = n.branch.items.slice();
      // duplicate labels
      const counts = {};
      items.forEach((i) => (counts[i.label] = (counts[i.label] || 0) + 1));
      const dups = Object.keys(counts).filter((k) => counts[k] > 1);
      if (dups.length) {
        if (ov.numberDuplicates || AUTO) {
          const seenL = {};
          items = items.map((i) => {
            seenL[i.label] = (seenL[i.label] || 0) + 1;
            return seenL[i.label] > 1 ? Object.assign({}, i, { label: i.label + ' ' + seenL[i.label] }) : i;
          });
          addAuto('Numbered repeated button texts so WhatsApp accepts them', n.id);
        } else {
          addIssue('error', 'Two buttons have the same text', `WhatsApp needs every button in a question to be different: “${short(dups[0], 24)}”.`, n.id, [
            { label: 'Number them', patch: { op: 'set', key: 'numberDuplicates', value: true } },
          ]);
        }
      }
      items = items.map((i) => {
        if (!i.menuRef || charLen(i.label) <= 20) return i;
        const num = (i.label.match(/^\s*[\d\u0660-\u0669]+\s*[.\-)]\s*/) || [''])[0];
        const label = num + 'القائمة الرئيسية';
        addAuto(`Shortened “${short(i.label, 30)}” to “${label}”`, i.nodeId);
        return Object.assign({}, i, { label });
      });
      const fitsReply = items.length <= 3 && items.every((i) => charLen(i.label) <= 20);
      const options = { isInteractive: true };
      if (fitsReply) {
        options.interactiveButtonType = 'reply';
        options.interactiveData = { body };
      } else {
        if (items.length <= 3) addAuto('Switched a question to a list menu because a button text is longer than 20 characters', n.id);
        options.interactiveButtonType = 'list';
        const menuTitle = ov.menuTitle || DEFAULT_MENU_TITLE;
        usedListTitle = true;
        options.interactiveData = { menuTitle, body };
        if (items.length > 10) addIssue('error', 'More than 10 options', `WhatsApp lists hold up to 10 options; this question has ${items.length}. Split it into two questions on the board.`, n.id);
        const NUM = /^\s*[\d\u0660-\u0669]+\s*[.\-)]\s*/;
        items = items.map((i) => {
          if (charLen(i.label) <= 24 || !NUM.test(i.label)) return i;
          const label = i.label.replace(NUM, '');
          if (charLen(label) > 24) return i;
          addAuto(`Removed the number from “${short(i.label, 30)}” so it fits WhatsApp’s 24 characters`, i.nodeId);
          return Object.assign({}, i, { label });
        });
        const long = items.filter((i) => charLen(i.label) > 24);
        if (long.length) {
          if (ov.truncateRows || AUTO) {
            items = items.map((i) => (charLen(i.label) > 24 ? Object.assign({}, i, { label: Array.from(i.label).slice(0, 23).join('') + '…' }) : i));
            addAuto(`Shortened ${long.length} list option${long.length > 1 ? 's' : ''} to 24 characters`, n.id);
          } else {
            long.forEach((i) =>
              addIssue('error', 'Option text too long', `List options can have 24 characters; “${short(i.label, 40)}” has ${charLen(i.label)}.`, i.nodeId, [
                { label: 'Shorten all automatically', patch: { op: 'set', key: 'truncateRows', value: true } },
              ])
            );
          }
        }
      }
      return {
        id: newId(),
        type: 'choice input',
        items: items.map((i) => ({ id: newId(), content: i.label, _dest: i.dest })),
        options,
      };
    }

    function blocksFor(n, groupBlocks) {
      const out = [];
      switch (n.kind) {
        case 'message':
          checkLength(n, n.text, 4096, 'Message');
          if (n.links.length) addAuto(`Kept ${n.links.length} link${n.links.length > 1 ? 's' : ''} as plain text after the words`, n.id);
          if (n.branch && n.branch.kind === 'choice') out.push(choiceBlock(n));
          else {
            out.push(textBlock(n.text));
            if (n.ask) out.push({ id: newId(), type: 'text input', options: n.askName ? { variableId: varId('name') } : {} });
          }
          break;
        case 'image':
          out.push({ id: newId(), type: 'image', content: { url: 'https://REPLACE-WITH-IMAGE-LINK' } });
          addIssue('warning', 'Image needs a public link', 'Miro images can’t be linked directly. Replace “REPLACE-WITH-IMAGE-LINK” in Typebot after importing.', n.id);
          if (n.branch && n.branch.kind === 'choice') out.push(choiceBlock(n));
          break;
        case 'pass':
          if (n.branch && n.branch.kind === 'choice') out.push(choiceBlock(n));
          break;
        case 'assign': {
          const m = n.text.match(RX.email);
          let email = m ? m[0] : '';
          if (!email) {
            if (placeholderEmail.has(n.id) || AUTO || n.assignGuess || RX.emailSlot.test(n.text)) {
              email = PLACEHOLDER_EMAIL;
              addIssue('warning', n.assignGuess ? 'Read as a team assignment' : 'Placeholder team email', n.assignGuess
                ? `“${short(n.text, 40)}” ends this branch, so it became “Assign Chat”. Put the right team email in Typebot instead of “${PLACEHOLDER_EMAIL}”.`
                : `Replace “${PLACEHOLDER_EMAIL}” with the real team email in Typebot.`, n.id);
            } else {
              addIssue('error', 'Team assignment has no email', 'Write the team email inside this box on the board.', n.id, [
                { label: 'Use a placeholder', patch: { op: 'add', key: 'placeholderEmail', value: n.id } },
              ]);
            }
          } else if (RX.dummyEmail.test(email)) {
            addIssue('warning', 'Email looks like a sample', `“${email}” looks like a test address. Make sure it’s the client’s real team email.`, n.id);
          }
          out.push({ id: newId(), type: 'Assign Chat', options: { assignType: 'team', email } });
          break;
        }
        case 'end':
          out.push({ id: newId(), type: 'Close Chat' });
          break;
        case 'wait': {
          const s = (n.text.match(/\d+/) || ['1'])[0];
          out.push({ id: newId(), type: 'Wait', options: { secondsToWaitFor: String(s) } });
          break;
        }
        case 'inputMarker': {
          const prev = groupBlocks.concat(out).slice(-1)[0];
          if (!prev || prev.type !== 'text') {
            out.push(textBlock(DEFAULT_PROMPT));
            addAuto(`Added the prompt “${DEFAULT_PROMPT}” before a customer reply`, n.id);
          }
          out.push({ id: newId(), type: 'text input', options: {} });
          break;
        }
      }
      if (n.branch && n.branch.kind === 'condition') {
        varId('name');
        out.push({ id: newId(), type: 'Condition', _cond: n.branch });
      }
      return out;
    }

    function titleFor(node, blocks) {
      if (node === start) return 'start';
      if (node === menuNode) return 'menu';
      if (node.branch && node.branch.kind === 'choice' && RX.assist.test(node.text)) return 'assist';
      const firstText = node.text || (blocks[0] && blocks[0].type) || 'خطوة';
      return short(firstText.split('\n')[0], 30);
    }

    // walk the flow from the start, one group per head
    const queue = [start.id];
    const built = new Set();
    const pendingExits = [];
    while (queue.length) {
      const hid = queue.shift();
      if (built.has(hid)) continue;
      built.add(hid);
      const head = nodes.get(hid);
      const g = { id: newId(), title: '', graphCoordinates: { x: 0, y: 0 }, blocks: [], _head: head };
      let cur = head;
      const walked = new Set();
      for (;;) {
        walked.add(cur.id);
        groupOfNode.set(cur.id, g);
        g.blocks.push(...blocksFor(cur, g.blocks));
        if (cur.kind === 'end' && cur.next) {
          addIssue('warning', 'Arrow after “end chat”', 'The chat is closed at this box, so the arrow after it was ignored.', cur.id);
          cur.next = null;
        }
        const nx = cur.next;
        if (!cur.branch && nx && nx.t === 'node' && !heads.has(nx.id) && !walked.has(nx.id)) { cur = nodes.get(nx.id); continue; }
        break;
      }
      g.title = titleFor(head, g.blocks);
      g._tail = cur;
      groups.push(g);
      pendingExits.push(g);
      for (const d of destsOf(cur)) if (d.t === 'node' && !built.has(d.id)) queue.push(d.id);
    }
    menuGroup = menuNode ? groupOfNode.get(menuNode.id) : null;

    // groups with nothing in them (e.g. only skipped boxes) get a placeholder-free pass-through
    // they keep their exits so the flow is not broken

    function groupForDest(d) {
      if (!d) return null;
      if (d.t === 'node') return groupOfNode.get(d.id) || null;
      if (d.t === 'menu') {
        if (menuGroup) return menuGroup;
        if (AUTO) return groupForDest({ t: 'end' });
        return null;
      }
      if (d.t === 'end') {
        if (!endGroup) {
          endGroup = { id: newId(), title: 'إنهاء المحادثة', graphCoordinates: { x: 0, y: 0 }, blocks: [{ id: newId(), type: 'Close Chat' }] };
          groups.push(endGroup);
        }
        return endGroup;
      }
      return null;
    }
    const addEdge = (from, toGroup) => {
      const id = newId();
      edges.push({ id, from, to: { groupId: toGroup.id } });
      return id;
    };

    let menuMissingReported = false;
    for (const g of pendingExits) {
      const tail = g._tail;
      if (!g.blocks.length) {
        // only skipped boxes: give the group something harmless so Typebot keeps the link
        g.blocks.push({ id: newId(), type: 'Wait', options: { secondsToWaitFor: '1' } });
        addAuto('Put a 1-second wait where a skipped box was, to keep the flow connected', g._head.id);
      }
      const last = g.blocks[g.blocks.length - 1];
      if (last.type === 'choice input') {
        for (const item of last.items) {
          const tg = groupForDest(item._dest);
          if (tg) item.outgoingEdgeId = addEdge({ blockId: last.id, itemId: item.id }, tg);
          else if (item._dest && item._dest.t === 'menu' && !menuMissingReported) {
            menuMissingReported = true;
            addIssue('error', 'No main menu found', 'A button goes to “main menu”, but the flow has no question after the welcome message.', tail.id);
          }
          delete item._dest;
        }
        if (g !== menuGroup) last.outgoingEdgeId = addEdge({ blockId: last.id }, g); // re-show the buttons on a typed reply
      } else if (last.type === 'Condition') {
        const c = last._cond;
        delete last._cond;
        const tg = groupForDest(c.trueDest), eg = groupForDest(c.elseDest);
        const itemId = newId();
        const item = { id: itemId, content: { comparisons: [{ id: newId(), variableId: varId('name'), comparisonOperator: 'Is set' }], logicalOperator: 'AND' } };
        if (tg) item.outgoingEdgeId = addEdge({ blockId: last.id, itemId }, tg);
        last.items = [item];
        if (eg) last.outgoingEdgeId = addEdge({ blockId: last.id }, eg);
      } else if (tail.next && last.type !== 'Close Chat') {
        const tg = groupForDest(tail.next);
        if (tg) last.outgoingEdgeId = addEdge({ blockId: last.id }, tg);
        else if (tail.next.t === 'menu' && !menuMissingReported) {
          menuMissingReported = true;
          addIssue('error', 'No main menu found', 'An arrow goes to “main menu”, but the flow has no question after the welcome message.', tail.id);
        }
      }
    }
    for (const g of pendingExits) {
      const last = g.blocks[g.blocks.length - 1];
      if (!g._tail.next && !g._tail.branch && !['Close Chat', 'Assign Chat'].includes(last.type))
        addIssue('warning', 'Chat stops here', `After “${short(g._tail.text || g._tail.kind, 40)}” there is no next step, end chat or team assignment, so the customer is left waiting.`, g._tail.id);
    }

    // unreachable boxes
    const unreached = flow.filter((n) => !groupOfNode.has(n.id) && !n.blockedEmpty);
    if (unreached.length) {
      unreached.slice(0, 8).forEach((n) =>
        addIssue('warning', 'Box not connected to the flow', `“${short(n.text || n.kind, 40)}” can’t be reached from the welcome message, so it won’t be exported.`, n.id)
      );
      if (unreached.length > 8) addIssue('warning', 'More boxes not connected', `${unreached.length - 8} more boxes can’t be reached from the welcome message.`);
    }

    // global jump
    const keyword = String(ov.keyword || '').trim() || '1006';
    const startGroup = groupOfNode.get(start.id);
    const gj = { id: newId(), title: 'Global Jump', graphCoordinates: { x: 0, y: 0 }, blocks: [{ id: newId(), type: 'Global Jump', options: { text: keyword, groupId: startGroup.id } }] };
    groups.push(gj);
    if (usedListTitle) addAuto(`List menus open with the button “${ov.menuTitle || DEFAULT_MENU_TITLE}”`);

    // variables written in messages as {{name}}
    for (const g of groups) for (const b of g.blocks) if (b.type === 'text') {
      const s = b.content.richText.map((p) => p.children.map((c) => c.text).join('')).join('\n');
      let m; RX.vars.lastIndex = 0;
      while ((m = RX.vars.exec(s))) varId(m[1]);
    }

    // titles unique
    const usedTitles = {};
    for (const g of groups) {
      const base = g.title || 'خطوة';
      usedTitles[base] = (usedTitles[base] || 0) + 1;
      if (usedTitles[base] > 1) g.title = base + ' ' + usedTitles[base];
    }

    // layout: left → right by depth
    const eventId = newId();
    const startEdgeId = newId();
    edges.unshift({ id: startEdgeId, from: { eventId }, to: { groupId: startGroup.id } });
    {
      const depth = new Map([[startGroup.id, 0]]);
      const q = [startGroup.id];
      const byGroup = new Map(groups.map((g) => [g.id, g]));
      const nextGroups = (gid) => edges.filter((e) => e.from.blockId && byGroup.get(gid).blocks.some((b) => b.id === e.from.blockId)).map((e) => e.to.groupId);
      while (q.length) {
        const gid = q.shift();
        for (const t of nextGroups(gid)) if (!depth.has(t)) { depth.set(t, depth.get(gid) + 1); q.push(t); }
      }
      const maxD = Math.max(0, ...depth.values());
      const rows = {};
      for (const g of groups) {
        const d = g === gj ? -1 : depth.has(g.id) ? depth.get(g.id) : maxD + 1;
        rows[d] = (rows[d] || 0) + 1;
        g.graphCoordinates = d === -1 ? { x: 300, y: -330 } : { x: 300 + d * 550, y: (rows[d] - 1) * 330 };
      }
    }

    const now = new Date().toISOString();
    const botName = (input.frame && input.frame.title ? htmlToText(input.frame.title) : '') || 'Bot';
    const typebot = {
      version: '6',
      id: newId(),
      name: botName,
      events: [{ id: eventId, outgoingEdgeId: startEdgeId, graphCoordinates: { x: 0, y: 0 }, type: 'start' }],
      groups: groups.map((g) => ({ id: g.id, title: g.title, graphCoordinates: g.graphCoordinates, blocks: g.blocks })),
      edges,
      variables: [...variables.values()],
      theme: {},
      selectedThemeTemplateId: null,
      settings: {},
      createdAt: now,
      updatedAt: now,
      icon: null,
      folderId: null,
      publicId: null,
      customDomain: null,
      workspaceId: null,
      resultsTablePreferences: null,
      isArchived: false,
      isClosed: false,
      whatsAppCredentialsId: null,
      riskLevel: null,
    };

    selfRepair(typebot, addAuto);
    const leftover = validate(typebot).filter((p) => !DESIGN_PROBLEM.test(p));
    if (leftover.length) addIssue('error', 'Internal check failed', 'The file did not pass the Typebot import test: ' + leftover.join('; '));
    return finish(typebot, botName);

    function finish(tb, name) {
      const stats = { blocks: 0, groups: 0, byType: {}, limit };
      if (tb) {
        stats.groups = tb.groups.length;
        for (const g of tb.groups) for (const b of g.blocks) {
          stats.blocks++;
          stats.byType[b.type] = (stats.byType[b.type] || 0) + 1;
        }
        stats.left = limit ? limit - stats.blocks : null;
        if (limit && stats.blocks > limit)
          addIssue(AUTO ? 'warning' : 'error', 'Over the package limit', `This flow uses ${stats.blocks} components but the package allows ${limit}. Remove ${stats.blocks - limit} on the board, or pick a bigger package.`);
      }
      if (AUTO && tb) issues.forEach((i) => { if (i.severity === 'error' && i.title !== 'Internal check failed') i.severity = 'warning'; });
      const order = { error: 0, warning: 1 };
      issues.sort((a, b) => order[a.severity] - order[b.severity]);
      const safe = String(name || 'bot').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').slice(0, 60) || 'bot';
      return {
        typebot: tb,
        stats,
        autoFixes,
        issues,
        botName: name || '',
        fileName: 'typebot-' + safe + '.json',
        canExport: !!tb && !issues.some((i) => i.severity === 'error'),
      };
    }
  }

  // ───────────── internal test run: Typebot import rules ─────────────
  // Repairs anything technical so the file always imports cleanly.
  const DESIGN_PROBLEM = /^(Button without edge|Reply title|List row)/;
  function selfRepair(tb, addAuto) {
    const problems = validate(tb).filter((p) => !DESIGN_PROBLEM.test(p));
    if (!problems.length) return;
    const groupIds = new Set(tb.groups.map((g) => g.id));
    const blockIds = new Set(tb.groups.flatMap((g) => g.blocks.map((b) => b.id)));
    // drop edges that point to nothing
    tb.edges = tb.edges.filter((e) => groupIds.has(e.to.groupId) && (e.from.eventId || blockIds.has(e.from.blockId)));
    const edgeIds = new Set(tb.edges.map((e) => e.id));
    const referenced = new Set();
    const clean = (o) => {
      if (o.outgoingEdgeId && !edgeIds.has(o.outgoingEdgeId)) delete o.outgoingEdgeId;
      if (o.outgoingEdgeId) referenced.add(o.outgoingEdgeId);
    };
    tb.events.forEach(clean);
    tb.groups.forEach((g) => g.blocks.forEach((b) => { clean(b); (b.items || []).forEach(clean); }));
    tb.edges = tb.edges.filter((e) => referenced.has(e.id));
    addAuto(`Repaired ${problems.length} internal link problem${problems.length > 1 ? 's' : ''} found in the test run`);
  }

  function validate(tb) {
    const p = [];
    const ids = [tb.id, ...tb.events.map((e) => e.id), ...tb.groups.map((g) => g.id), ...tb.edges.map((e) => e.id), ...tb.variables.map((v) => v.id)];
    tb.groups.forEach((g) => g.blocks.forEach((b) => { ids.push(b.id); (b.items || []).forEach((i) => ids.push(i.id)); }));
    if (new Set(ids).size !== ids.length) p.push('Duplicate IDs');
    const groupIds = new Set(tb.groups.map((g) => g.id));
    const blockIds = new Set(tb.groups.flatMap((g) => g.blocks.map((b) => b.id)));
    for (const e of tb.edges) {
      if (!groupIds.has(e.to.groupId)) p.push('Edge to missing group ' + e.id);
      if (e.from.blockId && !blockIds.has(e.from.blockId)) p.push('Edge from missing block ' + e.id);
    }
    const refs = [];
    tb.events.forEach((e) => e.outgoingEdgeId && refs.push(e.outgoingEdgeId));
    tb.groups.forEach((g) => g.blocks.forEach((b) => { b.outgoingEdgeId && refs.push(b.outgoingEdgeId); (b.items || []).forEach((i) => i.outgoingEdgeId && refs.push(i.outgoingEdgeId)); }));
    const edgeSet = new Set(tb.edges.map((e) => e.id));
    const refSet = new Set(refs);
    if (refSet.size !== edgeSet.size || [...refSet].some((r) => !edgeSet.has(r))) p.push('Edge references do not match');
    // edges only leave from the last block of a group (or an item)
    tb.groups.forEach((g) => g.blocks.forEach((b, i) => { if (b.outgoingEdgeId && i !== g.blocks.length - 1) p.push('Edge from middle block ' + b.id); }));
    tb.groups.forEach((g) => g.blocks.forEach((b) => {
      if (b.type !== 'choice input') return;
      b.items.forEach((it) => { if (!it.outgoingEdgeId) p.push('Button without edge: ' + it.content); });
      const t = b.options.interactiveButtonType;
      b.items.forEach((it) => {
        if (t === 'reply' && charLen(it.content) > 20) p.push('Reply title > 20');
        if (t === 'list' && charLen(it.content) > 24) p.push('List row > 24');
      });
    }));
    if (!/^[a-z][a-z0-9]{23}$/.test(tb.id)) p.push('Bad id format');
    return p;
  }

  return { convert, validate, htmlToText };
});
