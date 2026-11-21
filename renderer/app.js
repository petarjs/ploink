import { h, capVars, colorFromIcon, colorFromName, monogram, ansiToHtml, ago, clock, dur, hostOf, CAP_COLORS, placeLeds } from './util.js';
import { sfx, configure as configureAudio, unlock as unlockAudio } from './audio.js';
import * as fx from './fx.js';
import { applyPack, capColor, capShape, packOutline, readoutStyle, logStyle, quip, scramble, glyphText, specimenSvg, specimenName, word, previewVars } from './look.js';

const api = window.ploink || (await import('./mock.js')).mockBridge;
const $ = (sel, root = document) => root.querySelector(sel);

const ACTIVE = new Set(['starting', 'running', 'awaiting_approval']);
const LEDS = 24;

const S = {
  projects: [],
  settings: {},
  latest: {},
  actions: {}, // projectId -> actionId -> latest run of that action key
  mcp: {},
  shortcut: {},
  appPath: '',
  bays: new Map(),
  holding: null,
  drawer: { open: false, projectId: null, runId: null, follow: true, lines: 0 },
  modal: null,
  recording: false,
  coloring: new Set(),
};

// ---------------------------------------------------------------- icons
const ICON = {
  dots: () => h('span', { html: '<svg width="14" height="14" viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="12.5" cy="8" r="1.4" fill="currentColor"/></svg>' }),
  log: () => h('span', { html: '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M3 4.5h10M3 8h10M3 11.5h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' }),
  plus: () => h('span', { html: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>' }),
  x: () => h('span', { html: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>' }),
};

// the same health check the main process suggests (main/detect.mjs)
const HEALTH_CMD = `curl -fsSL -o /dev/null --max-time 15 -w '%{http_code} · %{time_total}s' "$PLOINK_URL"`;
function trustChip(onTrust) {
  return h('span', { class: 'act-flags', style: { gridColumn: '1 / -1', margin: '0' } },
    h('span', { class: 'flag note' }, 'Added by an agent. It runs only after you review it.'),
    h('button', { class: 'flag trust', type: 'button', onclick: () => { sfx.click(); onTrust(); } }, 'Looks good, trust it'));
}

// ---------------------------------------------------------------- helpers
const activeCmd = (p) => p.commands.find((c) => c.id === p.activeCommandId) || p.commands[0] || null;
const prettyPath = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');
const rand = (a, b) => a + Math.random() * (b - a);

function prettyShortcut(acc) {
  if (!acc) return 'OFF';
  return acc
    .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/g, '⌘')
    .replace(/Control|Ctrl/g, '⌃')
    .replace(/Alt|Option/g, '⌥')
    .replace(/Shift/g, '⇧')
    .replace(/\+/g, '');
}

function restartClass(el, cls, ms) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  if (ms) {
    clearTimeout(el['_t_' + cls]);
    el['_t_' + cls] = setTimeout(() => el.classList.remove(cls), ms);
  }
}

function capCenter(bay) {
  const r = bay.refs.cap.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function toast(message, tone = 'info', ms = 3400) {
  const el = h('div', { class: `toast ${tone}` }, h('i'), h('span', {}, message));
  $('#toast-root').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}

// ---------------------------------------------------------------- look (shape, icon size)
function applyLook() {
  const shape = packOutline() || (S.settings.buttonShape === 'square' ? 'square' : 'round');
  document.body.classList.toggle('shape-square', shape === 'square');
  document.body.style.setProperty('--icon-scale', String(S.settings.iconScale ?? 0.5));
  for (const bay of S.bays.values()) placeLeds(bay.refs.leds, shape, 92);
}

// ---------------------------------------------------------------- deck
function renderDeck({ initial = false } = {}) {
  const deck = $('#deck');
  if (!S.projects.length) {
    for (const [, bay] of S.bays) bay.el.remove();
    S.bays.clear();
    deck.replaceChildren(heroEl());
    return;
  }
  $('.hero', deck)?.remove();

  // group by bank, in the order banks first appear
  const groups = new Map();
  for (const p of S.projects) {
    const key = p.bank || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const multi = groups.size > 1;
  const ordered = [...groups.values()].flat();
  S.order = ordered.map((p) => p.id);

  const seen = new Set();
  ordered.forEach((p, idx) => {
    let bay = S.bays.get(p.id);
    if (!bay) {
      bay = createBay(p);
      S.bays.set(p.id, bay);
      bay.el.style.setProperty('--delay', initial ? `${idx * 0.07}s` : '0s');
      bay.el.classList.add('mount');
      bay.el.addEventListener('animationend', (e) => { if (e.animationName === 'mount') bay.el.classList.remove('mount'); });
    }
    bay.project = p;
    bay.index = idx;
    updateBay(bay);
    seen.add(p.id);
  });
  for (const [id, bay] of S.bays) {
    if (seen.has(id)) continue;
    S.bays.delete(id);
    bay.el.classList.add('unmount');
    setTimeout(() => bay.el.remove(), 460);
  }
  const socket = $('.socket.add', deck) || socketEl();
  S.bankHeads = S.bankHeads || new Map();
  const want = [];
  for (const [name, list] of groups) {
    if (multi) {
      let head = S.bankHeads.get(name);
      if (!head) { head = h('div', { class: 'bank-head' }, h('span', { class: 'bank-name' }), h('span', { class: 'bank-count' })); S.bankHeads.set(name, head); }
      head.querySelector('.bank-name').textContent = `BANK · ${(name || 'Main').toUpperCase()}`;
      head.querySelector('.bank-count').textContent = `${list.length} ${list.length === 1 ? 'PROJECT' : 'PROJECTS'}`;
      want.push(head);
    }
    for (const p of list) want.push(S.bays.get(p.id).el);
  }
  for (const [name, head] of S.bankHeads) if (!multi || !groups.has(name)) { head.remove(); S.bankHeads.delete(name); }
  want.push(socket);
  const have = [...deck.children].filter((el) => !el.classList.contains('unmount'));
  if (want.length !== have.length || want.some((el, i) => el !== have[i])) {
    for (const el of want) deck.append(el);
  }
}

function heroEl() {
  return h('div', { class: 'hero' },
    h('button', { class: 'socket', onclick: addViaPicker, 'aria-label': 'Add your first project' },
      h('div', { class: 'socket-hole' }, ICON.plus()),
      h('div', { class: 'socket-title' }, 'INSTALL FIRST BAY')),
    h('h1', {}, 'Your launch deck is empty'),
    h('p', {}, 'Drop a project folder anywhere on this window, or click the socket. Ploink reads package.json, finds the deploy script and grabs the site icon.'),
    h('div', { class: 'agent-hint' }, 'or tell your agent: ', h('b', {}, '“add this repo to Ploink”')),
  );
}

function socketEl() {
  const holes = ['tl', 'tr', 'bl', 'br'].map((pos) => h('i', { class: 'screw-hole', style: { [pos[0] === 't' ? 'top' : 'bottom']: '10px', [pos[1] === 'l' ? 'left' : 'right']: '10px' } }));
  return h('button', { class: 'socket add', onclick: addViaPicker, 'aria-label': 'Add project' },
    holes,
    h('div', { class: 'socket-hole' }, ICON.plus()),
    h('div', { class: 'socket-title' }, 'ADD PROJECT'),
    h('div', { class: 'socket-sub' }, 'or drop a folder here'),
  );
}

function createBay(p) {
  const refs = {};
  const bay = { project: p, refs, el: null, index: 0, firedAt: 0 };
  refs.leds = Array.from({ length: LEDS }, (_, i) => h('i', { class: 'led', vars: { '--i': i } }));
  const el = h('article', { class: 'bay', 'data-id': p.id },
    ['tl', 'tr', 'bl', 'br'].map((pos) => h('i', { class: `screw ${pos}`, vars: { '--rot': `${Math.round(rand(0, 180))}deg` } })),
    h('div', { class: 'bay-top' },
      (refs.num = h('span', { class: 'bay-num' })),
      h('div', { class: 'bay-tools' },
        h('button', { class: 'bay-tool', title: 'Deploy log', onclick: () => openDrawer(bay.project.id) }, ICON.log()),
        h('button', { class: 'bay-tool', title: 'Edit bay', onclick: () => openEditor(bay.project) }, ICON.dots()),
      ),
    ),
    (refs.assembly = h('div', { class: 'assembly' },
      h('div', { class: 'ring' }, refs.leds, h('i', { class: 'needle' })),
      h('div', { class: 'bezel' }),
      (refs.cap = h('button', { class: 'cap' },
        h('span', { class: 'cap-shadow' }),
        h('span', { class: 'cap-side' }),
        (refs.face = h('span', { class: 'cap-face' })),
      )),
    )),
    (refs.name = h('div', { class: 'bay-name' })),
    (refs.url = h('div', { class: 'bay-url' })),
    (refs.selector = h('div', { class: 'selector' })),
    (refs.keys = h('div', { class: 'keys' })),
    (refs.lcd = h('button', { class: 'lcd', title: 'Open deploy log', onclick: () => openDrawer(bay.project.id, bay.lcdOverride?.runId) },
      h('div', { class: 'lcd-row' }, (refs.status = h('span', { class: 'lcd-status' })), (refs.side = h('span', { class: 'lcd-side' }))),
      (refs.ticker = h('div', { class: 'lcd-ticker' })),
    )),
    (refs.deny = h('button', { class: 'deny-btn', hidden: true, onclick: (e) => { e.stopPropagation(); denyRequest(bay); } }, 'DENY')),
  );
  bay.el = el;
  placeLeds(refs.leds, S.settings.buttonShape, 92);

  // press & hold
  const cap = refs.cap;
  cap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    unlockAudio();
    try { cap.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    beginHold(bay, 'pointer');
  });
  const release = () => { if (S.holding?.bay === bay && S.holding.via === 'pointer') endHold(); };
  cap.addEventListener('pointerup', release);
  cap.addEventListener('pointercancel', release);
  cap.addEventListener('lostpointercapture', release);
  cap.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); beginHold(bay, 'cap-key'); }
  });
  cap.addEventListener('keyup', (e) => { if ((e.key === ' ' || e.key === 'Enter') && S.holding?.via === 'cap-key') endHold(); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); openEditor(bay.project); });

  // 3D tilt + moving specular highlight
  el.addEventListener('pointerenter', () => el.classList.add('tilting'));
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty('--ry', `${(px * 7).toFixed(2)}deg`);
    el.style.setProperty('--rx', `${(-py * 6).toFixed(2)}deg`);
    el.style.setProperty('--gx', `${(50 + px * 70).toFixed(1)}%`);
    el.style.setProperty('--gy', `${(30 + py * 50).toFixed(1)}%`);
  });
  el.addEventListener('pointerleave', () => {
    el.classList.remove('tilting');
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--gx', '32%');
    el.style.setProperty('--gy', '24%');
  });
  return bay;
}

function updateBay(bay) {
  const p = bay.project;
  const { el, refs } = bay;
  const run = S.latest[p.id];
  const { vars, tone } = capVars(capColor(p, bay.index));
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  el.dataset.tone = tone;
  const solid = capShape(bay.index);
  if (solid && solid !== 'round' && solid !== 'square') el.dataset.shape = solid; else delete el.dataset.shape;
  refs.num.textContent = String(bay.index + 1).padStart(2, '0');
  el.style.setProperty('--i', bay.index);
  refs.cap.setAttribute('aria-label', `Deploy ${p.name}. Press and hold.`);

  const iconSig = (p.icon || '').slice(-64) + '|' + p.name;
  if (refs.face.dataset.sig !== iconSig) {
    refs.face.dataset.sig = iconSig;
    refs.face.replaceChildren(medalEl(p));
  }
  refs.name.textContent = p.name;
  refs.name.title = p.cwd;
  if (p.url) {
    refs.url.replaceChildren(h('a', { onclick: (e) => { e.stopPropagation(); api.openUrl(/^https?:/.test(p.url) ? p.url : 'https://' + p.url); }, title: p.url }, hostOf(p.url) + ' ↗'));
  } else {
    refs.url.textContent = prettyPath(p.cwd);
  }
  updateSelector(bay);
  updateKeys(bay);

  const status = run?.status;
  el.classList.toggle('is-running', status === 'running' || status === 'starting');
  el.classList.toggle('is-awaiting', status === 'awaiting_approval');
  el.classList.toggle('no-command', !p.commands.length);
  el.classList.toggle('last-ok', status === 'success');
  el.classList.toggle('last-bad', status === 'failed');
  refs.deny.hidden = status !== 'awaiting_approval';
  updateLcd(bay);
}

function medalEl(p) {
  const medal = h('span', { class: 'cap-medal' });
  const mono = () => h('span', { class: 'mono' }, monogram(p.name));
  if (p.icon) {
    const img = h('img', { src: p.icon, alt: '', draggable: false });
    img.addEventListener('error', () => medal.replaceChildren(mono()));
    medal.append(img);
  } else medal.append(mono());
  return medal;
}

function updateSelector(bay) {
  const p = bay.project;
  const sel = bay.refs.selector;
  const structure = p.commands.map((c) => `${c.id}:${c.label}:${c.cmd}`).join('|');
  if (sel.dataset.sig !== structure) {
    sel.dataset.sig = structure;
    if (p.commands.length <= 1) {
      const c = p.commands[0];
      sel.className = 'selector single';
      sel.replaceChildren(h('span', { class: 'sel-opt', title: c ? c.cmd : '' }, c ? `$ ${c.cmd}` : 'no deploy command'));
    } else {
      sel.className = 'selector';
      sel.replaceChildren(
        h('span', { class: 'selector-thumb' }),
        ...p.commands.slice(0, 4).map((c) => h('button', { class: 'sel-opt', title: c.cmd, 'data-cmd': c.id, onclick: () => selectCommand(bay, c.id) }, c.label)),
      );
    }
  }
  if (p.commands.length > 1) {
    const shown = p.commands.slice(0, 4);
    const idx = Math.max(0, shown.findIndex((c) => c.id === p.activeCommandId));
    sel.style.setProperty('--n', shown.length);
    sel.style.setProperty('--idx', idx);
    for (const b of sel.querySelectorAll('.sel-opt')) b.classList.toggle('active', b.dataset.cmd === shown[idx].id);
  }
}

