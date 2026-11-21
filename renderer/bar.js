// The launch bar renderer: mini launch buttons, hover bubbles, and result announcements.
import { h, capVars, colorFromName, monogram, ago, clock, dur, placeLeds } from './util.js';
import { sfx, configure as configureAudio, unlock as unlockAudio } from './audio.js';
import * as fx from './fx.js';
import { commandSummary, looksLikeDryRun } from './steps.js';
import { applyPack, capColor, capShape, packOutline, readoutStyle, glyphText, word } from './look.js';

const api = window.ploink || (await import('./mock.js')).mockBridge;
const $ = (sel) => document.querySelector(sel);
const LEDS = 16;
const ACTIVE = new Set(['starting', 'running', 'awaiting_approval']);

const S = {
  projects: [],
  settings: {},
  latest: {},
  layout: null,
  shown: false,
  caps: new Map(),
  holding: null,
  hoverId: null,
  announce: null, // { runId, projectId, status, timer }
  pending: new Map(), // projectId -> fx to play once the bar is on screen
  interactive: false,
};

const body = document.body;
const track = $('#track');
const plate = $('#plate');
const bubble = $('#bubble');

// ---------------------------------------------------------------- layout
function applyLayout(layout) {
  S.layout = layout;
  const edge = layout?.edge || 'bottom';
  body.classList.remove('edge-bottom', 'edge-top', 'edge-left', 'edge-right', 'edge-notch');
  body.classList.add(`edge-${edge}`);
  body.classList.toggle('vertical', edge === 'left' || edge === 'right');
  body.classList.toggle('cockpit', layout?.style === 'cockpit');
  body.style.setProperty('--cs', `${layout?.cap || 50}px`);
  body.style.setProperty('--thick', `${layout?.thick || 84}px`);
  body.style.setProperty('--menu-h', `${layout?.edge === 'notch' ? Math.max(layout.menuH || 0, 26) : 0}px`);
  body.style.setProperty('--notch-w', `${layout?.notchW || 200}px`);
}

function applyLook() {
  const shape = packOutline() || (S.settings.buttonShape === 'square' ? 'square' : 'round');
  body.classList.toggle('shape-square', shape === 'square');
  body.classList.toggle('labels', S.settings.barLabels !== false);
  body.style.setProperty('--icon-scale', String(S.settings.iconScale ?? 0.5));
  const half = (S.layout?.cap || 50) / 2 + 9;
  for (const cap of S.caps.values()) placeLeds(cap.leds, shape, half);
}

// ---------------------------------------------------------------- show / hide
let settleTimer = null;
function setShown(on) {
  if (on === S.shown) return;
  S.shown = on;
  clearTimeout(settleTimer);
  if (on) {
    body.classList.remove('leaving', 'settled');
    void body.offsetWidth;
    body.classList.add('shown');
    sfx.whoosh(false);
    if (body.classList.contains('cockpit')) setTimeout(() => sfx.thunk(), 430);
    settleTimer = setTimeout(() => { body.classList.add('settled'); flushPending(); }, body.classList.contains('cockpit') ? 700 : 520);
  } else {
    body.classList.remove('settled');
    body.classList.add('leaving');
    body.classList.remove('shown');
    hideBubble(true);
    setInteractive(false);
    sfx.whoosh(true);
  }
}

function setInteractive(on) {
  if (S.interactive === on) return;
  S.interactive = on;
  api.barInteractive?.(on);
}