function selectCommand(bay, commandId) {
  const p = bay.project;
  if (p.activeCommandId === commandId) return;
  if (ACTIVE.has(S.latest[p.id]?.status)) { toast('Wait for the current deploy to finish first.', 'warn'); return; }
  sfx.click();
  p.activeCommandId = commandId;
  updateSelector(bay);
  updateLcd(bay);
  api.saveProject({ id: p.id, activeCommandId: commandId });
}

// ---------------------------------------------------------------- action keys
const portOf = (url) => { const m = String(url || '').match(/:(\d{2,5})(?:\/|$)/); return m ? `:${m[1]}` : 'on'; };
const actionRun = (projectId, actionId) => S.actions[projectId]?.[actionId] || null;

function keyLook(a, run) {
  const st = run?.status;
  const cls = ['key', `kind-${a.kind}`];
  let val = '';
  if (a.hold) cls.push('needs-hold');
  if (a.trusted === false) { cls.push('untrusted'); return { cls, val: 'review' }; }
  if (st === 'awaiting_approval') { cls.push('is-awaiting'); val = 'agent'; }
  else if (run && ACTIVE.has(st)) {
    if (a.kind === 'service') { cls.push('is-on'); val = run.url ? portOf(run.url) : 'on'; }
    else { cls.push('is-live'); val = '…'; }
  } else if (st === 'success') {
    // an old result is still shown, but without the green lamp
    if (Date.now() - (run.endedAt || 0) < 60 * 60e3) cls.push('tone-ok');
    val = a.kind === 'check' ? run.value || 'ok' : '✓';
  } else if (st === 'failed') {
    cls.push('tone-bad');
    val = a.kind === 'service' ? 'crashed' : a.kind === 'check' && run.value ? run.value : '✕';
  } else if (st === 'cancelled') val = '–';
  return { cls, val };
}

function keyTitle(a, run) {
  const how = a.trusted === false ? 'Added by an agent: click to review'
    : run?.status === 'awaiting_approval' ? 'An agent wants to press this: hold to approve'
      : run && ACTIVE.has(run.status) ? (a.kind === 'service' ? 'Running: click to stop' : 'Running: click for the live log')
        : a.hold ? 'Hold to run' : a.kind === 'service' ? 'Click to start' : 'Click to run';
  const last = run?.endedAt ? ` · last ${ago(run.endedAt)}` : '';
  return `${a.label}: ${a.cmd}\n${how}${last}${a.agents ? ' · agents may press' : ''}`;
}

function updateKeys(bay) {
  const p = bay.project;
  const box = bay.refs.keys;
  const actions = p.actions || [];
  const sig = actions.map((a) => `${a.id}:${a.label}:${a.kind}`).join('|');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    bay.keys = new Map();
    box.replaceChildren(...actions.map((a) => {
      const key = h('button', { class: 'key', 'data-id': a.id },
        h('i', { class: 'key-lamp' }), h('span', { class: 'key-label' }, a.label), h('span', { class: 'key-val' }));
      bindKey(bay, key);
      bay.keys.set(a.id, key);
      return key;
    }));
  }
  for (const a of actions) {
    const key = bay.keys.get(a.id);
    if (!key) continue;
    key._action = a;
    const run = actionRun(p.id, a.id);
    const { cls, val } = keyLook(a, run);
    const keep = ['is-holding', 'just-done'].filter((c) => key.classList.contains(c));
    const next = [...cls, ...keep].join(' ');
    if (key.className !== next) key.className = next;
    const v = key.querySelector('.key-val');
    if (v.textContent !== val) v.textContent = val;
    key.title = keyTitle(a, run);
  }
}

function bindKey(bay, key) {
  key.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    unlockAudio();
    const a = key._action;
    const run = actionRun(bay.project.id, a.id);
    const busy = run && ACTIVE.has(run.status) && run.status !== 'awaiting_approval';
    key._needsHold = !busy && a.trusted !== false && (a.hold || run?.status === 'awaiting_approval');
    if (!key._needsHold) return;
    e.preventDefault();
    try { key.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const ms = Math.max(400, Number(S.settings.holdMs ?? 650)) * (a.hold ? 1.5 : 1);
    sfx.press();
    key.classList.add('is-holding');
    const start = performance.now();
    const hold = { fired: false, raf: 0, timer: 0 };
    const step = () => {
      if (key._hold !== hold) return;
      key.style.setProperty('--hold', Math.min(1, (performance.now() - start) / ms).toFixed(3));
      hold.raf = requestAnimationFrame(step);
    };
    hold.raf = requestAnimationFrame(step);
    hold.timer = setTimeout(() => { hold.fired = true; endKeyHold(key); pressKey(bay, a, { held: true }); }, ms);
    key._hold = hold;
  });
  const release = () => {
    const hold = key._hold;
    if (!hold) return;
    endKeyHold(key);
    if (!hold.fired) {
      sfx.release();
      flashLcd(bay, { tone: 'warn', status: 'HOLD TO RUN', side: '', ticker: `keep holding ${key._action.label}` });
    }
  };
  key.addEventListener('pointerup', release);
  key.addEventListener('pointercancel', release);
  key.addEventListener('lostpointercapture', release);
  key.addEventListener('click', (e) => {
    e.stopPropagation();
    if (key._needsHold) { key._needsHold = false; return; }
    pressKey(bay, key._action);
  });
}

function endKeyHold(key) {
  const hold = key._hold;
  if (!hold) return;
  key._hold = null;
  cancelAnimationFrame(hold.raf);
  clearTimeout(hold.timer);
  key.classList.remove('is-holding');
  key.style.setProperty('--hold', 0);
}

async function pressKey(bay, a, { held = false } = {}) {
  const p = bay.project;
  const run = actionRun(p.id, a.id);
  if (a.trusted === false) { openReview(p, a, { actionId: a.id }); return; }
  if (run?.status === 'awaiting_approval') {
    if (!held) return;
    const ok = await api.approve(run.id);
    if (!ok) toast('That request is no longer waiting.', 'warn');
    else sfx.launch();
    return;
  }
  if (run && ACTIVE.has(run.status)) {
    if (a.kind === 'service') { sfx.release(); await api.cancel(run.id); return; }
    openDrawer(p.id, run.id);
    return;
  }
  if (a.hold && !held) {
    flashLcd(bay, { tone: 'warn', status: 'HOLD TO RUN', side: '', ticker: `${a.label} needs a long press` });
    return;
  }
  sfx.press();
  const res = await api.runAction({ projectId: p.id, actionId: a.id });
  if (res?.review) { openReview(p, a, { actionId: a.id }); return; }
  if (res?.error) { toast(res.error, 'bad', 5000); sfx.fail(); return; }
  if (res?.run) onRun(res.run);
}

function lcdForAction(a, run) {
  const L = a.label.toUpperCase();
  const since = run.endedAt ? ago(run.endedAt).toUpperCase() : '';
  const exit = `EXIT ${run.exitCode ?? '?'}`;
  switch (run.status) {
    case 'awaiting_approval':
      return { tone: 'warn', status: `${L} · AGENT REQUEST`, side: 'HOLD KEY', ticker: run.reason ? `“${run.reason}”` : `an agent wants to press ${a.label}` };
    case 'starting':
    case 'running':
      if (a.kind === 'service') return { tone: 'ok', status: `${L} RUNNING`, side: run.url ? portOf(run.url) : clock(Date.now() - (run.startedAt || Date.now())), ticker: run.url || run.lastLine || run.cmd };
      return { tone: '', status: `${L} …`, side: clock(Date.now() - (run.startedAt || Date.now())), ticker: run.lastLine || run.cmd };
    case 'success':
      if (a.kind === 'check') return { tone: 'ok', status: `${L} ${String(run.value || 'OK').toUpperCase()}`, side: since, ticker: a.cmd };
      return { tone: 'ok', status: `${L} DONE`, side: run.startedAt ? dur(run.endedAt - run.startedAt).toUpperCase() : since, ticker: run.lastLine || a.cmd };
    case 'failed':
      if (a.kind === 'service') return { tone: 'bad', status: `${L} CRASHED · ${exit}`, side: since, ticker: run.lastLine || 'open the log ›' };
      if (a.kind === 'check') return { tone: 'bad', status: `${L} FAIL${run.value ? ' · ' + String(run.value).toUpperCase() : ''}`, side: exit, ticker: run.lastLine || a.cmd };
      return { tone: 'bad', status: `${L} FAILED · ${exit}`, side: since, ticker: run.lastLine || 'open the log ›' };
    case 'stopped': return { tone: '', status: `${L} STOPPED`, side: since, ticker: 'click the key to start it again' };
    case 'cancelled': return { tone: 'warn', status: `${L} CANCELLED`, side: since, ticker: a.cmd };
    case 'denied': return { tone: '', status: L, side: 'DENIED', ticker: a.cmd };
    case 'expired': return { tone: '', status: L, side: 'REQ EXPIRED', ticker: a.cmd };
    default: return null;
  }
}

// An action key borrows the bay's readout for a moment; a running deploy keeps it.
function borrowLcd(bay, a, run) {
  if (ACTIVE.has(S.latest[bay.project.id]?.status)) return;
  const live = ACTIVE.has(run.status) && a.kind !== 'service';
  const ms = live ? 10 * 60e3 : a.kind === 'service' && ACTIVE.has(run.status) ? 5000 : 12000;
  bay.lcdOverride = { actionId: a.id, runId: run.id, until: Date.now() + ms };
  updateLcd(bay);
  restartClass(bay.refs.lcd, 'flash');
  clearTimeout(bay._lcdT);
  bay._lcdT = setTimeout(() => { bay.lcdOverride = null; updateLcd(bay); }, ms);
}

function onActionRun(run) {
  const prev = actionRun(run.projectId, run.actionId);
  if (prev && prev.id !== run.id && prev.createdAt > run.createdAt) return; // stale
  const prevStatus = prev && prev.id === run.id ? prev.status : null;
  const merged = { ...(prev && prev.id === run.id ? prev : {}), ...run };
  (S.actions[run.projectId] ||= {})[run.actionId] = merged;
  const bay = S.bays.get(run.projectId);
  const a = bay?.project.actions?.find((x) => x.id === run.actionId);
  if (bay && a) {
    updateKeys(bay);
    if (run.status !== prevStatus || (a.kind === 'service' && run.url && !prev?.url)) {
      borrowLcd(bay, a, merged);
      const key = bay.keys?.get(a.id);
      const audible = run.voice !== 'bar';
      if (run.status === 'awaiting_approval' && audible) { sfx.request(); toast(`An agent wants to press ${a.label} on ${bay.project.name}. Hold the key to approve.`, 'warn', 6000); }
      if (TERMINAL_UI.has(run.status) && prevStatus && key) restartClass(key, 'just-done', 500);
      if (audible && prevStatus && prevStatus !== run.status) {
        if (run.status === 'success') { sfx.tick(18, 24); setTimeout(() => sfx.tick(22, 24), 90); }
        else if (run.status === 'failed') sfx.fail();
        else if (run.status === 'running' && a.kind === 'service') sfx.thunk();
      }
      if (run.status === 'running' && run.source === 'agent' && !prevStatus && audible) sfx.press();
    }
  }
  if (S.drawer.open && S.drawer.projectId === run.projectId) {
    if (S.drawer.runId === run.id) renderDrawerHead();
  }
}
const TERMINAL_UI = new Set(['success', 'failed', 'cancelled', 'denied', 'expired', 'stopped']);

// ---------------------------------------------------------------- review (commands an agent added)
function openReview(project, button, { commandId, actionId }, after) {
  openModal((sheet) => {
    const go = async () => {
      await api.trust({ projectId: project.id, commandId, actionId });
      closeModal();
      toast(`${button.label} is trusted now.`, 'ok');
      after?.();
    };
    sheet.append(
      h('div', { class: 'sheet-head' }, h('h2', {}, 'Review command'), h('div', { class: 'grow' }), h('button', { class: 'keycap small', onclick: () => closeModal(), title: 'Close' }, ICON.x())),
      h('div', { class: 'sheet-body' },
        h('p', { class: 'field-hint' }, `An agent added “${button.label}” to ${project.name}. Ploink will not run it until you check it. It runs in your login shell, in ${prettyPath(project.cwd)}:`),
        h('div', { class: 'review-cmd' }, button.cmd),
        h('p', { class: 'field-hint' }, 'If it calls a script (for example npm run deploy), that script can change later. Only trust folders you know.'),
      ),
      h('div', { class: 'sheet-foot' },
        h('button', { class: 'keycap', onclick: () => { closeModal(); openEditor(project); } }, 'Edit bay…'),
        h('div', { class: 'grow' }),
        h('button', { class: 'keycap', onclick: () => closeModal() }, 'Not now'),
        h('button', { class: 'keycap primary', onclick: go, autofocus: true }, after ? 'Trust and run' : 'Trust'),
      ),
    );
  });
}

function lcdFor(p, run) {
  const cmd = activeCmd(p);
  if (!cmd) return { tone: 'off', status: 'NO COMMAND', side: '', ticker: 'right-click to set one up' };
  const base = `${cmd.label} · ${cmd.cmd}`;
  if (!run) return { tone: '', status: 'READY', side: '—', ticker: base };
  const agent = run.source === 'agent';
  const badge = agent ? 'AGENT' : run.source === 'tray' ? 'MENU' : null;
  const since = run.endedAt ? ago(run.endedAt).toUpperCase() : '';
  switch (run.status) {
    case 'awaiting_approval':
      return { tone: 'warn', status: 'AGENT REQUEST', side: 'HOLD TO OK', ticker: run.reason ? `“${run.reason}”` : `wants to run ${run.commandLabel}`, badge: 'AGENT' };
    case 'starting':
      return { tone: '', status: 'IGNITION', side: '00:00', ticker: run.cmd, badge };
    case 'running':
      if (run.phase === 'verify') return { tone: '', status: 'CHECKING SITE', live: true, side: clock(Date.now() - run.startedAt), ticker: run.lastLine || 'waiting for the site to answer', badge };
      return { tone: '', status: 'IN FLIGHT', live: true, side: clock(Date.now() - run.startedAt), ticker: run.lastLine || run.cmd, badge };
    case 'success': {
      const fresh = Date.now() - run.endedAt < 15 * 60e3;
      const site = run.verify?.ok ? ` · site ${run.verify.value}` : '';
      if (fresh) return { tone: 'ok', status: 'SHIPPED', side: dur(run.endedAt - run.startedAt).toUpperCase(), ticker: `${ago(run.endedAt)} · ${run.commandLabel}${site}${agent ? ' · by agent' : ''}` };
      return { tone: '', status: 'READY', side: `✓ ${since}`, ticker: base };
    }
    case 'failed':
      if (run.verify && !run.verify.ok) return { tone: 'bad', status: 'SITE CHECK FAILED', side: since, ticker: `deployed, but ${run.verify.label} ${run.verify.value ? `got ${run.verify.value}` : 'got no answer'}` };
      return { tone: 'bad', status: `FAILED · EXIT ${run.exitCode ?? '?'}`, side: since, ticker: run.lastLine || 'open the log ›' };
    case 'cancelled':
      return { tone: 'warn', status: 'ABORTED', side: since, ticker: base };
    case 'denied':
      return { tone: '', status: 'READY', side: 'DENIED', ticker: base };
    case 'expired':
      return { tone: '', status: 'READY', side: 'REQ EXPIRED', ticker: base };
    default:
      return { tone: '', status: 'READY', side: '', ticker: base };
  }
}

function updateLcd(bay) {
  const { refs } = bay;
  // a deploy always wins the readout back from an action key
  if (bay.lcdOverride?.actionId && ACTIVE.has(S.latest[bay.project.id]?.status)) bay.lcdOverride = null;
  if (bay.lcdOverride && Date.now() < bay.lcdOverride.until) {
    let o = bay.lcdOverride;
    if (o.actionId) {
      const a = bay.project.actions?.find((x) => x.id === o.actionId);
      const r = actionRun(bay.project.id, o.actionId);
      const d = a && r && r.id === o.runId ? lcdForAction(a, r) : null;
      if (!d) { bay.lcdOverride = null; return updateLcd(bay); }
      o = { ...o, ...d };
    }
    refs.lcd.className = `lcd ${o.tone ? 'tone-' + o.tone : ''}`;
    const glyph = readoutStyle() === 'glyph';
    refs.status.replaceChildren(glyph ? glyphText(word(o.status)) : word(o.status));
    refs.status.dataset.s = '';
    refs.side.textContent = o.side || '';
    refs.ticker.replaceChildren(glyph && o.ticker ? glyphText(o.ticker) : o.ticker || '');
    refs.ticker.dataset.k = '';
    return;
  }
  const d = lcdFor(bay.project, S.latest[bay.project.id]);
  d.status = word(d.status);
  const cls = `lcd ${d.tone ? 'tone-' + d.tone : ''}`;
  if (refs.lcd.className !== cls) refs.lcd.className = cls;
  const glyph = readoutStyle() === 'glyph';
  if (refs.status.dataset.s !== d.status + !!d.live) {
    refs.status.dataset.s = d.status + !!d.live;
    refs.status.replaceChildren(glyph ? glyphText(d.status) : d.status, ...(d.live ? [h('i', { class: 'dot' })] : []));
    if (readoutStyle() === 'terminal') restartClass(refs.status, 'typed');
  }
  if (refs.side.textContent !== d.side) refs.side.textContent = d.side;
  const tickerKey = (d.badge || '') + d.ticker;
  if (refs.ticker.dataset.k !== tickerKey) {
    refs.ticker.dataset.k = tickerKey;
    refs.ticker.replaceChildren(...(d.badge ? [h('span', { class: 'lcd-badge' }, d.badge)] : []), glyph ? glyphText(d.ticker) : d.ticker);
  }
}

function flashLcd(bay, o, ms = 1400) {
  bay.lcdOverride = { ...o, until: Date.now() + ms };
  updateLcd(bay);
  restartClass(bay.refs.lcd, 'flash');
  clearTimeout(bay._lcdT);
  bay._lcdT = setTimeout(() => { bay.lcdOverride = null; updateLcd(bay); }, ms);
}