// ---------------------------------------------------------------- caps
// ---------------------------------------------------------------- AI usage gauges
const pad2 = (n) => String(n).padStart(2, '0');
function whenText(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return ms - Date.now() < 20 * 3600e3 ? t : `${d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()} ${t}`;
}
function gaugeModel(u) {
  const now = Date.now();
  const live = (u.windows || []).filter((w) => !w.reset);
  const head = live.reduce((a, w) => (!a || w.used > a.used ? w : a), null);
  let tone = 'ok';
  if (!head || u.state !== 'ok') tone = 'off';
  else if (u.reached || head.used >= 90) tone = 'bad';
  else if (head.used >= 70 || live.some((w) => w.minutes && w.resetsAt && w.used / 100 > 1 - (w.resetsAt - now) / (w.minutes * 60000) + 0.15)) tone = 'warn';
  return { head, tone, value: head ? Math.round(head.used) : null };
}
const gaugeEls = new Map();
function renderGauges() {
  const cockpit = body.classList.contains('cockpit');
  const box = cockpit ? $('#ch-gauges') : $('#gauges');
  const other = cockpit ? $('#gauges') : $('#ch-gauges');
  const list = ['claude', 'codex'].map((k) => S.usage?.[k]).filter((u) => u && u.available && S.settings.usage?.[u.provider] !== false);
  for (const u of list) {
    let el = gaugeEls.get(u.provider);
    if (!el) { el = createGauge(u.provider); gaugeEls.set(u.provider, el); }
    const m = gaugeModel(u);
    el.className = `gauge tone-${m.tone}`;
    el.style.setProperty('--p', m.value ?? 0);
    const short = u.provider === 'claude' ? 'CL' : 'CX';
    el.querySelector('.g-val').textContent = m.value == null ? (u.state === 'setup' ? '+' : '–') : String(m.value);
    el.querySelector('.g-lab').textContent = m.head ? `${short}·${m.head.label}` : short;
    el.querySelector('.g-text').textContent = m.head ? `${u.name} ${m.head.label} ${m.value}%` : `${u.name} ${u.state === 'setup' ? 'SET UP' : '—'}`;
    el.querySelector('.g-meter i').style.width = `${Math.min(100, m.value ?? 0)}%`;
  }
  const want = list.map((u) => gaugeEls.get(u.provider));
  if (want.some((el, i) => box.children[i] !== el) || box.children.length !== want.length) box.replaceChildren(...want);
  if (other.children.length) other.replaceChildren();
  body.classList.toggle('has-gauges', list.length > 0);
}
function gaugeBubble(provider) {
  const u = S.usage?.[provider];
  const el = gaugeEls.get(provider);
  if (!u || !el || !S.shown || S.announce || FIND.q) return;
  const m = gaugeModel(u);
  const lines = [];
  if (u.state === 'setup') lines.push(h('div', { class: 'line' }, 'Not connected yet.'), h('div', { class: 'hint' }, 'click to connect Claude Code in settings'));
  else if (!m.head) lines.push(h('div', { class: 'line' }, u.state === 'stale' ? `Couldn't read ${u.provider === 'claude' ? 'Claude Code' : 'Codex'} usage. Is it signed in?` : `Checking ${u.provider === 'claude' ? 'Claude Code' : 'Codex'}…`), h('div', { class: 'hint' }, 'click to retry · hold to open the usage page'));
  else {
    for (const w of u.windows) lines.push(h('div', { class: 'line' }, w.reset ? `${w.label}  reset · new figure after next use` : `${w.label}  ${Math.round(w.used)}% used · resets ${whenText(w.resetsAt)}`));
    const age = u.updatedAt ? Math.max(0, Math.round((Date.now() - u.updatedAt) / 60000)) : null;
    lines.push(h('div', { class: 'hint' }, `${u.reached ? 'LIMIT REACHED · ' : ''}${u.source || ''}${age != null ? ` · ${age ? age + 'm ago' : 'just now'}` : ''} · hold to open`));
  }
  bubble.className = `bubble ${m.tone === 'off' ? '' : 'tone-' + m.tone}`;
  bubble.replaceChildren(h('div', { class: 'vfd' }, h('span', {}, `${u.name}${m.head ? ` ${m.head.label} ${m.value}%` : ''}`), h('span', {}, m.head ? whenText(m.head.resetsAt) : '')), ...lines);
  placeBubble({ btn: el });
  requestAnimationFrame(() => bubble.classList.add('show'));
}
function createGauge(provider) {
  const el = h('button', { class: 'gauge', 'data-p': provider },
    h('span', { class: 'g-ring' }, h('span', { class: 'g-val' })),
    h('span', { class: 'g-lab' }),
    h('span', { class: 'g-text' }),
    h('span', { class: 'g-meter' }, h('i')),
  );
  let timer = 0, held = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    held = false;
    timer = setTimeout(() => { held = true; sfx.launch(); api.openUsage?.(provider); }, 650);
  });
  el.addEventListener('pointerup', async () => {
    clearTimeout(timer);
    if (held) return;
    sfx.click();
    if (S.usage?.[provider]?.state === 'setup') { api.openConsole?.({ settings: 'usage' }); return; }
    S.usage = (await api.refreshUsage?.()) || S.usage;
    renderGauges();
    gaugeBubble(provider);
  });
  el.addEventListener('pointerleave', () => { clearTimeout(timer); if (!S.announce && !FIND.q) hideBubble(); });
  el.addEventListener('pointerenter', () => gaugeBubble(provider));
  return el;
}

// ---------------------------------------------------------------- banks
// Main decides how many keys fit and sends the banks with the layout.
function banks() {
  const known = new Set(S.projects.map((p) => p.id));
  let list = (S.layout?.banks || []).map((b) => ({ name: b.name, ids: b.ids.filter((id) => known.has(id)) })).filter((b) => b.ids.length);
  if (!S.layout?.banks) {
    const max = S.mockMax || 10;
    const ids = S.projects.map((p) => p.id);
    list = [];
    for (let i = 0; i < ids.length; i += max) list.push({ name: ids.length > max ? String.fromCharCode(65 + i / max) : '', ids: ids.slice(i, i + max) });
  }
  const listed = new Set(list.flatMap((b) => b.ids));
  const missing = S.projects.filter((p) => !listed.has(p.id)).map((p) => p.id); // just added, not laid out yet
  if (missing.length) { if (list.length) list[list.length - 1].ids.push(...missing); else list.push({ name: '', ids: missing }); }
  return list.length ? list : [{ name: '', ids: [] }];
}
const bankLabel = (bk, i) => bk.name || String.fromCharCode(65 + i);

function switchBank(to, { sound = true } = {}) {
  const bk = banks();
  if (bk.length < 2) return;
  const next = ((to % bk.length) + bk.length) % bk.length;
  if (next === S.bank) return;
  const forward = next > S.bank;
  S.bank = next;
  try { localStorage.setItem('ploink.bank', String(next)); } catch { /* storage off */ }
  track.classList.remove('swap-f', 'swap-b');
  void track.offsetWidth;
  track.classList.add(forward ? 'swap-f' : 'swap-b');
  if (!FIND.q) hideBubble();
  render();
  if (sound) sfx.click();
}