// ---------------------------------------------------------------- hold to launch
function beginHold(bay, via) {
  if (!bay || S.holding) return;
  const p = bay.project;
  const run = S.latest[p.id];
  const awaiting = run?.status === 'awaiting_approval';
  if (run && ACTIVE.has(run.status) && !awaiting) { openDrawer(p.id, run.id); return; }
  if (!p.commands.length) { openEditor(p); return; }

  sfx.press();
  bay.el.classList.add('is-holding');
  const holdMs = Math.max(0, Number(S.settings.holdMs ?? 650));
  const state = { bay, via, start: performance.now(), lit: 0, fired: false, raf: 0, awaitingRunId: awaiting ? run.id : null, quip: quip('hold') };
  if (state.quip) { bay.refs.ticker.textContent = state.quip; bay.refs.ticker.dataset.k = ''; }
  S.holding = state;
  if (holdMs < 40) { fire(state); return; }
  // a timer owns the deadline so a throttled frame loop can never stall a launch
  state.timer = setTimeout(() => { if (S.holding === state && !state.fired) fire(state); }, holdMs);
  const step = () => {
    if (S.holding !== state || state.fired) return;
    const t = Math.min(1, (performance.now() - state.start) / holdMs);
    const target = Math.min(LEDS, Math.floor(t * LEDS));
    while (state.lit < target) {
      bay.refs.leds[state.lit].classList.add('charge');
      sfx.tick(state.lit, LEDS);
      state.lit++;
    }
    bay.el.style.setProperty('--hold', t.toFixed(3));
    bay.el.classList.toggle('redline', t > 0.82);
    // the terminal readout brute-forces the project name while you hold
    if (readoutStyle() === 'terminal') { bay.refs.status.textContent = scramble(p.name, t * 1.15); bay.refs.status.dataset.s = ''; }
    state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
}

function endHold() {
  const state = S.holding;
  if (!state) return;
  S.holding = null;
  cancelAnimationFrame(state.raf);
  clearTimeout(state.timer);
  const { bay } = state;
  bay.el.classList.remove('is-holding', 'redline');
  bay.el.style.setProperty('--hold', 0);
  if (state.quip || readoutStyle() === 'terminal') { bay.refs.status.dataset.s = ''; bay.refs.ticker.dataset.k = ''; updateLcd(bay); }
  if (!state.fired) {
    sfx.release();
    drainLeds(bay);
    if (performance.now() - state.start < 260) {
      flashLcd(bay, { tone: 'warn', status: 'HOLD TO LAUNCH', side: '', ticker: 'press and keep holding the button' });
    }
  }
}

function drainLeds(bay) {
  const lit = bay.refs.leds.filter((l) => l.classList.contains('charge'));
  lit.reverse().forEach((led, i) => setTimeout(() => led.classList.remove('charge'), i * 14));
}

function clearCharge(bay) {
  for (const led of bay.refs.leds) led.classList.remove('charge');
}

async function fire(state) {
  if (state.fired) return;
  state.fired = true;
  cancelAnimationFrame(state.raf);
  clearTimeout(state.timer);
  const { bay } = state;
  const p = bay.project;
  for (const led of bay.refs.leds) led.classList.add('charge');
  launchFx(bay);
  bay.firedAt = Date.now();
  setTimeout(() => clearCharge(bay), 350);
  if (state.awaitingRunId) {
    const ok = await api.approve(state.awaitingRunId);
    if (!ok) toast('That request is no longer waiting.', 'warn');
    return;
  }
  const cmd = activeCmd(p);
  if (cmd?.trusted === false) {
    drainLeds(bay);
    openReview(p, cmd, { commandId: cmd.id });
    return;
  }
  const res = await api.deploy({ projectId: p.id, commandId: p.activeCommandId });
  if (res?.review) { openReview(p, cmd, { commandId: cmd.id }); return; }
  if (res?.error) {
    toast(res.error, 'bad', 5000);
    restartClass(bay.el, 'just-failed', 1800);
    sfx.fail();
  } else if (res?.run) {
    onRun(res.run);
  }
}

function launchFx(bay, audible = true) {
  bay.firedAt = Date.now();
  const { x, y } = capCenter(bay);
  restartClass(bay.el, 'launch', 650);
  bay.el.classList.remove('redline');
  fx.celebrate('launch', x, y, capColor(bay.project, bay.index), { text: activeCmd(bay.project)?.cmd });
  if (audible) sfx.launch();
  quipOn(bay, 'launch');
}

// a pack quip in the bay's ticker for a few seconds
function quipOn(bay, on) {
  const q = quip(on);
  if (!q) return;
  const d = lcdFor(bay.project, S.latest[bay.project.id]);
  setTimeout(() => flashLcd(bay, { ...d, ticker: q }, 7000), on === 'launch' ? 400 : 120);
}

function ghostPress(bay, audible = true) {
  if (Date.now() - bay.firedAt < 2000) return;
  bay.firedAt = Date.now();
  if (audible) sfx.press();
  bay.el.classList.add('is-holding');
  bay.refs.leds.forEach((led, i) => setTimeout(() => { led.classList.add('charge'); if (audible) sfx.tick(i, LEDS); }, i * 15));
  setTimeout(() => {
    bay.el.classList.remove('is-holding');
    launchFx(bay, audible);
    setTimeout(() => clearCharge(bay), 350);
  }, LEDS * 15 + 80);
}

async function denyRequest(bay) {
  const run = S.latest[bay.project.id];
  if (run?.status !== 'awaiting_approval') return;
  await api.deny(run.id);
  sfx.denied();
}

// ---------------------------------------------------------------- runs & transitions
function onRun(run) {
  if (!run) return;
  if (run.actionId) return onActionRun(run);
  const prev = S.latest[run.projectId];
  if (prev && prev.id !== run.id && prev.createdAt > run.createdAt) return; // stale
  const prevStatus = prev && prev.id === run.id ? prev.status : null;
  S.latest[run.projectId] = { ...(prev && prev.id === run.id ? prev : {}), ...run };
  const bay = S.bays.get(run.projectId);
  if (bay && run.status !== prevStatus) transition(bay, prevStatus, run);
  if (bay) updateBay(bay);
  if (S.drawer.open && S.drawer.projectId === run.projectId) {
    if (run.id !== S.drawer.runId && ACTIVE.has(run.status) && !prevStatus) openDrawer(run.projectId, run.id);
    else renderDrawerHead();
  }
  updateLamps();
}

function transition(bay, prevStatus, run) {
  const s = run.status;
  const audible = run.voice !== 'bar'; // the launch bar speaks when the console is in the background
  if (s === 'awaiting_approval') {
    if (audible) sfx.request();
    if (audible) toast(`An agent wants to deploy ${bay.project.name}. Hold its button to approve.`, 'warn', 6000);
    bay.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else if ((s === 'starting' || s === 'running') && (!prevStatus || prevStatus === 'awaiting_approval')) {
    if (run.source !== 'user') ghostPress(bay, audible);
  } else if (s === 'success' && prevStatus) {
    restartClass(bay.el, 'just-success', 5200);
    const { x, y } = capCenter(bay);
    fx.celebrate('success', x, y, capColor(bay.project, bay.index), { text: run.cmd });
    if (audible) sfx.success();
    quipOn(bay, 'success');
  } else if (s === 'failed' && prevStatus) {
    restartClass(bay.el, 'just-failed', 2200);
    const { x, y } = capCenter(bay);
    fx.celebrate('fail', x, y, null, { text: run.cmd, label: `${bay.project.name} could not be deployed. The command stopped with exit code ${run.exitCode ?? '?'}.` });
    if (audible) sfx.fail();
    quipOn(bay, 'fail');
  } else if ((s === 'denied' || s === 'expired') && prevStatus) {
    if (audible) sfx.denied();
  }
}

function onLog({ runId, projectId, actionId, lines, lastLine }) {
  if (actionId) {
    const r = actionRun(projectId, actionId);
    if (r && r.id === runId) {
      r.lastLine = lastLine;
      const bay = S.bays.get(projectId);
      if (bay?.lcdOverride?.runId === runId) updateLcd(bay);
    }
    if (S.drawer.open && S.drawer.runId === runId) appendLog(lines);
    return;
  }
  const run = S.latest[projectId];
  if (run && run.id === runId) {
    run.lastLine = lastLine;
    const bay = S.bays.get(projectId);
    if (bay) updateLcd(bay);
  }
  if (S.drawer.open && S.drawer.runId === runId) appendLog(lines);
}

function updateLamps() {
  const runs = Object.values(S.latest).filter(Boolean);
  const running = runs.filter((r) => r.status === 'running' || r.status === 'starting').length;
  const waiting = runs.filter((r) => r.status === 'awaiting_approval').length;
  const lamp = $('#lamp-active');
  lamp.classList.toggle('busy', running > 0 || waiting > 0);
  $('#lamp-active-label').textContent = running ? `${running} DEPLOYING` : waiting ? `${waiting} WAITING` : word('IDLE');

  const agent = $('#lamp-agent');
  agent.classList.toggle('on', !!S.mcp.running);
  agent.classList.toggle('err', !!S.mcp.error);
  agent.title = S.mcp.running ? `Agents connect to ${S.mcp.url}` : S.mcp.error || 'MCP server is off';
  const strip = $('#strip-mcp');
  strip.textContent = S.mcp.running ? `MCP ● 127.0.0.1:${S.mcp.port}` : S.mcp.error ? `MCP ✕ ${S.mcp.error}` : 'MCP OFF';
  strip.classList.toggle('on', !!S.mcp.running);
  $('#strip-shortcut').textContent = prettyShortcut(S.settings.shortcut);
  const snd = $('#sound-toggle');
  snd.setAttribute('aria-checked', String(!!S.settings.sound));
}

// ---------------------------------------------------------------- colours
async function ensureColors() {
  for (const p of S.projects) {
    if (p.color || S.coloring.has(p.id)) continue;
    S.coloring.add(p.id);
    const color = (p.icon && (await colorFromIcon(p.icon))) || colorFromName(p.name);
    p.color = color;
    const bay = S.bays.get(p.id);
    if (bay) updateBay(bay);
    api.saveProject({ id: p.id, color }).finally(() => S.coloring.delete(p.id));
  }
}

// ---------------------------------------------------------------- adding projects
async function addViaPicker() {
  unlockAudio();
  sfx.click();
  const dir = await api.pickFolder();
  if (!dir) return;
  const found = await api.detectProject(dir);
  if (found.error) { toast(found.error, 'bad'); return; }
  if (S.projects.some((p) => p.cwd === dir)) { toast('That folder already has a bay.', 'warn'); return; }
  openEditor({ id: null, name: found.name, cwd: found.cwd, url: found.url || '', icon: found.icon || null, color: null, commands: found.commands, actions: found.actions || [], requireApproval: false, _hints: found.hints, _new: true });
}

async function addFromDrop(paths) {
  for (const dir of paths) {
    if (S.projects.some((p) => p.cwd === dir)) { toast(`${dir.split('/').pop()} already has a bay.`, 'warn'); continue; }
    const found = await api.detectProject(dir);
    if (found.error) { toast(found.error, 'bad'); continue; }
    if (!found.commands.length || paths.length === 1) {
      // single drop: confirm in the editor; it is quick and catches wrong guesses
      openEditor({ id: null, name: found.name, cwd: found.cwd, url: found.url || '', icon: found.icon || null, color: null, commands: found.commands, actions: found.actions || [], requireApproval: false, _hints: found.hints, _new: true });
      return;
    }
    const res = await api.addProjectPath(dir);
    if (res.error) toast(res.error, 'bad');
  }
}

function celebrateInstall(id) {
  const bay = S.bays.get(id);
  sfx.install();
  if (!bay) return;
  setTimeout(() => bay.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
  flashLcd(bay, { tone: 'ok', status: 'INSTALLED', side: '', ticker: 'hold the button to launch' }, 2600);
}

// ---------------------------------------------------------------- drawer (logs)
const D = {};
function buildDrawer() {
  const el = $('#drawer');
  el.replaceChildren(
    h('div', { class: 'drawer-grip' }),
    h('div', { class: 'drawer-head' },
      (D.icon = h('div', { class: 'drawer-icon' })),
      h('div', { class: 'drawer-title' }, (D.title = h('h2')), (D.sub = h('div'))),
      (D.actions = h('div', { class: 'drawer-actions' })),
    ),
    (D.runs = h('div', { class: 'runs' })),
    h('div', { class: 'terminal' },
      (D.pre = h('pre')),
      (D.followBtn = h('button', { class: 'keycap follow-btn', hidden: true, onclick: () => { S.drawer.follow = true; D.pre.scrollTop = D.pre.scrollHeight; D.followBtn.hidden = true; } }, '↓ Follow output')),
    ),
  );
  D.pre.addEventListener('scroll', () => {
    const atBottom = D.pre.scrollHeight - D.pre.scrollTop - D.pre.clientHeight < 40;
    S.drawer.follow = atBottom;
    D.followBtn.hidden = atBottom;
  });
}

async function openDrawer(projectId, runId) {
  const p = S.projects.find((x) => x.id === projectId);
  if (!p) return;
  const history = await api.getHistory(projectId);
  const chosen = runId || S.latest[projectId]?.id || history[0]?.id || null;
  S.drawer = { open: true, projectId, runId: chosen, follow: true, lines: 0, history };
  const el = $('#drawer');
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  renderDrawerHead();
  renderRunChips();
  await loadRunLog(chosen);
}

function closeDrawer() {
  S.drawer.open = false;
  const el = $('#drawer');
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

function renderDrawerHead() {
  const p = S.projects.find((x) => x.id === S.drawer.projectId);
  if (!p) return closeDrawer();
  const liveAction = Object.values(S.actions[p.id] || {}).find((r) => r.id === S.drawer.runId);
  const run = S.drawer.runId === S.latest[p.id]?.id ? S.latest[p.id] : liveAction || (S.drawer.history || []).find((r) => r.id === S.drawer.runId);
  const { vars } = capVars(capColor(p, Math.max(0, (S.order || []).indexOf(p.id))));
  for (const [k, v] of Object.entries(vars)) D.icon.style.setProperty(k, v);
  D.icon.replaceChildren(p.icon ? h('img', { src: p.icon, alt: '' }) : h('b', {}, monogram(p.name)));
  D.title.textContent = p.name;
  const isAction = !!run?.actionId;
  const statusText = run ? { awaiting_approval: 'waiting for approval', starting: 'starting', running: isAction ? 'running' : run.phase === 'verify' ? 'checking the site' : 'deploying', success: isAction ? (run.value ? `ok · ${run.value}` : 'done') : 'shipped', failed: `failed (exit ${run.exitCode})`, cancelled: 'cancelled', denied: 'denied', expired: 'expired', stopped: 'stopped' }[run.status] : null;
  D.sub.textContent = run
    ? `${run.commandLabel} · ${statusText}${run.startedAt ? ' · ' + (run.endedAt ? dur(run.endedAt - run.startedAt) : clock(Date.now() - run.startedAt)) : ''}${run.source === 'agent' ? ` · started by ${run.client || 'agent'}` : ''}${run.reason ? ` · “${run.reason}”` : ''}`
    : prettyPath(p.cwd);

  const btns = [];
  if (run?.status === 'awaiting_approval') {
    btns.push(h('button', { class: 'keycap primary', onclick: async () => { await api.approve(run.id); const bay = S.bays.get(p.id); if (bay) launchFx(bay); } }, 'Approve'));
    btns.push(h('button', { class: 'keycap danger', onclick: () => api.deny(run.id) }, 'Deny'));
  } else if (run && ACTIVE.has(run.status)) {
    btns.push(h('button', { class: 'keycap danger', onclick: () => { api.cancel(run.id); sfx.click(); } }, run.kind === 'service' ? 'Stop' : 'Abort'));
    if (run.kind === 'service' && run.url) btns.push(h('button', { class: 'keycap', onclick: () => api.openUrl(run.url) }, 'Open ↗'));
  }
  btns.push(h('button', { class: 'keycap', onclick: async (e) => { const r = await api.getRun(S.drawer.runId); await api.copy((r?.log || []).join('\n').replace(/\x1b\[[0-9;]*m/g, '')); e.target.textContent = 'Copied ✓'; sfx.click(); setTimeout(() => (e.target.textContent = 'Copy'), 1400); } }, 'Copy'));
  btns.push(h('button', { class: 'keycap', title: p.cwd, onclick: () => api.reveal(p.cwd) }, 'Folder'));
  if (p.url) btns.push(h('button', { class: 'keycap', onclick: () => api.openUrl(/^https?:/.test(p.url) ? p.url : 'https://' + p.url) }, 'Site ↗'));
  btns.push(h('button', { class: 'keycap small', title: 'Close (Esc)', onclick: closeDrawer }, ICON.x()));
  D.actions.replaceChildren(...btns);
}

function renderRunChips() {
  const hist = S.drawer.history || [];
  if (!hist.length) { D.runs.replaceChildren(h('span', { class: 'run-chip' }, 'No deploys yet')); return; }
  D.runs.replaceChildren(...hist.slice(0, 20).map((r) => h('button', {
    class: 'run-chip' + (r.id === S.drawer.runId ? ' active' : ''),
    onclick: () => { S.drawer.runId = r.id; renderRunChips(); renderDrawerHead(); loadRunLog(r.id); },
  }, h('i', { class: r.status }), `${r.actionId ? '▸ ' : ''}${r.commandLabel} · ${ago(r.createdAt)}${r.source === 'agent' ? ' · agent' : ''}`)));
}

async function loadRunLog(runId) {
  if (!runId) { D.pre.innerHTML = '<span class="empty">No output yet. Hold the button to deploy.</span>'; S.drawer.lines = 0; return; }
  const run = await api.getRun(runId);
  const lines = run?.log || [];
  D.pre.innerHTML = lines.length ? lines.map(ansiToHtml).join('\n') : '<span class="empty">Waiting for output…</span>';
  S.drawer.lines = lines.length;
  D.pre.scrollTop = D.pre.scrollHeight;
  D.followBtn.hidden = true;
}

function appendLog(lines) {
  if (!lines.length) return;
  if (!S.drawer.lines) D.pre.innerHTML = '';
  D.pre.insertAdjacentHTML('beforeend', (S.drawer.lines ? '\n' : '') + lines.map(ansiToHtml).join('\n'));
  S.drawer.lines += lines.length;
  if (S.drawer.follow) D.pre.scrollTop = D.pre.scrollHeight;
}

// ---------------------------------------------------------------- AI usage lamps
function usageSummary(u) {
  return (u.windows || []).map((w) => (w.reset ? `${w.label} reset` : `${w.label} ${Math.round(w.used)}%`)).join(' · ') + (u.reached ? ' · LIMIT REACHED' : '');
}
function usageTone(u) {
  const now = Date.now();
  const live = (u.windows || []).filter((w) => !w.reset);
  const head = live.reduce((a, w) => (!a || w.used > a.used ? w : a), null);
  if (!head || u.state !== 'ok') return { head, tone: 'off' };
  if (u.reached || head.used >= 90) return { head, tone: 'bad' };
  if (head.used >= 70 || live.some((w) => w.minutes && w.resetsAt && w.used / 100 > 1 - (w.resetsAt - now) / (w.minutes * 60000) + 0.15)) return { head, tone: 'warn' };
  return { head, tone: 'ok' };
}
function renderUsageLamps() {
  const box = $('#usage-lamps');
  if (!box) return;
  const list = ['claude', 'codex'].map((k) => S.usage?.[k]).filter((u) => u && u.available && S.settings.usage?.[u.provider] !== false);
  box.replaceChildren(...list.map((u) => {
    const { head, tone } = usageTone(u);
    const label = head ? `${u.name} ${head.label} ${Math.round(head.used)}%` : u.state === 'setup' ? `${u.name} · SET UP` : `${u.name} · —`;
    const btn = h('button', { class: `lamp gauge-lamp tone-${tone}`, title: head ? `${u.name}: ${usageSummary(u)}. Click to refresh, ⌥-click to open the usage page.` : 'Click to set up' },
      h('i', { class: 'lamp-dot' }), h('span', {}, label));
    btn.addEventListener('click', async (e) => {
      sfx.click();
      if (u.state === 'setup') { openSettings({ focus: 'usage' }); return; }
      if (e.altKey) { api.openUsage(u.provider); return; }
      S.usage = (await api.refreshUsage()) || S.usage;
      renderUsageLamps();
      const fresh = S.usage[u.provider];
      toast(`${fresh.name}: ${usageSummary(fresh) || 'no data yet'}`, usageTone(fresh).tone === 'bad' ? 'bad' : usageTone(fresh).tone === 'warn' ? 'warn' : 'ok');
    });
    return btn;
  }));
}

// ---------------------------------------------------------------- flight log (activity)
const LOG = { open: false, items: [], filter: 'all', built: false, fresh: new Set() };
const SEEN_KEY = 'ploink.logSeenAt';
const readSeen = () => { try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch { return 0; } };
const writeSeen = (t) => { try { localStorage.setItem(SEEN_KEY, String(t)); } catch { /* storage off */ } };

function buildFlightLog() {
  const el = $('#flightlog');
  const filters = [['all', 'ALL'], ['failed', 'FAILED'], ['agent', 'AGENT']].map(([v, label]) =>
    h('button', { class: 'log-filter', 'data-v': v, 'data-word': label, onclick: () => { LOG.filter = v; sfx.click(); renderLog(); } }, word(label)));
  el.replaceChildren(
    h('div', { class: 'printer' },
      h('i', { class: 'printer-led' }),
      (LOG.title = h('span', { class: 'printer-title' }, word('FLIGHT LOG'))),
      ...filters,
      h('button', { class: 'keycap small', title: 'Close (Esc)', onclick: closeLog }, ICON.x()),
      h('i', { class: 'printer-slot' }),
    ),
    (LOG.paper = h('div', { class: 'paper' })),
  );
  LOG.filters = filters;
  LOG.built = true;
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'TODAY';
  if (d.toDateString() === y.toDateString()) return 'YESTERDAY';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
}
const who = (s) => (s === 'agent' ? 'by agent' : s === 'tray' ? 'from menu bar' : 'by you');
const secs = (ms) => (ms == null ? '' : dur(ms));

function describe(e) {
  const name = h('b', {}, e.projectName || 'Project');
  const cmd = e.command || '';
  if (e.kind && e.kind !== 'deploy') {
    const key = h('b', {}, cmd || 'key');
    switch (e.type) {
      case 'started': return { tone: 'info', mark: '▸', what: [name, ' · ', key, e.kind === 'service' ? ' started' : ' ran'], sub: [who(e.source), e.reason && `“${e.reason}”`] };
      case 'succeeded': return { tone: 'ok', mark: '✓', what: [name, ' · ', key, e.kind === 'check' ? ` ${e.value || 'ok'}` : ' done'], sub: [secs(e.durationMs)] };
      case 'failed': return { tone: 'bad', mark: '✕', what: [name, ' · ', key, e.kind === 'service' ? ' crashed' : ' failed', e.value ? ` · ${e.value}` : ''], sub: [`exit ${e.exitCode ?? '?'}`, e.detail] };
      case 'stopped': return { tone: 'info', mark: '■', what: [name, ' · ', key, ' stopped'], sub: [secs(e.durationMs)] };
      case 'requested': return { tone: 'warn', mark: '?', what: ['Agent asked to press ', key, ' on ', name], sub: [e.reason && `“${e.reason}”`] };
      case 'approved': return { tone: 'info', mark: '✓', what: ['You approved ', key, ' on ', name], sub: [] };
      default: return { tone: 'info', mark: '·', what: [name, ' · ', key, ` ${e.type}`], sub: [] };
    }
  }
  switch (e.type) {
    case 'started': return { tone: 'info', mark: '▲', what: [name, ' deploy started'], sub: [cmd, who(e.source), e.reason && `“${e.reason}”`] };
    case 'succeeded': return { tone: 'ok', mark: '✓', what: [name, ' shipped'], sub: [cmd, secs(e.durationMs), e.site?.ok && `site ${e.site.value}`] };
    case 'failed': return { tone: 'bad', mark: '✕', what: [name, ` failed · exit ${e.exitCode ?? '?'}`], sub: [e.detail || cmd, secs(e.durationMs)] };
    case 'cancelled': return { tone: 'warn', mark: '■', what: [name, ' aborted'], sub: [cmd, secs(e.durationMs)] };
    case 'requested': return { tone: 'warn', mark: '?', what: ['Agent asked to deploy ', name], sub: [cmd, e.reason && `“${e.reason}”`] };
    case 'approved': return { tone: 'info', mark: '✓', what: ['You approved ', name], sub: [cmd] };
    case 'denied': return { tone: 'info', mark: '–', what: ['Request to deploy ', name, ' denied'], sub: [cmd] };
    case 'expired': return { tone: 'info', mark: '…', what: ['Request to deploy ', name, ' expired'], sub: [cmd] };
    case 'added': return { tone: 'info', mark: '+', what: [name, ' added'], sub: [who(e.source)] };
    case 'removed': return { tone: 'info', mark: '−', what: [name, ' removed'], sub: [] };
    default: return { tone: 'info', mark: '·', what: [name, ` ${e.type}`], sub: [] };
  }
}

// the log's name and filter labels follow the button pack ("BLACK BOX", "HIGH SCORES", ...)
function updateLogWords() {
  const name = word('FLIGHT LOG');
  $('#btn-log').title = `${name.charAt(0)}${name.slice(1).toLowerCase()} (⌘L)`;
  $('#flightlog').setAttribute('aria-label', name.charAt(0) + name.slice(1).toLowerCase());
  if (!LOG.built) return;
  LOG.title.textContent = name;
  for (const b of LOG.filters) b.textContent = word(b.dataset.word);
}

// tabloid headlines for the newspaper log, written from real events
function headline(e) {
  const P = String(e.projectName || 'Project').toUpperCase();
  const secsTaken = e.durationMs != null ? Math.round(e.durationMs / 1000) : null;
  const took = secsTaken == null ? '' : secsTaken >= 90 ? ` IN ${Math.round(secsTaken / 60)} MINUTES` : ` IN ${secsTaken} SECONDS`;
  if (e.kind && e.kind !== 'deploy') {
    const K = String(e.command || 'key').toUpperCase();
    if (e.type === 'failed') return `${P} ${K} FAILS${e.value ? `: ${String(e.value).toUpperCase()}` : ''}`;
    if (e.type === 'succeeded') return `${P} ${K} ${e.kind === 'check' ? `READS ${String(e.value || 'OK').toUpperCase()}` : 'DONE'}`;
    return `${P} ${K} ${String(e.type).toUpperCase()}`;
  }
  switch (e.type) {
    case 'succeeded': return e.source === 'agent' ? `AGENT DEPLOYS ${P}; OWNER 'AT LUNCH'` : `${P} SHIPS${took}`;
    case 'failed': return `${P} DEPLOY COLLAPSES; EXIT ${e.exitCode ?? '?'}`;
    case 'started': return e.source === 'agent' ? `AGENT TAKES THE WHEEL AT ${P}` : `${P} GOES TO PRESS`;
    case 'cancelled': return `${P} DEPLOY PULLED AT THE LAST MINUTE`;
    case 'requested': return `AGENT ASKS TO DEPLOY ${P}`;
    case 'approved': return `OWNER APPROVES ${P} DEPLOY`;
    case 'denied': return `${P} REQUEST DENIED`;
    case 'expired': return `${P} REQUEST GOES UNANSWERED`;
    case 'added': return `${P} JOINS THE DECK`;
    case 'removed': return `${P} LEAVES THE DECK`;
    default: return `${P}: ${String(e.type).toUpperCase()}`;
  }
}

const isDeploy = (e) => !e.kind || e.kind === 'deploy';
const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

function renderLog() {
  if (!LOG.built) return;
  for (const b of LOG.filters) b.classList.toggle('active', b.dataset.v === LOG.filter);
  const items = LOG.items.filter((e) => LOG.filter === 'all' || (LOG.filter === 'failed' ? e.type === 'failed' : e.source === 'agent'));
  const style = logStyle();
  const deploys = LOG.items.filter((e) => isDeploy(e) && e.type === 'started').length;
  const out = [];
  if (style === 'newspaper') {
    out.push(h('div', { class: 'masthead' }, h('h3', {}, `The ${titleCase(word('FLIGHT LOG'))}`),
      h('div', {}, h('span', {}, `VOL. ${deploys}`), h('span', {}, new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()), h('span', {}, 'ONE HOLD'))));
  }
  out.push(h('div', { class: 'paper-head' }, style === 'window' ? [h('span', {}, 'Time'), h('span', {}), h('span', {}, 'Event')] : `PLOINK · ${S.projects.length} BAYS · ${new Date().toLocaleDateString()}`));
  if (!items.length) out.push(h('div', { class: 'paper-empty' }, LOG.items.length ? 'Nothing matches this filter.' : 'No activity yet. Hold a button.'));
  let day = '';
  for (const e of items.slice(0, 300)) {
    const label = dayLabel(e.at);
    if (label !== day) { day = label; out.push(h('div', { class: 'day' }, label)); }
    const d = describe(e);
    const project = S.projects.find((p) => p.id === e.projectId);
    const go = !!(e.runId && project);
    const parts = d.sub.filter(Boolean).map((x) => (style === 'dossier' && x === 'by agent' ? h('span', { class: 'redact', title: 'Hover to declassify' }, 'by agent') : x));
    const sub = parts.flatMap((x, i) => (i ? [' · ', x] : [x]));
    const agentSlip = style === 'slips' && e.source === 'agent';
    let what = d.what;
    if (style === 'newspaper') what = [headline(e)];
    else if (agentSlip) what = ['Agent called. ', ...d.what];
    let mark = d.mark;
    if (style === 'scene') {
      const idx = Math.max(0, (S.order || []).indexOf(e.projectId));
      mark = h('i', { class: 'shape-icon', 'data-s': capShape(idx) || 'cube', vars: { '--c': project ? capColor(project, idx) : '#4dabf7' } });
    }
    out.push(h('div', {
      class: `entry ${d.tone}${go ? ' go' : ''}${LOG.fresh.has(e.id) ? ' fresh' : ''}`,
      title: go ? 'Open this deploy log' : '',
      onclick: go ? () => { closeLog(); openDrawer(e.projectId, e.runId); } : null,
    },
      agentSlip ? h('div', { class: 'wywo' }, 'WHILE YOU WERE OUT', h('span', { class: `urgent${e.type === 'failed' ? ' on' : ''}` }, 'URGENT')) : null,
      h('time', {}, hhmm(e.at)),
      h('span', { class: 'mark' }, mark),
      h('span', { class: 'what' }, ...what),
      sub.length ? h('span', { class: 'sub' }, ...sub) : null,
      style === 'pinboard' && e.type === 'failed' ? h('div', { class: 'specimen-card' },
        h('span', { html: specimenSvg(e.id || e.runId || e.at) }),
        h('span', { class: 'latin' }, specimenName(e.projectName, e.exitCode, e.id || e.at),
          h('small', {}, `${e.projectName || 'Project'} · exit ${e.exitCode ?? '?'} · ${new Date(e.at).toLocaleDateString()}`))) : null,
    ));
  }
  if (style === 'worksheet') {
    const done = LOG.items.filter((e) => isDeploy(e) && e.type === 'succeeded');
    const failed = LOG.items.filter((e) => isDeploy(e) && e.type === 'failed').length;
    const avg = done.length ? Math.round(done.reduce((n, e) => n + (e.durationMs || 0), 0) / done.length / 1000) : 0;
    out.push(h('div', { class: 'sheet-foot' },
      h('div', { class: 'sheet-tabs' }, [['all', 'ALL'], ['failed', 'FAILED'], ['agent', 'AGENT']].map(([v, label]) =>
        h('button', { class: LOG.filter === v ? 'active' : '', onclick: () => { LOG.filter = v; sfx.click(); renderLog(); } }, titleCase(word(label))))),
      h('div', { class: 'sheet-status' }, h('span', {}, `SUM: ${done.length} shipped`), h('span', {}, `AVERAGE: ${avg}s`), h('span', {}, `COUNT(failed): ${failed}`))));
  }
  if (style === 'guestbook') out.push(h('div', { class: 'hit-counter' }, 'You are deploy no.', h('b', {}, String(deploys).padStart(6, '0'))));
  LOG.paper.replaceChildren(...out);
  LOG.fresh.clear();
}

async function openLog() {
  if (!LOG.built) buildFlightLog();
  LOG.items = await api.getActivity(400);
  LOG.open = true;
  renderLog();
  LOG.paper.scrollTop = 0;
  const el = $('#flightlog');
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  sfx.printer();
  markLogSeen();
}

function closeLog() {
  LOG.open = false;
  const el = $('#flightlog');
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

function toggleLog() { if (LOG.open) closeLog(); else openLog(); }

function markLogSeen() {
  writeSeen(Date.now());
  $('#btn-log').classList.remove('has-new', 'has-fail');
}

function onActivity(e) {
  LOG.items.unshift(e);
  if (LOG.open) {
    LOG.fresh.add(e.id);
    renderLog();
    const el = $('#flightlog');
    restartClass(el, 'printing', 800);
    if (e.type !== 'started') sfx.printer();
    markLogSeen();
  } else {
    const btn = $('#btn-log');
    btn.classList.add('has-new');
    if (e.type === 'failed') btn.classList.add('has-fail');
  }
}

async function primeLogDot() {
  const items = await api.getActivity(50);
  LOG.items = items;
  const seen = readSeen();
  const unseen = items.filter((e) => e.at > seen);
  if (!seen) { writeSeen(Date.now()); return; }
  $('#btn-log').classList.toggle('has-new', unseen.length > 0);
  $('#btn-log').classList.toggle('has-fail', unseen.some((e) => e.type === 'failed'));
}

// ---------------------------------------------------------------- modals
function openModal(build, { onClose, kind = '' } = {}) {
  closeModal(true);
  const root = $('#modal-root');
  const scrim = h('div', { class: `scrim ${kind}`, onclick: () => closeModal() });
  const sheet = h('div', { class: `sheet ${kind}`, role: 'dialog', 'aria-modal': 'true' });
  build(sheet);
  root.append(scrim, sheet);
  requestAnimationFrame(() => { scrim.classList.add('show'); sheet.classList.add('show'); });
  S.modal = { scrim, sheet, onClose, kind };
  setTimeout(() => sheet.querySelector('[autofocus]')?.focus(), 60);
}

function closeModal(immediate = false) {
  if (!S.modal) return;
  const { scrim, sheet, onClose } = S.modal;
  S.modal = null;
  onClose?.();
  if (immediate) { scrim.remove(); sheet.remove(); return; }
  scrim.classList.remove('show');
  sheet.classList.remove('show');
  setTimeout(() => { scrim.remove(); sheet.remove(); }, 320);
}

function rocker(checked, onChange) {
  const b = h('button', { class: 'rocker', role: 'switch', 'aria-checked': String(!!checked) }, h('span', { class: 'rocker-track' }, h('span', { class: 'rocker-nub' })));
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(v));
    sfx.click();
    onChange(v);
  });
  return b;
}

function field(label, control, hint) {
  return h('label', { class: 'field' },
    h('div', { class: 'field-label' }, label),
    control,
    hint ? h('div', { class: 'field-hint' }, hint) : null,
  );
}

// ---------- bay editor
function openEditor(project) {
  const isNew = !project.id;
  const draft = {
    id: project.id || null,
    name: project.name || '',
    cwd: project.cwd || '',
    url: project.url || '',
    icon: project.icon || null,
    color: isNew ? null : project.color || null,
    commands: (project.commands || []).map((c) => ({ ...c })),
    actions: (project.actions || []).map((a) => ({ ...a })),
    requireApproval: !!project.requireApproval,
    activeCommandId: project.activeCommandId,
    bank: project.bank || '',
  };
  if (!draft.commands.length) draft.commands.push({ label: 'deploy', cmd: '' });
  let colorAuto = isNew;
  let lastFetchedUrl = draft.url;

  openModal((sheet) => {
    const preview = h('button', { class: 'icon-preview', title: 'Choose an image', onclick: pickIcon });
    const status = h('span', { class: 'field-hint' });

    const paintPreview = async () => {
      let color = draft.color;
      if (colorAuto) color = (draft.icon && (await colorFromIcon(draft.icon))) || colorFromName(draft.name || 'x');
      const { vars, tone } = capVars(color);
      for (const [k, v] of Object.entries(vars)) preview.style.setProperty(k, v);
      preview.dataset.tone = tone;
      preview.replaceChildren(medalEl({ ...draft, name: draft.name || '?' }));
      for (const s of swatches.children) s.classList.toggle('active', colorAuto ? s.dataset.c === 'auto' : s.dataset.c === draft.color);
      return color;
    };

    async function pickIcon() {
      const data = await api.pickIcon();
      if (data) { draft.icon = data; paintPreview(); }
    }
    async function fetchFromSite() {
      const url = urlInput.value.trim();
      if (!url) { status.textContent = 'Add the website URL first.'; urlInput.focus(); return; }
      status.textContent = 'Fetching icon…';
      const data = await api.fetchIcon(url);
      lastFetchedUrl = url;
      if (data) { draft.icon = data; status.textContent = 'Got it.'; paintPreview(); }
      else status.textContent = 'No icon found on that site.';
    }

    const nameInput = h('input', { class: 'input', value: draft.name, placeholder: 'My project', autofocus: true, oninput: (e) => { draft.name = e.target.value; if (!draft.icon) paintPreview(); } });
    const folderText = h('input', { class: 'input mono', value: prettyPath(draft.cwd), readOnly: true, title: draft.cwd });
    const urlInput = h('input', { class: 'input mono', value: draft.url, placeholder: 'https://example.com', oninput: (e) => { draft.url = e.target.value.trim(); } });
    urlInput.addEventListener('blur', () => { if (draft.url && draft.url !== lastFetchedUrl && !draft.icon) fetchFromSite(); });

    const cmdList = h('div', { class: 'cmd-list' });
    const renderCmds = () => {
      cmdList.replaceChildren(...draft.commands.map((c, i) => h('div', { class: 'cmd-row' },
        h('input', { class: 'input mono', value: c.label, placeholder: 'label', maxLength: 24, oninput: (e) => { c.label = e.target.value; } }),
        h('input', { class: 'input mono', value: c.cmd, placeholder: 'npm run deploy', oninput: (e) => { c.cmd = e.target.value; c.trusted = true; } }),
        h('button', { class: 'x', title: 'Remove command', onclick: () => { draft.commands.splice(i, 1); renderCmds(); } }, ICON.x()),
        c.trusted === false ? trustChip(() => { c.trusted = true; renderCmds(); }) : null,
      )));
    };
    renderCmds();

    // ---- action keys
    const KIND_NAMES = { oneshot: 'Run once', check: 'Check', service: 'Service' };
    const flag = (label, on, onToggle, extra = '') => {
      const b = h('button', { class: `flag ${extra}`, 'aria-pressed': String(!!on), type: 'button' }, label);
      b.addEventListener('click', () => { const v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(v)); sfx.click(); onToggle(v); });
      return b;
    };
    const actList = h('div', { class: 'act-list' });
    const suggestBox = h('div', { class: 'suggest' });
    let detected = project._new ? [] : null;
    const QUICK = [
      { label: 'pull', kind: 'oneshot', cmd: 'git pull --ff-only', agents: true },
      { label: 'fetch', kind: 'oneshot', cmd: 'git fetch --all --prune', agents: true },
      { label: 'test', kind: 'oneshot', cmd: 'npm test', agents: true },
      { label: 'lint', kind: 'oneshot', cmd: 'npm run lint', agents: true },
      { label: 'types', kind: 'oneshot', cmd: 'npx tsc --noEmit', agents: true },
    ];
    const renderSuggest = () => {
      const have = new Set(draft.actions.map((a) => a.label.toLowerCase()));
      const pool = [...(detected || []), ...QUICK].filter((a, i, all) => !have.has(a.label) && all.findIndex((b) => b.label === a.label) === i);
      if (draft.url && !have.has('health') && !pool.some((a) => a.label === 'health')) {
        pool.unshift({ label: 'health', kind: 'check', cmd: HEALTH_CMD, agents: true, afterDeploy: true });
      }
      suggestBox.replaceChildren(...(draft.actions.length >= 6 ? [] : pool.slice(0, 7).map((a) => h('button', {
        class: 'flag', type: 'button', title: a.cmd,
        onclick: () => { draft.actions.push({ ...a }); sfx.click(); renderActs(); },
      }, `+ ${a.label} · ${KIND_NAMES[a.kind].toLowerCase()}`))));
    };
    const renderActs = () => {
      actList.replaceChildren(...draft.actions.map((a, i) => {
        const kindSel = h('select', { class: 'input mono', onchange: (e) => { a.kind = e.target.value; if (a.kind !== 'check') a.afterDeploy = false; renderActs(); } },
          ...Object.entries(KIND_NAMES).map(([v, label]) => h('option', { value: v, selected: a.kind === v }, label)));
        const flags = [
          flag('hold to run', a.hold, (v) => { a.hold = v; }, 'warn'),
          flag('agents may press', a.agents, (v) => { a.agents = v; }),
        ];
        if (a.kind === 'check') {
          flags.push(flag('after each deploy', a.afterDeploy, (v) => { a.afterDeploy = v; }));
          flags.push(h('input', { class: 'input mono', style: { height: '24px', fontSize: '10.5px', width: '190px' }, value: a.parse || '', placeholder: 'value: last line, or a regex', oninput: (e) => { a.parse = e.target.value; } }));
        }
        if (a.trusted === false) flags.unshift(trustChip(() => { a.trusted = true; renderActs(); }));
        return h('div', { class: 'act-row' },
          h('input', { class: 'input mono', value: a.label, placeholder: 'label', maxLength: 12, oninput: (e) => { a.label = e.target.value; } }),
          kindSel,
          h('input', { class: 'input mono', value: a.cmd, placeholder: a.kind === 'service' ? 'npm run dev' : a.kind === 'check' ? 'curl -fsS … (last line = value)' : 'git pull --ff-only', oninput: (e) => { a.cmd = e.target.value; a.trusted = true; } }),
          h('button', { class: 'x', title: 'Remove key', onclick: () => { draft.actions.splice(i, 1); renderActs(); } }, ICON.x()),
          h('div', { class: 'act-flags' }, ...flags),
        );
      }));
      renderSuggest();
    };
    renderActs();
    if (detected === null && draft.cwd) api.detectProject(draft.cwd).then((d) => { detected = d?.actions || []; renderSuggest(); }).catch(() => {});

    const swatches = h('div', { class: 'swatches' },
      h('button', { class: 'swatch', 'data-c': 'auto', title: 'Match the icon', vars: { '--c': '#777' }, style: { background: 'conic-gradient(#e5484d, #f5b82e, #2fa86a, #1e93f0, #8e4ec6, #e5484d)' }, onclick: () => { colorAuto = true; draft.color = null; paintPreview(); sfx.click(); } }),
      ...CAP_COLORS.map((c) => h('button', { class: 'swatch', 'data-c': c.hex, title: c.name, vars: { '--c': c.hex }, onclick: () => { colorAuto = false; draft.color = c.hex; paintPreview(); sfx.click(); } })),
    );

    const removeBtn = isNew ? null : holdButton('Hold to remove', async () => {
      await api.deleteProject(draft.id);
      closeModal();
      toast(`${draft.name} removed.`, 'info');
    });

    const save = async () => {
      const commands = draft.commands.filter((c) => c.cmd.trim()).map((c) => ({ ...c, label: c.label.trim() || 'deploy', cmd: c.cmd.trim() }));
      const actions = draft.actions.filter((a) => a.cmd.trim()).map((a) => ({ ...a, label: a.label.trim().toLowerCase() || 'action', cmd: a.cmd.trim() }));
      if (!draft.name.trim()) { nameInput.focus(); toast('Give the bay a name.', 'warn'); return; }
      if (!draft.cwd) { toast('Pick the project folder.', 'warn'); return; }
      const color = colorAuto ? ((draft.icon && (await colorFromIcon(draft.icon))) || colorFromName(draft.name)) : draft.color;
      const saved = await api.saveProject({ ...(draft.id ? { id: draft.id } : {}), name: draft.name.trim(), cwd: draft.cwd, url: draft.url, icon: draft.icon, color, commands, actions, requireApproval: draft.requireApproval, activeCommandId: draft.activeCommandId, bank: draft.bank.trim() });
      closeModal();
      if (isNew && saved?.id) setTimeout(() => celebrateInstall(saved.id), 120);
    };

    const hints = project._hints?.length ? `Found: ${project._hints.join(', ')}.` : 'Each command runs in your login shell, inside the project folder.';

    sheet.append(
      h('div', { class: 'sheet-head' }, h('h2', {}, isNew ? 'Install bay' : 'Bay settings'), h('div', { class: 'grow' }), h('button', { class: 'keycap small', onclick: () => closeModal(), title: 'Close' }, ICON.x())),
      h('div', { class: 'sheet-body' },
        h('div', { class: 'icon-pick' },
          preview,
          h('div', {},
            h('div', { class: 'icon-actions' },
              h('button', { class: 'keycap', onclick: fetchFromSite }, 'From website'),
              h('button', { class: 'keycap', onclick: pickIcon }, 'Choose image…'),
              h('button', { class: 'keycap', onclick: () => { draft.icon = null; paintPreview(); } }, 'Monogram'),
            ),
            status,
          ),
        ),
        field('Name', nameInput),
        field('Folder', h('div', { class: 'row' }, h('div', { class: 'grow' }, folderText), h('button', { class: 'keycap', onclick: async () => { const dir = await api.pickFolder(); if (dir) { draft.cwd = dir; folderText.value = prettyPath(dir); folderText.title = dir; } } }, 'Change…'))),
        field('Website', urlInput, 'Used for the button icon and the ↗ link.'),
        field('Bank', h('div', {},
          h('input', { class: 'input', value: draft.bank, placeholder: 'Main', list: 'bank-names', maxLength: 24, oninput: (e) => { draft.bank = e.target.value; } }),
          h('datalist', { id: 'bank-names' }, ...[...new Set(S.projects.map((p) => p.bank).filter(Boolean))].map((n) => h('option', { value: n }))),
        ), 'Group projects into banks like “Clients” or “Side projects”. The launch bar shows one bank at a time; flip with the bank dial, ← →, or by typing a name.'),
        h('div', { class: 'field' },
          h('div', { class: 'field-label' }, 'Deploy commands', h('span', {}, 'label · shell command')),
          cmdList,
          h('button', { class: 'add-cmd', onclick: () => { draft.commands.push({ label: '', cmd: '' }); renderCmds(); cmdList.lastChild?.querySelector('input')?.focus(); } }, '+ add command'),
          h('div', { class: 'field-hint' }, hints, ' Two or more commands get a selector switch on the bay.'),
        ),
        h('div', { class: 'field' },
          h('div', { class: 'field-label' }, 'Action keys', h('span', {}, 'small keys under the button')),
          actList,
          h('button', { class: 'add-cmd', onclick: () => { if (draft.actions.length >= 6) { toast('Six keys per bay at most.', 'warn'); return; } draft.actions.push({ label: '', kind: 'oneshot', cmd: '', hold: false, agents: false }); renderActs(); actList.lastChild?.querySelector('input')?.focus(); } }, '+ add key'),
          suggestBox,
          h('div', { class: 'field-hint' }, 'Run once: pass or fail, like a small deploy. Check: shows the last line of output on the readout (for example 200 · 0.21s). Service: a dev server you start and stop; Ploink shows its localhost port. Variables: $PLOINK_URL is the website above.'),
        ),
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Cap colour'), swatches),
        h('div', { class: 'toggle-row' },
          h('div', { class: 'txt' }, h('b', {}, 'Ask me before agents deploy this'), h('span', {}, 'Agent requests make the button glow amber until you hold it.')),
          rocker(draft.requireApproval, (v) => { draft.requireApproval = v; }),
        ),
      ),
      h('div', { class: 'sheet-foot' },
        removeBtn,
        h('div', { class: 'grow' }),
        h('button', { class: 'keycap', onclick: () => closeModal() }, 'Cancel'),
        h('button', { class: 'keycap primary', onclick: save }, isNew ? 'Install bay' : 'Save'),
      ),
    );
    sheet.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.target.tagName === 'INPUT')) { e.preventDefault(); save(); } });
    paintPreview();
  });
}

function holdButton(label, onDone, ms = 900) {
  const fill = h('span', { class: 'fill' });
  const btn = h('button', { class: 'keycap danger hold-btn' }, fill, h('span', {}, label));
  let raf = 0, start = 0, done = false;
  const stop = () => { cancelAnimationFrame(raf); if (!done) fill.style.transform = 'scaleX(0)'; };
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    start = performance.now();
    sfx.press();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      fill.style.transform = `scaleX(${t})`;
      if (t >= 1) { done = true; sfx.denied(); onDone(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointercancel', stop);
  return btn;
}

// ---------- settings
function openSettings({ focus } = {}) {
  if (S.modal?.kind === 'settings') return;
  const save = async (patch) => {
    const res = await api.saveSettings(patch);
    S.settings = res.settings;
    if (res.mcp) S.mcp = res.mcp;
    configureAudio(S.settings);
    applyLook();
    updateLamps();
    renderMcp();
    return res;
  };

  let mcpBox;
  const mcpUrl = () => `http://127.0.0.1:${S.settings.mcpPort}/mcp`;
  const copyRow = (label, text) => h('div', {},
    h('div', { class: 'copy-label' }, label),
    h('div', { class: 'copy-row' }, h('code', {}, text), h('button', { class: 'keycap', onclick: async (e) => { await api.copy(text); sfx.click(); e.target.textContent = 'Copied ✓'; setTimeout(() => (e.target.textContent = 'Copy'), 1400); } }, 'Copy')),
  );
  let selectedClient = null;
  const renderMcp = () => {
    if (!mcpBox) return;
    const st = S.mcp.running ? 'on' : S.mcp.error ? 'err' : '';
    const url = mcpUrl();
    const port = Number(S.settings.mcpPort);
    const auth = S.settings.mcpAuth !== 'off';
    const clients = S.settings.mcpClients || [];
    const sel = clients.find((c) => c.id === selectedClient) || clients[clients.length - 1] || null;
    const items = [h('div', { class: `mcp-status ${st}` }, h('i'), S.mcp.running ? `LISTENING ON ${url}` : S.mcp.error ? S.mcp.error.toUpperCase() : 'OFF')];
    if (auth && S.mcpUnauthorized) items.push(h('div', { class: 'mcp-warn' }, 'An agent tried to connect without a valid token. Create a token for it below and run its new setup line.'));
    if (!auth) items.push(h('div', { class: 'mcp-warn' }, 'Tokens are off: any program running on this Mac can press your buttons through this link.'));
    if (auth) {
      items.push(h('div', { class: 'client-list' }, ...clients.map((c) => h('div', { class: `client-row${sel && c.id === sel.id ? ' active' : ''}` },
        h('b', {}, c.name),
        h('span', {}, c.lastUsedAt ? `used ${ago(c.lastUsedAt)}` : 'not used yet'),
        h('div', { class: 'grow' }),
        h('button', { class: 'keycap', onclick: () => { selectedClient = c.id; sfx.click(); renderMcp(); } }, 'Setup line'),
        h('button', { class: 'keycap danger', onclick: async () => {
          await api.removeMcpClient(c.id);
          S.settings = { ...S.settings, mcpClients: (S.settings.mcpClients || []).filter((x) => x.id !== c.id) };
          renderMcp();
          toast(`${c.name} can no longer connect.`, 'info');
        } }, 'Revoke'),
      ))));
      const nameIn = h('input', { class: 'input', placeholder: 'Agent name, for example Cursor', value: clients.length ? '' : 'Claude Code', maxLength: 40 });
      items.push(h('div', { class: 'client-add' }, nameIn, h('button', { class: 'keycap primary', onclick: async () => {
        const c = await api.addMcpClient(nameIn.value.trim() || 'Agent');
        if (!c) return;
        S.settings = { ...S.settings, mcpClients: [...(S.settings.mcpClients || []).filter((x) => x.id !== c.id), c] };
        selectedClient = c.id;
        S.mcpUnauthorized = null;
        sfx.click();
        renderMcp();
      } }, 'Create token')));
    }
    if (!auth || sel) {
      const token = auth ? sel.token : null;
      if (token) items.push(h('div', { class: 'copy-label', style: { marginTop: '14px' } }, `SETUP FOR ${sel.name.toUpperCase()}`));
      items.push(copyRow('CLAUDE CODE', `claude mcp add --transport http --scope user ploink ${url}${token ? ` --header "Authorization: Bearer ${token}"` : ''}`));
      items.push(h('div', { class: 'field-hint' }, 'Added Ploink to Claude Code before? Run ', h('code', {}, 'claude mcp remove --scope user ploink'), ' first.'));
      items.push(copyRow('JSON CONFIG (CURSOR, WINDSURF, OTHERS)', JSON.stringify({ mcpServers: { ploink: token ? { url, headers: { Authorization: `Bearer ${token}` } } : { url } } })));
      const env = { ...(token ? { PLOINK_TOKEN: token } : {}), ...(port !== 47321 ? { PLOINK_PORT: String(port) } : {}) };
      items.push(copyRow('STDIO-ONLY CLIENTS', JSON.stringify({ mcpServers: { ploink: { command: 'node', args: [`${S.appPath}/bin/ploink-mcp.mjs`], ...(Object.keys(env).length ? { env } : {}) } } })));
    } else {
      items.push(h('div', { class: 'field-hint' }, 'Create one token per agent (Claude Code, Cursor, Codex…). Each can be revoked on its own, and the log shows which agent pressed what.'));
    }
    mcpBox.replaceChildren(...items);
  };

  const shortcutBtn = h('button', { class: 'keycap shortcut-btn' }, prettyShortcut(S.settings.shortcut));
  const shortcutHint = h('div', { class: 'field-hint' }, S.shortcut?.ok === false ? S.shortcut.error : 'Press it anywhere to show or hide Ploink. On Mac keyboards F5 may need fn, unless “Use F1, F2… as standard function keys” is on.');
  shortcutBtn.addEventListener('click', () => {
    if (S.recording) return;
    S.recording = true;
    api.pauseShortcut(true);
    shortcutBtn.textContent = 'Press keys…';
    shortcutBtn.classList.add('recording');
    const onKey = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return finish(null);
      if (e.key === 'Backspace' || e.key === 'Delete') return finish('');
      const acc = toAccelerator(e);
      if (acc) finish(acc);
    };
    const finish = async (acc) => {
      window.removeEventListener('keydown', onKey, true);
      S.recording = false;
      shortcutBtn.classList.remove('recording');
      if (acc === null) { api.pauseShortcut(false); shortcutBtn.textContent = prettyShortcut(S.settings.shortcut); return; }
      const res = await save({ shortcut: acc });
      S.shortcut = res.shortcut || S.shortcut;
      shortcutBtn.textContent = prettyShortcut(S.settings.shortcut);
      shortcutHint.textContent = S.shortcut.ok === false ? S.shortcut.error : acc ? `Saved. Press ${prettyShortcut(acc)} anywhere to summon Ploink.` : 'Shortcut removed.';
      sfx.click();
    };
    window.addEventListener('keydown', onKey, true);
  });

  const holdVal = h('span', { class: 'slider-val' });
  const holdLabel = (ms) => (ms < 40 ? 'instant' : `${(ms / 1000).toFixed(2)}s`);
  holdVal.textContent = holdLabel(S.settings.holdMs);
  const holdSlider = h('input', { type: 'range', class: 'slider', min: 0, max: 1500, step: 50, value: S.settings.holdMs });
  holdSlider.addEventListener('input', () => { holdVal.textContent = holdLabel(+holdSlider.value); });
  holdSlider.addEventListener('change', () => save({ holdMs: +holdSlider.value }));

  const volSlider = h('input', { type: 'range', class: 'slider', min: 0, max: 1, step: 0.05, value: S.settings.volume });
  volSlider.addEventListener('change', () => { save({ volume: +volSlider.value }).then(() => sfx.success()); });

  const seg = (options, value, onPick) => {
    const wrap = h('div', { class: 'seg' });
    const paint = (v) => { for (const b of wrap.children) b.classList.toggle('active', b.dataset.v === v); };
    for (const [v, label] of options) wrap.append(h('button', { 'data-v': v, onclick: () => { paint(v); sfx.click(); onPick(v); } }, label));
    paint(value);
    return wrap;
  };

  const portInput = h('input', { class: 'input mono', type: 'number', min: 1024, max: 65535, value: S.settings.mcpPort, style: { width: '110px' } });
  portInput.addEventListener('change', () => { const v = Math.round(+portInput.value); if (v >= 1024 && v <= 65535) save({ mcpPort: v }); });

  const saveBar = (patch) => save({ bar: patch });
  const usageBox = h('div', {});
  const renderUsageBox = () => {
    const u = S.usage || {};
    const c = u.claude || {};
    const x = u.codex || {};
    const on = S.settings.usage || {};
    const claudeBtn = c.connected
      ? h('button', { class: 'keycap', onclick: async () => { await api.disconnectClaude(); S.usage = await api.getUsage(); renderUsageBox(); renderUsageLamps(); toast('Claude Code status line restored.', 'info'); } }, 'Disconnect')
      : h('button', { class: 'keycap', onclick: async () => { const r = await api.connectClaude(); if (r?.error) toast(r.error, 'bad'); else if (r?.ok) toast('Live updates on: the gauge also updates on every Claude Code reply in a terminal.', 'ok', 5000); S.usage = await api.getUsage(); renderUsageBox(); renderUsageLamps(); } }, 'Live updates');
    usageBox.replaceChildren(
      h('div', { class: 'toggle-row' },
        h('div', { class: 'txt' }, h('b', {}, 'Claude'), h('span', {}, c.available
          ? `Read from Claude Code's own /usage every 10 minutes (no chat, nothing saved). ${c.state === 'ok' ? usageSummary(c) + '.' : 'Checking…'} ${c.connected ? 'Live updates from the terminal status line are on.' : 'Optional: Live updates adds a small status line hook for terminal use; your own status line keeps working.'}`
          : 'Install Claude Code (the claude CLI) and sign in to see your Claude plan usage.')),
        claudeBtn,
        rocker(on.claude !== false, (v) => save({ usage: { claude: v } })),
      ),
      h('div', { class: 'toggle-row' },
        h('div', { class: 'txt' }, h('b', {}, 'Codex (ChatGPT)'), h('span', {}, x.available
          ? `Read live from the official codex app. ${x.state === 'ok' ? usageSummary(x) : 'Checking…'}`
          : 'Install the Codex CLI and sign in with ChatGPT to see your limits.')),
        rocker(on.codex !== false, (v) => save({ usage: { codex: v } })),
      ),
      h('div', { class: 'toggle-row' },
        h('div', { class: 'txt' }, h('b', {}, 'Cursor'), h('span', {}, 'Coming later. Cursor has no public usage data for personal plans yet.')),
      ),
    );
  };
  renderUsageBox();
  const iconVal = h('span', { class: 'slider-val' }, `${Math.round((S.settings.iconScale ?? 0.5) * 100)}%`);
  const iconSlider = h('input', { type: 'range', class: 'slider', min: 0.3, max: 0.86, step: 0.02, value: S.settings.iconScale ?? 0.5 });
  iconSlider.addEventListener('input', () => {
    iconVal.textContent = `${Math.round(+iconSlider.value * 100)}%`;
    document.body.style.setProperty('--icon-scale', iconSlider.value); // live preview behind the sheet
  });
  iconSlider.addEventListener('change', () => save({ iconScale: +iconSlider.value }));
  function edgePicker() {
    const label = h('div', { class: 'edge-label' });
    const names = { top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right', notch: 'Notch' };
    const screen = h('div', { class: 'edge-screen' },
      h('div', { class: 'edge-menubar' }),
      ...['top', 'bottom', 'left', 'right', 'notch'].map((e) => h('button', { class: `edge-hit e-${e}`, 'data-edge': e, title: names[e], onclick: () => { paint(e); sfx.click(); saveBar({ edge: e }); } }, h('i'))),
    );
    const paint = (edge) => {
      for (const b of screen.querySelectorAll('.edge-hit')) b.classList.toggle('active', b.dataset.edge === edge);
      label.textContent = names[edge];
    };
    paint(S.settings.bar?.edge || 'bottom');
    return h('div', { class: 'edge-pick' }, screen, label);
  }
  const row = (title, sub, control) => h('div', { class: 'toggle-row' }, h('div', { class: 'txt' }, h('b', {}, title), sub ? h('span', {}, sub) : null), control);

  openModal((sheet) => {
    mcpBox = h('div', { id: 'mcp-box' });
    sheet.append(
      h('div', { class: 'sheet-head' }, h('h2', {}, 'Console settings'), h('div', { class: 'grow' }), h('button', { class: 'keycap small', onclick: () => closeModal(), title: 'Close' }, ICON.x())),
      h('div', { class: 'sheet-body' },
        h('div', { class: 'section-title' }, 'Controls'),
        row('Summon shortcut', null, shortcutBtn),
        shortcutHint,
        row('Hold to launch', 'How long you hold a button before it fires.', h('div', { class: 'row' }, holdSlider, holdVal)),
        row('Sound', null, h('div', { class: 'row' }, volSlider, rocker(S.settings.sound, (v) => save({ sound: v })))),
        row('Hide the console when I click away', 'Behave like Spotlight.', rocker(S.settings.hideOnBlur, (v) => save({ hideOnBlur: v }))),
        row('Open at login', 'Works in the packaged app.', rocker(S.settings.launchAtLogin, (v) => save({ launchAtLogin: v }))),

        h('div', { class: 'section-title' }, 'Buttons'),
        row('Button pack', S.look?.license?.pro ? `${S.look.pack?.name || 'Mission Control'}. Ploink Pro is on.` : `${S.look?.pack?.name || 'Mission Control'}. Caps, LED rings, readouts and sounds.`, h('button', { class: 'keycap', onclick: () => { closeModal(true); openLook(); } }, 'Change…')),
        row('Shape', null, seg([['round', 'Round'], ['square', 'Square']], S.settings.buttonShape || 'round', (v) => save({ buttonShape: v }))),
        row('Icon size', 'How much of the button the project icon fills.', h('div', { class: 'row' }, iconSlider, iconVal)),
        row('Names under launch bar buttons', 'Easier to find the right project at a glance.', rocker(S.settings.barLabels, (v) => save({ barLabels: v }))),

        h('div', { class: 'section-title', id: 'sec-bar' }, 'Launch bar'),
        row('Launch bar', 'Mini launch buttons that slide in over any app, on the screen your mouse is on.', rocker(S.settings.bar?.enabled, (v) => saveBar({ enabled: v }))),
        h('div', { class: 'toggle-row edge-row' }, h('div', { class: 'txt' }, h('b', {}, 'Position'), h('span', {}, 'Click an edge of the screen, or the notch.')), edgePicker()),
        row('Show it', null, seg([['shortcut', `On ${prettyShortcut(S.settings.shortcut)}`], ['edge', 'At screen edge'], ['always', 'Always']], S.settings.bar?.visibility || 'shortcut', (v) => saveBar({ visibility: v }))),
        row('Style', 'Mini floats as a slim strip. Cockpit is a big console with readouts that rises flush from the screen edge. The little switch on the bar flips it too.', seg([['mini', 'Mini'], ['cockpit', 'Cockpit']], S.settings.bar?.style || 'mini', (v) => saveBar({ style: v }))),
        row('Size', null, seg([['small', 'S'], ['medium', 'M'], ['large', 'L']], S.settings.bar?.size || 'medium', (v) => saveBar({ size: v }))),
        row('Shortcut opens', null, seg([['bar', 'Launch bar'], ['console', 'Console']], S.settings.shortcutOpens || 'bar', (v) => save({ shortcutOpens: v }))),
        row('Announce results', 'When a deploy ends, the bar slides in with confetti or the error. Works over any app.', rocker(S.settings.announce, (v) => save({ announce: v }))),
        row('macOS notifications', 'Also send a system notification. Off by default.', rocker(S.settings.systemNotifications, (v) => save({ systemNotifications: v }))),

        h('div', { class: 'section-title', id: 'sec-usage' }, 'AI usage gauges'),
        usageBox,

        h('div', { class: 'section-title', id: 'sec-agents' }, 'Agents (MCP)'),
        row('Agent link', 'Lets coding agents list projects, deploy, press the keys you allow and read logs.', rocker(S.settings.mcpEnabled, (v) => save({ mcpEnabled: v }))),
        row('Port', null, portInput),
        row('Require a token', 'Recommended. Without a token, any program running on this Mac could press your buttons.', rocker(S.settings.mcpAuth !== 'off', (v) => save({ mcpAuth: v ? 'token' : 'off' }))),
        row('When an agent asks to deploy', null, seg([['auto', 'Deploy right away'], ['ask', 'Ask me first']], S.settings.agentApproval, (v) => save({ agentApproval: v }))),
        mcpBox,
      ),
      h('div', { class: 'sheet-foot' }, h('span', { class: 'field-hint' }, `Ploink ${S.version || ''}`), h('div', { class: 'grow' }), h('button', { class: 'keycap primary', onclick: () => closeModal() }, 'Done')),
    );
    renderMcp();
    if (focus === 'agents') setTimeout(() => $('#sec-agents', sheet)?.scrollIntoView({ behavior: 'smooth' }), 200);
    if (focus === 'usage') setTimeout(() => $('#sec-usage', sheet)?.scrollIntoView({ behavior: 'smooth' }), 200);
  }, { onClose: () => { if (S.recording) { S.recording = false; api.pauseShortcut(false); } } });
  S.modal.kind = 'settings';
}

const CODE_KEYS = { Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
function toAccelerator(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  if (!key) return null;
  const mods = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!mods.length && !/^F\d/.test(key)) return null; // plain letters would hijack typing everywhere
  return [...mods, key].join('+');
}

// ---------------------------------------------------------------- global input
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', (e) => {
  unlockAudio();
  if (S.recording) return;
  if (e.key === 'Escape') {
    if (S.modal) closeModal();
    else if (LOG.open) closeLog();
    else if (S.drawer.open) closeDrawer();
    else api.hide();
    return;
  }
  if (e.metaKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); toggleLog(); return; }
  if (e.metaKey && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (e.metaKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); if (!S.modal) addViaPicker(); return; }
  if (S.modal || e.target.closest?.('input, textarea, select')) return;
  if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (e.repeat) return;
    const p = S.projects.find((x) => x.id === (S.order || [])[Number(e.key) - 1]);
    if (p) beginHold(S.bays.get(p.id), 'key:' + e.key);
  }
});
window.addEventListener('keyup', (e) => { if (S.holding?.via === 'key:' + e.key) endHold(); });
window.addEventListener('blur', () => endHold());