function renderBankDial(bk) {
  const dial = $('#bankdial');
  const multi = bk.length > 1;
  body.classList.toggle('multi-bank', multi);
  if (!multi) return;
  const angle = -120 + (S.bank / (bk.length - 1)) * 240;
  dial.style.setProperty('--angle', `${angle}deg`);
  $('#bd-label').textContent = bankLabel(bk[S.bank], S.bank).slice(0, 8);
  dial.title = `Bank ${bankLabel(bk[S.bank], S.bank)} (${S.bank + 1} of ${bk.length}). Click for next, right-click for previous, or use ← →`;
  const head = $('#ch-bank');
  if (head) head.textContent = `BANK ${bankLabel(bk[S.bank], S.bank).toUpperCase()} · ${S.bank + 1}/${bk.length}`;
}

function render() {
  const seen = new Set();
  for (const p of S.projects) {
    let cap = S.caps.get(p.id);
    if (!cap) { cap = createCap(p); S.caps.set(p.id, cap); }
    cap.project = p;
    seen.add(p.id);
  }
  for (const [id, cap] of S.caps) if (!seen.has(id)) { cap.el.remove(); S.caps.delete(id); }
  const bk = banks();
  S.bank = Math.max(0, Math.min(S.bank, bk.length - 1));
  const ids = bk[S.bank].ids;
  ids.forEach((id, i) => {
    const cap = S.caps.get(id);
    cap.index = i;
    cap.el.style.setProperty('--n', i);
    updateCap(cap);
  });
  const want = ids.map((id) => S.caps.get(id).el);
  if (want.some((el, i) => track.children[i] !== el) || track.children.length !== want.length) track.replaceChildren(...want);
  renderBankDial(bk);
  const runningCount = Object.values(S.latest).filter((r) => r && (r.status === 'running' || r.status === 'starting')).length;
  body.classList.toggle('any-running', runningCount > 0);
  const lamp = document.getElementById('ch-lamp-label');
  if (lamp) lamp.textContent = runningCount ? `${runningCount} ${word('IN FLIGHT')}` : word('IDLE');
}

function createCap(p) {
  const leds = Array.from({ length: LEDS }, (_, i) => h('i', { class: 'led', vars: { '--i': i } }));
  const face = h('span', { class: 'mini-face' });
  const btn = h('button', { class: 'mini-cap' }, h('span', { class: 'mini-side' }), face);
  const key = h('span', { class: 'mini-key' });
  // which command a press runs, when the project has more than one (or the one it has is a dry run)
  const cmdTag = h('span', { class: 'mini-cmd' });
  const label = h('span', { class: 'mini-label' });
  const vfdName = h('span', { class: 'n' });
  const vfdStatus = h('span', { class: 's' });
  const vfd = h('div', { class: 'mini-vfd' }, vfdName, vfdStatus);
  const core = h('div', { class: 'mini-core' }, ...leds, btn, key, cmdTag);
  const el = h('div', { class: 'mini', 'data-id': p.id }, core, label, vfd);
  const cap = { project: p, el, btn, face, leds, key, cmdTag, label, vfd, vfdName, vfdStatus, index: 0, firedAt: 0 };
  placeLeds(leds, S.settings.buttonShape, (S.layout?.cap || 50) / 2 + 9);

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    unlockAudio();
    try { btn.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    beginHold(cap, 'pointer');
  });
  const up = () => { if (S.holding?.cap === cap && S.holding.via === 'pointer') endHold(); };
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('lostpointercapture', up);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); endHold(); api.barMenu?.(cap.project.id); });
  el.addEventListener('pointerenter', () => { S.hoverId = cap.project.id; if (!S.announce) showInfoBubble(cap); });
  el.addEventListener('pointerleave', () => { if (S.hoverId === cap.project.id) S.hoverId = null; if (!S.announce) hideBubble(); });
  return cap;
}

function medal(p) {
  const m = h('span', { class: 'mini-medal' });
  const mono = () => h('span', { class: 'mono' }, monogram(p.name));
  if (p.icon) {
    const img = h('img', { src: p.icon, alt: '', draggable: false });
    img.addEventListener('error', () => m.replaceChildren(mono()));
    m.append(img);
  } else m.append(mono());
  return m;
}