// drag & drop folders
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dropping'); });
window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dropping'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const paths = [...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
  const packs = paths.filter((f) => f.endsWith('.ploinkpack'));
  const folders = paths.filter((f) => !f.endsWith('.ploinkpack'));
  if (packs.length) installPacks(packs);
  if (folders.length) addFromDrop(folders);
});

$('#btn-add').addEventListener('click', addViaPicker);
$('#btn-log').addEventListener('click', () => { sfx.click(); toggleLog(); });
$('#lamp-active').addEventListener('click', () => { sfx.click(); toggleLog(); });
$('#btn-settings').addEventListener('click', () => { sfx.click(); openSettings(); });
$('#btn-look').addEventListener('click', () => { sfx.click(); openLook(); });
$('#lamp-agent').addEventListener('click', () => { sfx.click(); openSettings({ focus: 'agents' }); });
$('#sound-toggle').addEventListener('click', async () => {
  const sound = !S.settings.sound;
  const res = await api.saveSettings({ sound });
  S.settings = res.settings;
  configureAudio(S.settings);
  updateLamps();
  if (sound) sfx.click();
});


// ---------------------------------------------------------------- look: button packs + Pro
const LOCK_SVG = '<svg width="9" height="10" viewBox="0 0 12 13"><rect x="1.5" y="5.6" width="9" height="6.6" rx="1.6" fill="currentColor"/><path d="M3.6 5.6V4a2.4 2.4 0 0 1 4.8 0v1.6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const FOUNDER = (n) => `FOUNDER #${String(n).padStart(3, '0')}`;