function updateCap(cap) {
  const p = cap.project;
  const run = S.latest[p.id];
  const { vars, tone } = capVars(capColor(p, cap.index));
  for (const [k, v] of Object.entries(vars)) cap.el.style.setProperty(k, v);
  cap.el.dataset.tone = tone;
  const solid = capShape(cap.index);
  if (solid && solid !== 'round' && solid !== 'square') cap.el.dataset.shape = solid; else delete cap.el.dataset.shape;
  const sig = (p.icon || '').slice(-48) + p.name;
  if (cap.face.dataset.sig !== sig) { cap.face.dataset.sig = sig; cap.face.replaceChildren(medal(p)); }
  cap.key.textContent = cap.index < 9 ? String(cap.index + 1) : cap.index === 9 ? '0' : '';
  if (cap.label.textContent !== p.name) cap.label.textContent = p.name;
  updateVfd(cap);
  const sel = p.commands.find((c) => c.id === p.activeCommandId) || p.commands[0];
  const dry = !!sel && looksLikeDryRun(sel.cmd, sel.label);
  const tag = sel && (p.commands.length > 1 || dry) ? sel.label : '';
  if (cap.cmdTag.textContent !== tag) cap.cmdTag.textContent = tag;
  cap.cmdTag.classList.toggle('dry', dry);
  cap.btn.setAttribute('aria-label', `${dry ? 'Dry run' : 'Deploy'} ${p.name}${tag ? ` (${tag})` : ''}. Press and hold.`);
  const s = run?.status;
  cap.el.classList.toggle('is-running', s === 'running' || s === 'starting');
  cap.el.classList.toggle('is-awaiting', s === 'awaiting_approval');
  cap.el.classList.toggle('last-ok', s === 'success' && !run.dryRun);
  cap.el.classList.toggle('last-bad', s === 'failed');
  cap.el.classList.toggle('no-command', !p.commands.length);
}

// cockpit readout under each button: name + short status
function updateVfd(cap) {
  const p = cap.project;
  const run = S.latest[p.id];
  const st = statusFor(p, run);
  let line = st.vfd;
  if (run?.status === 'running') line = `IN FLIGHT ${st.side}`;
  else if (run?.status === 'success' && run.dryRun && Date.now() - run.endedAt < 15 * 60e3) line = 'DRY RUN OK';
  else if (run?.status === 'success' && Date.now() - run.endedAt < 15 * 60e3) line = `SHIPPED ${dur(run.endedAt - run.startedAt).toUpperCase()}`;
  else if (run?.status === 'success') line = `✓ ${ago(run.endedAt).toUpperCase()}`;
  else if (!run && p.commands.length) line = 'READY';
  const tone = !p.commands.length ? 'off' : st.tone;
  line = word(line);
  const cls = `mini-vfd${tone ? ' tone-' + tone : ''}`;
  if (cap.vfd.className !== cls) cap.vfd.className = cls;
  if (cap.vfdName.textContent !== p.name) cap.vfdName.textContent = p.name;
  const sig = readoutStyle() + line;
  if (cap.vfdStatus.dataset.sig !== sig) {
    cap.vfdStatus.dataset.sig = sig;
    cap.vfdStatus.replaceChildren(readoutStyle() === 'glyph' ? glyphText(line) : line);
  }
}

const capCenter = (cap) => {
  const r = cap.btn.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
};

function restartClass(el, cls, ms) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  clearTimeout(el['_t' + cls]);
  if (ms) el['_t' + cls] = setTimeout(() => el.classList.remove(cls), ms);
}

// dock-style magnification
plate.addEventListener('pointermove', (e) => {
  const vertical = body.classList.contains('vertical');
  for (const cap of S.caps.values()) {
    const r = cap.el.getBoundingClientRect();
    const c = vertical ? r.top + r.height / 2 : r.left + r.width / 2;
    const d = Math.abs((vertical ? e.clientY : e.clientX) - c);
    const mag = 1 + 0.2 * Math.max(0, 1 - d / 140) ** 2;
    cap.el.style.setProperty('--mag', mag.toFixed(3));
  }
});
plate.addEventListener('pointerenter', () => setInteractive(true));
plate.addEventListener('pointerleave', () => {
  for (const cap of S.caps.values()) cap.el.style.setProperty('--mag', 1);
  if (!S.holding && !bubble.matches(':hover')) setInteractive(false);
});
bubble.addEventListener('pointerenter', () => setInteractive(true));
bubble.addEventListener('pointerleave', () => { if (!plate.matches(':hover')) setInteractive(false); });

// ---------------------------------------------------------------- bubble
function statusFor(p, run) {
  const cmd = p.commands.find((c) => c.id === p.activeCommandId) || p.commands[0];
  if (!cmd) return { tone: '', vfd: 'NO COMMAND', side: '', line: 'right-click › Edit bay' };
  if (!run) return { tone: '', vfd: 'READY', side: cmd.label.toUpperCase(), line: `$ ${commandSummary(cmd.cmd)}` };
  switch (run.status) {
    case 'awaiting_approval': return { tone: 'warn', vfd: 'AGENT REQUEST', side: 'HOLD = OK', line: run.reason ? `“${run.reason}”` : `wants to run ${run.commandLabel}` };
    case 'starting': return { tone: '', vfd: 'IGNITION', side: '00:00', line: run.cmd };
    case 'running': return { tone: '', vfd: 'IN FLIGHT', side: clock(Date.now() - run.startedAt), line: run.lastLine || run.cmd };
    case 'success':
      if (run.dryRun) return { tone: 'warn', vfd: 'DRY RUN OK', side: ago(run.endedAt).toUpperCase(), line: `nothing deployed · ${run.commandLabel}` };
      return { tone: 'ok', vfd: 'SHIPPED', side: ago(run.endedAt).toUpperCase(), line: `${run.commandLabel} · took ${dur(run.endedAt - run.startedAt)}` };
    case 'failed': return { tone: 'bad', vfd: `FAILED · EXIT ${run.exitCode ?? '?'}`, side: ago(run.endedAt).toUpperCase(), line: run.lastLine || 'open the log' };
    case 'cancelled': return { tone: 'warn', vfd: 'ABORTED', side: ago(run.endedAt).toUpperCase(), line: `$ ${commandSummary(cmd.cmd)}` };
    default: return { tone: '', vfd: 'READY', side: cmd.label.toUpperCase(), line: `$ ${commandSummary(cmd.cmd)}` };
  }
}