function setLook(look) {
  if (!look) return;
  const wasPro = S.look?.license?.pro;
  S.look = look;
  if (S.preview && !look.packs.some((p) => p.id === S.preview)) S.preview = null;
  if (!S.preview) applyPack(look.pack);
  restyleBays();
  updateBrand();
  S.lookSheet?.render();
  if (wasPro === false && look.license?.pro) celebrateUnlock();
}

function restyleBays() {
  applyLook();
  for (const bay of S.bays.values()) { bay.refs.status.dataset.s = ''; bay.refs.ticker.dataset.k = ''; updateBay(bay); }
  updateLamps();
  updateLogWords();
}

function updateBrand() {
  const lic = S.look?.license;
  const el = $('.brand-model');
  if (el) el.textContent = lic?.pro ? `DC‑01 PRO · ${lic.founder ? FOUNDER(lic.founder) : 'DEPLOY CONSOLE'}` : 'DC‑01 · DEPLOY CONSOLE';
  document.body.classList.toggle('is-pro', !!lic?.pro);
}

// show a pack's success moment on the first bay: LED sweep, effect and sound
function demoPack() {
  const bay = S.bays.get((S.order || [])[0]);
  sfx.success();
  if (!bay) return;
  restartClass(bay.el, 'just-success', 2400);
  const { x, y } = capCenter(bay);
  fx.celebrate('success', x, y, capColor(bay.project, bay.index));
}