function placeBubble(cap) {
  // centred on the cap along the bar, clear of the plate across it
  const r = cap.btn.getBoundingClientRect();
  const pr = plate.getBoundingClientRect();
  const bw = bubble.offsetWidth;
  const bh = bubble.offsetHeight;
  const edge = S.layout?.edge || 'bottom';
  const gap = 12;
  let x, y;
  if (edge === 'bottom') { x = r.left + r.width / 2 - bw / 2; y = pr.top - bh - gap; }
  else if (edge === 'top' || edge === 'notch') { x = r.left + r.width / 2 - bw / 2; y = pr.bottom + gap; }
  else if (edge === 'left') { x = pr.right + gap; y = r.top + r.height / 2 - bh / 2; }
  else { x = pr.left - bw - gap; y = r.top + r.height / 2 - bh / 2; }
  x = Math.max(8, Math.min(window.innerWidth - bw - 8, x));
  y = Math.max(8, Math.min(window.innerHeight - bh - 8, y));
  bubble.style.transform = '';
  bubble.style.left = `${x}px`;
  bubble.style.top = `${y}px`;
}

function showInfoBubble(cap) {
  if (!S.shown) return;
  const p = cap.project;
  const st = statusFor(p, S.latest[p.id]);
  bubble.className = `bubble ${st.tone ? 'tone-' + st.tone : ''}`;
  bubble.replaceChildren(
    h('h3', {}, p.name),
    h('div', { class: 'vfd' }, h('span', {}, word(st.vfd)), h('span', {}, st.side)),
    h('div', { class: 'line' }, st.line),
    h('div', { class: 'hint' }, ACTIVE.has(S.latest[p.id]?.status) && S.latest[p.id].status !== 'awaiting_approval' ? 'click for the live log' : 'hold to launch · right-click for options'),
  );
  placeBubble(cap);
  requestAnimationFrame(() => bubble.classList.add('show'));
  bubble.dataset.for = p.id;
}

function refreshBubble() {
  if (S.announce) return renderAnnounce();
  if (!S.hoverId || !bubble.classList.contains('show')) return;
  const cap = S.caps.get(S.hoverId);
  if (cap) showInfoBubble(cap);
}

function hideBubble(force = false) {
  if (S.announce && !force) return;
  bubble.classList.remove('show');
}

// ---------------------------------------------------------------- announcements
function renderAnnounce() {
  const a = S.announce;
  if (!a) return;
  const cap = S.caps.get(a.projectId);
  if (!cap) return;
  const p = cap.project;
  const run = S.latest[p.id] || {};
  let tone = '', big = '', line = '', actions = [];
  if (a.status === 'success' && run.dryRun) {
    tone = 'warn'; big = 'DRY RUN OK';
    line = `nothing was deployed · ${run.commandLabel || ''} · ${dur((run.endedAt || 0) - (run.startedAt || 0))}`;
    actions = [h('button', { onclick: (e) => { e.stopPropagation(); openLog(p.id, a.runId); } }, 'View log')];
  } else if (a.status === 'success') {
    tone = 'ok'; big = word('SHIPPED') === 'SHIPPED' ? 'SHIPPED ✓' : word('SHIPPED');
    line = `${run.commandLabel || ''} · ${dur((run.endedAt || 0) - (run.startedAt || 0))}${run.source === 'agent' ? ' · by agent' : ''}`;
    actions = p.url ? [h('button', { onclick: (e) => { e.stopPropagation(); api.openUrl?.(/^https?:/.test(p.url) ? p.url : `https://${p.url}`); } }, 'Open site ↗')] : [];
  } else if (a.status === 'failed') {
    tone = 'bad'; big = word('FAILED');
    line = run.lastLine || `exit ${run.exitCode}`;
    actions = [h('button', { onclick: (e) => { e.stopPropagation(); openLog(p.id, a.runId); } }, 'View log')];
  } else if (a.status === 'awaiting_approval') {
    tone = 'warn'; big = 'AGENT REQUEST';
    line = run.reason ? `“${run.reason}”` : `wants to run ${run.commandLabel}`;
    actions = [h('button', { onclick: (e) => { e.stopPropagation(); api.deny(a.runId); sfx.denied(); } }, 'Deny')];
  }
  bubble.className = `bubble announce tone-${tone}`;
  bubble.replaceChildren(...[
    h('div', { class: 'big' }, big),
    h('h3', {}, p.name),
    h('div', { class: 'line' }, line),
    a.status === 'awaiting_approval' ? h('div', { class: 'hint' }, 'hold the glowing button to approve') : null,
    actions.length ? h('div', { class: 'actions' }, actions) : null,
  ].filter(Boolean));
  bubble.onclick = () => { if (a.status !== 'awaiting_approval') openLog(p.id, a.runId); };
  placeBubble(cap);
  requestAnimationFrame(() => bubble.classList.add('show'));
  for (const c of S.caps.values()) c.el.classList.toggle('dim', c !== cap);
  cap.el.classList.add('spot');
  cap.el.style.setProperty('--spot', tone === 'ok' ? 'var(--ok)' : tone === 'bad' ? 'var(--bad)' : 'var(--warn)');
}

function startAnnounce({ runId, projectId, status }) {
  endAnnounce(false);
  S.announce = { runId, projectId, status, timer: null };
  if (S.shown && body.classList.contains('settled')) renderAnnounce();
  if (status !== 'awaiting_approval') scheduleAnnounceEnd(status === 'failed' ? 9000 : 5200);
}

function scheduleAnnounceEnd(ms) {
  const a = S.announce;
  if (!a) return;
  clearTimeout(a.timer);
  a.timer = setTimeout(function check() {
    if (S.announce !== a) return;
    if (bubble.matches(':hover') || plate.matches(':hover')) { a.timer = setTimeout(check, 1200); return; }
    endAnnounce(true);
  }, ms);
}

function endAnnounce(release) {
  const a = S.announce;
  if (!a) return;
  clearTimeout(a.timer);
  S.announce = null;
  bubble.onclick = null;
  for (const c of S.caps.values()) { c.el.classList.remove('dim', 'spot'); }
  hideBubble(true);
  if (release) api.barRelease?.(`announce:${a.runId}`);
}

function openLog(projectId, runId) {
  endAnnounce(true);
  api.openConsole?.({ projectId, runId });
}

// ---------------------------------------------------------------- hold to launch
function beginHold(cap, via) {
  if (!cap || S.holding) return;
  const p = cap.project;
  const run = S.latest[p.id];
  const awaiting = run?.status === 'awaiting_approval';
  if (run && ACTIVE.has(run.status) && !awaiting) { openLog(p.id, run.id); return; }
  if (!p.commands.length) { api.openConsole?.({ projectId: p.id, edit: true }); return; }
  sfx.press();
  cap.el.classList.add('is-holding');
  api.barHold?.(true);
  const holdMs = Math.max(0, Number(S.settings.holdMs ?? 650));
  const state = { cap, via, start: performance.now(), lit: 0, fired: false, raf: 0, timer: 0, awaitingRunId: awaiting ? run.id : null };
  S.holding = state;
  if (holdMs < 40) { fire(state); return; }
  state.timer = setTimeout(() => { if (S.holding === state) fire(state); }, holdMs);
  const step = () => {
    if (S.holding !== state || state.fired) return;
    const t = Math.min(1, (performance.now() - state.start) / holdMs);
    const target = Math.min(LEDS, Math.floor(t * LEDS));
    while (state.lit < target) { cap.leds[state.lit].classList.add('charge'); sfx.tick(state.lit, LEDS); state.lit++; }
    cap.el.style.setProperty('--hold', t.toFixed(3));
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
  const { cap } = state;
  cap.el.classList.remove('is-holding');
  api.barHold?.(false);
  if (!state.fired) {
    sfx.release();
    const lit = cap.leds.filter((l) => l.classList.contains('charge')).reverse();
    lit.forEach((led, i) => setTimeout(() => led.classList.remove('charge'), i * 16));
  }
}

async function fire(state) {
  if (state.fired) return;
  state.fired = true;
  cancelAnimationFrame(state.raf);
  clearTimeout(state.timer);
  const { cap } = state;
  for (const led of cap.leds) led.classList.add('charge');
  ignite(cap);
  setTimeout(() => cap.leds.forEach((l) => l.classList.remove('charge')), 380);
  if (state.awaitingRunId) {
    endAnnounce(false);
    await api.approve(state.awaitingRunId);
  } else {
    const res = await api.deploy({ projectId: cap.project.id, commandId: cap.project.activeCommandId });
    if (res?.error) { sfx.fail(); restartClass(cap.el, 'just-failed', 1600); return; }
    if (res?.run) onRun(res.run);
  }
  // launched: let the user get back to work; the bar announces the result later
  setTimeout(() => api.barRelease?.('summon'), 1100);
}

function ignite(cap) {
  cap.firedAt = Date.now();
  restartClass(cap.el, 'launch', 500);
  const c = capCenter(cap);
  fx.celebrate('launch', c.x, c.y, capColor(cap.project, cap.index), { radius: c.r + 4 });
  sfx.launch();
}

function ghostPress(cap, audible) {
  if (Date.now() - cap.firedAt < 2000) return;
  cap.firedAt = Date.now();
  if (audible) sfx.press();
  cap.el.classList.add('is-holding');
  cap.leds.forEach((led, i) => setTimeout(() => { led.classList.add('charge'); if (audible) sfx.tick(i, LEDS); }, i * 18));
  setTimeout(() => {
    cap.el.classList.remove('is-holding');
    restartClass(cap.el, 'launch', 500);
    const c = capCenter(cap);
    fx.celebrate('launch', c.x, c.y, capColor(cap.project, cap.index), { radius: c.r + 4 });
    if (audible) sfx.launch();
    setTimeout(() => cap.leds.forEach((l) => l.classList.remove('charge')), 380);
  }, LEDS * 18 + 60);
}

// ---------------------------------------------------------------- run events
function onRun(run) {
  if (run.actionId) return; // action keys live in the console; the bar menu reads them from main
  const prev = S.latest[run.projectId];
  if (prev && prev.id !== run.id && prev.createdAt > run.createdAt) return;
  const prevStatus = prev && prev.id === run.id ? prev.status : null;
  S.latest[run.projectId] = { ...(prev && prev.id === run.id ? prev : {}), ...run };
  // an approval request that was approved, denied or expired ends its announcement
  if (S.announce?.runId === run.id && S.announce.status === 'awaiting_approval' && run.status !== 'awaiting_approval') endAnnounce(true);
  const cap = S.caps.get(run.projectId);
  if (cap) {
    updateCap(cap);
    if (run.status !== prevStatus) transition(cap, prevStatus, run);
  }
  render();
  refreshBubble();
}

function transition(cap, prevStatus, run) {
  const audible = run.voice === 'bar' || api.isMock;
  const s = run.status;
  if ((s === 'starting' || s === 'running') && (!prevStatus || prevStatus === 'awaiting_approval') && run.source !== 'user') {
    if (S.shown) ghostPress(cap, audible);
  } else if ((s === 'success' || s === 'failed') && prevStatus) {
    queueResult(cap.project.id, s, audible);
  }
}

function queueResult(projectId, status, audible) {
  const play = () => {
    const cap = S.caps.get(projectId);
    if (!cap) return;
    const c = capCenter(cap);
    if (status === 'success' && S.latest[projectId]?.dryRun) {
      // no confetti for a rehearsal
      if (audible) { sfx.tick(18, 24); setTimeout(() => sfx.tick(22, 24), 90); }
    } else if (status === 'success') {
      restartClass(cap.el, 'just-success', 5200);
      fx.celebrate('success', c.x, c.y, capColor(cap.project, cap.index), { text: S.latest[projectId]?.cmd });
      if (audible) sfx.success();
    } else {
      restartClass(cap.el, 'just-failed', 2200);
      fx.celebrate('fail', c.x, c.y, null, { text: S.latest[projectId]?.cmd, label: `${cap.project.name} could not be deployed.` });
      if (audible) sfx.fail();
    }
  };
  if (S.shown && body.classList.contains('settled')) play();
  else if (audible) S.pending.set(projectId, play); // main is about to slide the bar in to announce it
}

function flushPending() {
  if (S.announce) renderAnnounce();
  for (const [, play] of S.pending) play();
  S.pending.clear();
  if (S.announce?.status === 'awaiting_approval') sfx.request();
}

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  body.classList.add('keyboard');
  if (e.key === 'Escape') {
    if (FIND.q) { clearFind(); return; }
    endAnnounce(true);
    api.barRelease?.('summon');
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^[0-9]$/.test(e.key)) {
    e.preventDefault();
    if (e.repeat) return;
    const ids = banks()[S.bank]?.ids || [];
    const id = ids[e.key === '0' ? 9 : Number(e.key) - 1];
    if (id) beginHold(S.caps.get(id), 'key:' + e.key);
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ']') { e.preventDefault(); switchBank(S.bank + 1); return; }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === '[') { e.preventDefault(); switchBank(S.bank - 1); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.repeat || !FIND.match) return;
    const cap = S.caps.get(FIND.match.id);
    if (cap) beginHold(cap, 'key:Enter');
    return;
  }
  if (findKey(e)) e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (S.holding?.via === 'key:' + e.key) {
    const fired = S.holding.fired;
    endHold();
    if (fired && e.key === 'Enter') clearFind();
  }
});
window.addEventListener('blur', () => { endHold(); body.classList.remove('keyboard'); clearFind(); });