function startPreview(pack) {
  S.preview = pack.id;
  applyPack(pack);
  restyleBays();
  demoPack();
}

function endPreview() {
  if (!S.preview) return;
  S.preview = null;
  applyPack(S.look?.pack);
  restyleBays();
}

async function pickPack(pack) {
  unlockAudio();
  if (pack.locked) { startPreview(pack); S.lookSheet?.render({ focusKey: true }); return; }
  S.preview = null;
  if (S.look.pack?.id !== pack.id) {
    const res = await api.saveSettings({ pack: pack.id });
    if (res?.settings) S.settings = res.settings;
    S.look = { ...S.look, pack };
    applyPack(pack);
    restyleBays();
  }
  demoPack();
  S.lookSheet?.render();
}

async function installPacks(files) {
  for (const file of files) {
    const res = await api.installPack(file);
    if (res?.error) { toast(res.error, 'bad', 6000); sfx.denied(); continue; }
    setLook(res.look);
    toast(`Installed the ${res.pack.name} pack${res.warnings?.length ? ` (${res.warnings.length} parts were skipped)` : ''}.`, 'ok', 5000);
    demoPack();
  }
}

function celebrateUnlock() {
  sfx.install();
  const bays = (S.order || []).map((id) => S.bays.get(id)).filter(Boolean);
  bays.forEach((bay, i) => setTimeout(() => {
    bay.el.style.setProperty('--delay', '0s');
    restartClass(bay.el, 'mount', 900);
    setTimeout(() => { const { x, y } = capCenter(bay); fx.confetti(x, y, capColor(bay.project, bay.index), { count: 45 }); }, 320);
  }, i * 110));
  setTimeout(() => sfx.success(), 300 + bays.length * 110);
  const brand = $('.brand-model');
  if (brand) restartClass(brand, 'engrave', 2600);
  const lic = S.look?.license || {};
  toast(lic.founder ? `Ploink Pro is on. Welcome aboard, founder #${lic.founder}.` : 'Ploink Pro is on. Every pack is yours.', 'ok', 6500);
}

function openLook() {
  if (S.modal?.kind === 'look') return;
  let msg = null;
  let busy = false;
  let keyValue = '';
  const body = h('div', { class: 'sheet-body look-body' });

  const activate = async () => {
    const key = keyValue.trim();
    if (!key || busy) return;
    busy = true;
    msg = { tone: '', text: 'Checking…' };
    render();
    const keep = S.preview;
    const res = await api.activatePro(key);
    busy = false;
    if (res?.error) { msg = { tone: 'bad', text: res.error }; sfx.denied(); render({ focusKey: true }); return; }
    msg = null;
    keyValue = '';
    if (keep) {
      S.preview = null;
      const saved = await api.saveSettings({ pack: keep });
      if (saved?.settings) S.settings = saved.settings;
    }
    setLook(res.look || (await api.getLook()));
  };

  function proCard(look) {
    const lic = look.license || {};
    const previewing = S.preview ? look.packs.find((p) => p.id === S.preview) : null;
    if (lic.pro) {
      const who = lic.founder ? FOUNDER(lic.founder) : 'PLOINK PRO';
      return h('div', { class: 'pro-card on' },
        h('span', { class: 'pro-badge' }, 'PRO'),
        h('div', { class: 'txt' },
          h('b', {}, who),
          h('span', {}, `${lic.kind === 'founder' ? 'Founder code' : 'License'} ••••${lic.keyHint}${lic.email ? ` · ${lic.email}` : ''}${lic.test ? ' · test purchase' : ''} · checked ${ago(lic.checkedAt)}`)),
        h('button', { class: 'keycap', title: 'Remove the key from this Mac', onclick: async () => { const l = await api.deactivatePro(); setLook(l); toast('Pro is off on this Mac. Your key still works on any Mac.', 'info'); } }, 'Sign out'));
    }
    if (!look.proBuild) {
      return h('div', { class: 'pro-card' },
        h('div', { class: 'txt' }, h('b', {}, 'Pro packs come with the official build'),
          h('span', {}, 'This copy was built from source, so it has the free packs only. Community packs work everywhere: drop a .ploinkpack file on the window.')),
        h('button', { class: 'keycap', onclick: () => api.openUrl('https://ploink.dev') }, 'ploink.dev'));
    }
    const input = h('input', { class: 'input mono', placeholder: 'License key or founder code', value: keyValue, spellcheck: false, autocomplete: 'off' });
    input.addEventListener('input', () => { keyValue = input.value; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') activate(); });
    const lapsed = lic.status === 'revoked' || lic.status === 'stale';
    const title = previewing ? `Previewing ${previewing.name}. Unlock Pro to keep it.` : lapsed ? (lic.status === 'stale' ? 'Pro needs a quick online check' : 'Pro is off') : 'Unlock Ploink Pro';
    const sub = lapsed
      ? (lic.message || 'Ploink could not check your license for 30 days. Connect to the internet and press Check again.')
      : 'Paste the license key from your Gumroad receipt, or the founder code from your founder page. Every pack below unlocks, plus everything Pro adds later in 1.x.';
    return h('div', { class: `pro-card${previewing ? ' glow' : ''}` },
      h('div', { class: 'txt' }, h('b', {}, title), h('span', {}, sub)),
      lapsed && lic.status === 'stale'
        ? h('div', { class: 'row' }, h('button', { class: 'keycap primary', onclick: async () => { setLook(await api.refreshPro()); } }, 'Check again'))
        : h('div', { class: 'row' }, input, h('button', { class: 'keycap primary', disabled: busy, onclick: activate }, busy ? 'Checking…' : 'Unlock')),
      msg ? h('div', { class: `pro-msg ${msg.tone}` }, msg.text) : null,
      h('div', { class: 'pro-links' },
        h('a', { onclick: () => api.openUrl('https://ploink.dev/#preorder') }, 'Get Pro'),
        h('a', { onclick: () => api.openUrl('https://ploink.dev/founders/welcome/') }, 'Find my founder code')),
    );
  }

  function tile(p, look) {
    const shown = S.preview || look.pack?.id;
    const tag = p.source === 'community' ? 'community' : p.tier === 'pro' ? 'pro' : 'free';
    const sample = S.projects[0] ? (S.projects[0].color || colorFromName(S.projects[0].name)) : '#e5484d';
    const leds = Array.from({ length: 12 }, (_, i) => h('i', { vars: { '--i': i } }));
    return h('button', {
      class: `pack-tile${shown === p.id ? ' shown' : ''}${look.pack?.id === p.id ? ' chosen' : ''}${p.locked ? ' locked' : ''} led-${p.led?.style || 'dots'}`,
      vars: previewVars(p, sample),
      title: p.description || p.name,
      onclick: () => pickPack(p),
    },
      h('span', { class: 'pv' }, h('span', { class: 'pv-ring' }, leds), h('span', { class: 'pv-cap' }), h('span', { class: 'pv-lcd' }, p.words?.SHIPPED || 'SHIPPED')),
      h('span', { class: 'pt-name' }, p.name),
      h('span', { class: `pt-tag tag-${tag}` }, p.locked ? h('span', { class: 'lock', html: LOCK_SVG }) : null, tag.toUpperCase()),
      look.pack?.id === p.id ? h('span', { class: 'pt-on' }, 'ON') : null,
      p.source === 'community' ? h('span', { class: 'pt-x', title: 'Remove this pack', onclick: async (e) => { e.stopPropagation(); const r = await api.removePack(p.id); setLook(r.look); } }, '×') : null,
    );
  }

  function render({ focusKey = false } = {}) {
    const look = S.look;
    if (!look) return;
    const order = { free: 0, pro: 1, community: 2 };
    const packs = [...look.packs].sort((a, b) => (order[a.source === 'community' ? 'community' : a.tier] - order[b.source === 'community' ? 'community' : b.tier]));
    body.replaceChildren(
      proCard(look),
      h('div', { class: 'pack-grid' }, packs.map((p) => tile(p, look))),
      h('p', { class: 'field-hint' }, 'Click a pack to try it on your bays. Packs only change looks and sounds; your deploys work the same. Drop a .ploinkpack file on the window to add a community pack.'),
    );
    if (focusKey) body.querySelector('.pro-card input')?.focus();
  }

  openModal((sheet) => {
    sheet.append(
      h('div', { class: 'sheet-head' }, h('h2', {}, 'Button packs'), h('div', { class: 'grow' }), h('button', { class: 'keycap small', onclick: () => closeModal(), title: 'Close' }, ICON.x())),
      body,
    );
  }, { kind: 'look', onClose: () => { S.lookSheet = null; endPreview(); } });
  S.lookSheet = { render };
  render();
}

// ---------------------------------------------------------------- events from main
api.on((evt) => {
  switch (evt.type) {
    case 'projects':
      S.projects = evt.projects;
      renderDeck();
      ensureColors();
      if (S.drawer.open) renderDrawerHead();
      break;
    case 'run': onRun(evt.run); break;
    case 'log': onLog(evt); break;
    case 'activity': onActivity(evt.event); break;
    case 'mcp': S.mcp = evt.mcp; updateLamps(); break;
    case 'project-added': setTimeout(() => celebrateInstall(evt.id), 150); break;
    case 'open-settings': openSettings({ focus: evt.focus }); break;
    case 'look': setLook(evt.look); break;
    case 'usage': S.usage = evt.usage; renderUsageLamps(); break;
    case 'add-project': if (!S.modal) addViaPicker(); break;
    case 'open-run': {
      const p = Object.values(S.latest).find((r) => r?.id === evt.runId) || Object.values(S.actions).flatMap((m) => Object.values(m)).find((r) => r?.id === evt.runId);
      if (p) openDrawer(p.projectId, evt.runId);
      break;
    }
    case 'mcp-unauthorized':
      S.mcpUnauthorized = evt;
      toast(evt.hadToken ? 'An agent used a revoked or wrong Ploink token. Copy a fresh setup line in Settings > Agents.' : 'An agent tried to connect without a token. Open Settings > Agents to set it up again.', 'warn', 8000);
      break;
    case 'summoned':
      document.body.classList.remove('booting', 'summon');
      void document.body.offsetWidth;
      document.body.classList.add('booting', 'summon');
      setTimeout(() => document.body.classList.remove('booting', 'summon'), 900);
      break;
    case 'settings':
      S.settings = evt.settings;
      configureAudio(S.settings);
      applyLook();
      updateLamps();
      break;
    case 'open-log': openDrawer(evt.projectId, evt.runId); break;
    case 'edit-project': {
      const p = S.projects.find((x) => x.id === evt.projectId);
      if (p) openEditor(p);
      break;
    }
  }
});

// ---------------------------------------------------------------- boot
setInterval(() => { for (const bay of S.bays.values()) updateLcd(bay); if (S.drawer.open) { const r = S.latest[S.drawer.projectId]; if (r && ACTIVE.has(r.status)) renderDrawerHead(); } }, 1000);

const state = await api.getState();
Object.assign(S, { projects: state.projects, settings: state.settings, latest: state.latest || {}, actions: state.actions || {}, mcp: state.mcp || {}, shortcut: state.shortcut || {}, appPath: state.appPath || '', version: state.version });
S.look = state.look || null;
applyPack(S.look?.pack);
updateBrand();
updateLogWords();
configureAudio(S.settings);
applyLook();
buildDrawer();
renderDeck({ initial: true });
updateLamps();
ensureColors();
primeLogDot();
S.usage = (await api.getUsage?.()) || null;
renderUsageLamps();
setTimeout(() => document.body.classList.remove('booting'), 900);
if (S.shortcut?.ok === false) toast(S.shortcut.error + ' Pick another one in settings.', 'warn', 6000);