// scroll over the bar flips banks
let wheelAcc = 0, wheelLock = 0;
plate.addEventListener('wheel', (e) => {
  if (banks().length < 2) return;
  e.preventDefault();
  wheelAcc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (Date.now() < wheelLock || Math.abs(wheelAcc) < 40) return;
  switchBank(S.bank + (wheelAcc > 0 ? 1 : -1));
  wheelAcc = 0;
  wheelLock = Date.now() + 380;
}, { passive: false });
$('#bankdial').addEventListener('click', () => switchBank(S.bank + 1));
$('#bankdial').addEventListener('contextmenu', (e) => { e.preventDefault(); switchBank(S.bank - 1); });

// ---------------------------------------------------------------- type to find
const FIND = { q: '', match: null, timer: 0 };
const initialsOf = (name) => String(name).split(/[\s\-_.]+/).filter(Boolean).map((w) => w[0]).join('').toLowerCase();
function findKey(e) {
  if (e.key === 'Backspace') {
    if (!FIND.q) return false;
    FIND.q = FIND.q.slice(0, -1);
    updateFind();
    return true;
  }
  if (e.key.length === 1 && /[a-z .\-_]/i.test(e.key) && !(e.key === ' ' && !FIND.q)) {
    FIND.q += e.key.toLowerCase();
    updateFind();
    return true;
  }
  return false;
}
function updateFind() {
  clearTimeout(FIND.timer);
  if (!FIND.q) { clearFind(); return; }
  if (S.announce) endAnnounce(true);
  const q = FIND.q;
  const ranked = S.projects.map((p, i) => {
    const n = p.name.toLowerCase();
    const words = n.split(/[\s\-_.]+/);
    const score = n.startsWith(q) ? 0 : words.some((w) => w.startsWith(q)) ? 1 : n.includes(q) ? 2 : initialsOf(p.name).startsWith(q) ? 3 : 9;
    return { p, score, i };
  }).filter((x) => x.score < 9).sort((a, b) => a.score - b.score || a.i - b.i);
  FIND.match = ranked[0]?.p || null;
  if (FIND.match) {
    const bi = banks().findIndex((b) => b.ids.includes(FIND.match.id));
    if (bi >= 0 && bi !== S.bank) switchBank(bi, { sound: false });
  }
  for (const cap of S.caps.values()) {
    cap.el.classList.toggle('dim', !!FIND.match && cap.project.id !== FIND.match.id);
    cap.el.classList.toggle('found', FIND.match?.id === cap.project.id);
  }
  sfx.tick(Math.min(q.length, 12), 14);
  showFindBubble();
  FIND.timer = setTimeout(clearFind, 7000);
}
function showFindBubble() {
  const anchor = FIND.match ? S.caps.get(FIND.match.id) : [...S.caps.values()].find((c) => c.el.isConnected);
  if (!anchor || !S.shown) return;
  bubble.className = `bubble find ${FIND.match ? '' : 'tone-bad'}`;
  bubble.replaceChildren(
    h('div', { class: 'vfd' }, h('span', {}, `FIND ${FIND.q.toUpperCase()}▌`), h('span', {}, FIND.match ? 'MATCH' : 'NO MATCH')),
    FIND.match ? h('h3', {}, FIND.match.name) : h('div', { class: 'line' }, 'keep typing, or backspace'),
    h('div', { class: 'hint' }, FIND.match ? 'hold ⏎ to launch · esc to clear' : 'esc to clear'),
  );
  placeBubble(anchor);
  requestAnimationFrame(() => bubble.classList.add('show'));
}
function clearFind() {
  clearTimeout(FIND.timer);
  if (!FIND.q && !FIND.match) return;
  FIND.q = '';
  FIND.match = null;
  for (const cap of S.caps.values()) cap.el.classList.remove('dim', 'found');
  if (!S.announce) hideBubble();
}
window.addEventListener('pointerdown', unlockAudio, { capture: true });
$('#style-switch').addEventListener('click', async () => {
  sfx.click();
  const style = body.classList.contains('cockpit') ? 'mini' : 'cockpit';
  if (api.isMock) { applyLayout({ ...S.layout, style, cap: style === 'cockpit' ? 72 : 50, thick: style === 'cockpit' ? 196 : 84 }); render(); applyLook(); return; }
  await api.saveSettings({ bar: { style } });
});
$('#knob').addEventListener('click', () => { sfx.click(); endAnnounce(true); api.openConsole?.({}); });

// ---------------------------------------------------------------- events from main
api.on((evt) => {
  switch (evt.type) {
    case 'projects': S.projects = evt.projects; render(); break;
    case 'run': onRun(evt.run); break;
    case 'log': {
      const run = S.latest[evt.projectId];
      if (run && run.id === evt.runId) { run.lastLine = evt.lastLine; if (S.hoverId === evt.projectId) refreshBubble(); }
      break;
    }
    case 'settings': S.settings = evt.settings; configureAudio(S.settings); applyLook(); renderGauges(); break;
    case 'look': applyPack(evt.look?.pack); applyLook(); render(); break;
    case 'bar:layout': applyLayout(evt.layout); render(); applyLook(); renderGauges(); break;
    case 'usage': S.usage = evt.usage; renderGauges(); break;
    case 'bar:show':
      setShown(true);
      if (evt.reason === 'summon') { body.classList.add('keyboard'); window.focus(); }
      break;
    case 'bar:hide': endAnnounce(false); S.pending.clear(); setShown(false); body.classList.remove('keyboard'); break;
    case 'bar:announce': startAnnounce(evt); if (S.shown && body.classList.contains('settled')) flushPending(); break;
  }
});

setInterval(() => {
  if (S.hoverId || S.announce) refreshBubble();
  if (body.classList.contains('cockpit')) for (const cap of S.caps.values()) updateVfd(cap);
}, 1000);

// ---------------------------------------------------------------- boot
const state = await api.getState();
S.projects = state.projects;
S.settings = state.settings;
S.latest = state.latest || {};
applyPack(state.look?.pack);
configureAudio(S.settings);
try { S.bank = Number(localStorage.getItem('ploink.bank')) || 0; } catch { S.bank = 0; }
const qs = new URLSearchParams(location.search);
S.mockMax = Number(qs.get('max')) || 0;
const mockCockpit = qs.get('style') === 'cockpit';
applyLayout((await api.barLayout?.()) || { edge: qs.get('edge') || 'bottom', style: mockCockpit ? 'cockpit' : 'mini', cap: mockCockpit ? 72 : 50, thick: mockCockpit ? 196 : 84, menuH: 32, notchW: 200 });
render();
applyLook();
S.usage = (await api.getUsage?.()) || null;
renderGauges();
if (api.isMock) {
  // fake desktop so the transparent bar can be judged in a browser
  document.documentElement.style.background = 'radial-gradient(120% 90% at 30% 20%, #3b4a6b, #1b2133 55%, #0e1019)';
  setShown(true);
}
