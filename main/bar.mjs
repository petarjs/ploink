// The launch bar: a slim, always-on-top strip of mini buttons that slides in from a
// screen edge (or grows out of the notch) on whatever display the mouse is on.
//
// Visibility is reference-counted with "reasons". The bar stays up while any reason
// holds it: 'summon' (shortcut), 'edge' (mouse at the screen edge), 'hover', 'hold',
// 'menu', 'always', 'announce:<runId>', 'approval:<runId>'.
import { BrowserWindow, screen, ipcMain, Menu } from 'electron';
import path from 'node:path';

const CAP = { small: 40, medium: 50, large: 60 };
const CAP_COCKPIT = { small: 60, medium: 72, large: 86 };
const NOTCH_W = 200;
const STICKY = ['summon', 'edge', 'hover', 'hold', 'menu'];

export function createBar({ root, preload, store, hooks }) {
  let win = null;
  let visible = false;
  let hideTimer = null;
  let layout = null;
  let displayId = null;
  let poll = null;
  let edgeSince = 0;
  let outsideSince = 0;
  let awaySince = 0;
  const reasons = new Set();

  const cfg = () => store.settings.bar;
  const enabled = () => !!cfg().enabled;

  function send(type, payload = {}) {
    if (win && !win.isDestroyed()) win.webContents.send('ploink:event', { type, ...payload });
  }

  function create() {
    if (win && !win.isDestroyed()) return;
    win = new BrowserWindow({
      width: 800,
      height: 300,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      roundedCorners: false,
      type: 'panel',
      alwaysOnTop: true,
      title: 'Ploink bar',
      webPreferences: {
        preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.loadFile(path.join(root, 'renderer/bar.html'));
    win.on('blur', () => { if (reasons.has('summon')) release('summon'); });
    win.on('closed', () => { win = null; visible = false; });
  }

  const cursor = () => screen.getCursorScreenPoint();
  const cursorDisplay = () => screen.getDisplayNearestPoint(cursor());

  // Two styles. "mini": a floating strip. "cockpit": a bigger console with readouts
  // under each button that rises flush from the screen edge.
  //
  // Many projects: first shrink the keys (like the Dock), then split into banks.
  // Projects can also be put in named banks ("Clients", "Side projects").
  function computeLayout(display) {
    const { edge, size } = cfg();
    const style = cfg().style === 'cockpit' ? 'cockpit' : 'mini';
    const cockpit = style === 'cockpit';
    const labels = store.settings.barLabels !== false;
    const horizontal = edge !== 'left' && edge !== 'right';
    const b = display.bounds;
    const wa = display.workArea;
    const menuH = Math.max(0, wa.y - b.y);
    const hasNotch = menuH >= 31 && b.y === 0 && display.internal !== false;

    // group by bank name, in the order banks first appear
    const groupsMap = new Map();
    for (const p of store.projects) {
      const key = p.bank || '';
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key).push(p.id);
    }
    const groups = [...groupsMap].map(([name, ids]) => ({ name, ids }));
    const userBanks = groups.length > 1;
    const biggest = Math.max(1, ...groups.map((g) => g.ids.length));

    const gauges = cockpit ? 0 : (hooks.gaugeCount?.() || 0);
    const slotFor = (cap) => (cockpit ? (horizontal ? cap + 62 : cap + 24 + 52) : cap + 24 + (labels ? (horizontal ? 10 : 16) : 0));
    const fixedLen = (withBankDial) => (cockpit ? 80 : 32) + (cockpit ? 62 : 52) + 40 + gauges * 46 + (withBankDial ? 50 : 0);
    const maxLen = horizontal ? (cockpit && edge === 'bottom' ? b.width : wa.width) - 60 : wa.height - 60 - (cockpit ? 60 : 0);
    const ladder = cockpit ? [86, 72, 60] : [60, 50, 40];
    let idx = { large: 0, medium: 1, small: 2 }[size] ?? 1;
    let cap; let slot; let maxKeys;
    for (; idx < ladder.length; idx++) {
      cap = ladder[idx];
      slot = slotFor(cap);
      maxKeys = Math.floor((maxLen - fixedLen(userBanks)) / slot);
      if (maxKeys >= biggest) break;
    }
    if (idx >= ladder.length) { idx = ladder.length - 1; maxKeys = Math.floor((maxLen - fixedLen(true)) / slot); }
    maxKeys = Math.max(1, Math.min(maxKeys, 10));

    const banks = [];
    for (const g of groups) {
      if (g.ids.length <= maxKeys) { banks.push({ name: g.name, ids: g.ids }); continue; }
      const pages = Math.ceil(g.ids.length / maxKeys);
      for (let i = 0; i < pages; i++) banks.push({ name: g.name ? `${g.name} ${i + 1}` : '', ids: g.ids.slice(i * maxKeys, (i + 1) * maxKeys) });
    }
    if (!userBanks && banks.length > 1) banks.forEach((bk, i) => { bk.name = String.fromCharCode(65 + i); });
    const n = Math.max(1, ...banks.map((bk) => bk.ids.length));
    const plateLen = fixedLen(banks.length > 1) + n * slot;
    const thick = cockpit ? (horizontal ? cap + 24 + 48 + 52 : cap + 84) : cap + 34 + (labels && horizontal ? 14 : 0);

    let bounds;
    if (horizontal) {
      const maxW = cockpit && edge === 'bottom' ? b.width : wa.width - 8;
      const width = Math.min(maxW, plateLen + 260);
      const height = thick + (edge === 'notch' ? menuH : cockpit ? 0 : 12) + 200;
      const x = Math.round(b.x + (b.width - width) / 2);
      let y;
      if (edge === 'bottom') y = cockpit ? b.y + b.height - height : wa.y + wa.height - height; // cockpit sits flush on the screen edge
      else if (edge === 'top') y = wa.y;
      else y = b.y;
      bounds = { x, y, width, height };
    } else {
      const height = Math.min(wa.height - 8, plateLen + 120);
      const width = thick + (cockpit ? 0 : 12) + 300;
      const y = Math.round(wa.y + (wa.height - height) / 2);
      const left = cockpit ? b.x : wa.x;
      const right = cockpit ? b.x + b.width : wa.x + wa.width;
      const x = edge === 'left' ? left : right - width;
      bounds = { x, y, width, height };
    }
    return { edge, size, style, cap, thick, plateLen, horizontal, menuH, hasNotch, notchW: NOTCH_W, bounds, displayId: display.id, banks, maxKeys, gauges };
  }

  function place(display) {
    create();
    layout = computeLayout(display);
    displayId = display.id;
    win.setBounds(layout.bounds);
    send('bar:layout', { layout });
  }

  function show(reason, { focus = false, display = null } = {}) {
    if (!enabled()) return;
    create();
    reasons.add(reason);
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!visible) {
      place(display || cursorDisplay());
      visible = true;
      if (focus) { win.show(); win.focus(); } else win.showInactive();
    } else if (focus) {
      win.show();
      win.focus();
    }
    send('bar:show', { reason });
  }

  function release(reason) {
    reasons.delete(reason);
    maybeHide();
  }

  function maybeHide() {
    if (!visible || hideTimer) return;
    if (cfg().visibility === 'always' && enabled()) return;
    if (reasons.size) return;
    hideTimer = setTimeout(() => {
      send('bar:hide');
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (reasons.size && enabled()) { send('bar:show', { reason: 'resume' }); return; }
        visible = false;
        for (const r of STICKY) reasons.delete(r);
        if (win && !win.isDestroyed()) {
          win.setIgnoreMouseEvents(true, { forward: true });
          win.hide();
        }
      }, 360);
    }, 30);
  }

  function hideNow() {
    reasons.clear();
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!visible) return;
    send('bar:hide');
    visible = false;
    setTimeout(() => win && !win.isDestroyed() && !visible && win.hide(), 360);
  }

  function relocate(display) {
    if (!visible) { place(display); return; }
    send('bar:hide');
    setTimeout(() => {
      place(display);
      send('bar:show', { reason: 'relocate' });
    }, 340);
  }

  // ---- mouse polling: hot edge reveal, and "always" mode following the mouse between displays
  function atEdge(p, d) {
    const { edge } = cfg();
    const b = d.bounds;
    const l = computeLayout(d);
    const bx = l.bounds;
    const inX = p.x >= bx.x && p.x <= bx.x + bx.width;
    const inY = p.y >= bx.y && p.y <= bx.y + bx.height;
    switch (edge) {
      case 'bottom': return p.y >= b.y + b.height - 2 && inX;
      case 'top': return p.y <= b.y + 1 && inX;
      case 'notch': return p.y <= b.y + Math.max(l.menuH, 6) && Math.abs(p.x - (b.x + b.width / 2)) <= NOTCH_W / 2 + 24;
      case 'left': return p.x <= b.x + 1 && inY;
      case 'right': return p.x >= b.x + b.width - 2 && inY;
      default: return false;
    }
  }

  function nearBar(p) {
    if (!layout) return false;
    const bx = layout.bounds;
    const m = 24;
    const { edge, thick, menuH } = layout;
    const band = thick + 40 + (edge === 'notch' ? menuH : 0);
    if (p.x < bx.x - m || p.x > bx.x + bx.width + m || p.y < bx.y - m || p.y > bx.y + bx.height + m) return false;
    if (edge === 'bottom') return p.y >= bx.y + bx.height - band;
    if (edge === 'top' || edge === 'notch') return p.y <= bx.y + band;
    if (edge === 'left') return p.x <= bx.x + band;
    return p.x >= bx.x + bx.width - band;
  }

  function tick() {
    if (!enabled()) return;
    const p = cursor();
    const d = screen.getDisplayNearestPoint(p);
    const mode = cfg().visibility;
    const now = Date.now();
    if (mode === 'always') {
      if (d.id !== displayId && !reasons.has('hold') && !reasons.has('hover')) {
        awaySince ||= now;
        if (now - awaySince > 700) { awaySince = 0; relocate(d); }
      } else awaySince = 0;
      return;
    }
    if (mode !== 'edge') return;
    if (!reasons.has('edge')) {
      if (atEdge(p, d)) {
        edgeSince ||= now;
        if (now - edgeSince > 90) { edgeSince = 0; show('edge', { display: d }); }
      } else edgeSince = 0;
    } else if (!nearBar(p) && !reasons.has('hover') && !reasons.has('hold') && !reasons.has('menu')) {
      outsideSince ||= now;
      if (now - outsideSince > 420) { outsideSince = 0; release('edge'); }
    } else outsideSince = 0;
  }

  function startPolling() {
    clearInterval(poll);
    poll = null;
    const mode = cfg().visibility;
    if (enabled() && (mode === 'edge' || mode === 'always')) poll = setInterval(tick, 80);
  }

  // ---- IPC from the bar renderer
  ipcMain.handle('bar:interactive', (_e, on) => {
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!on, { forward: true });
    if (on) reasons.add('hover');
    else release('hover');
  });
  ipcMain.handle('bar:hold', (_e, on) => { if (on) reasons.add('hold'); else release('hold'); });
  ipcMain.handle('bar:release', (_e, reason) => release(String(reason)));
  ipcMain.handle('bar:layout', () => layout);
  ipcMain.handle('bar:console', (_e, opts = {}) => {
    release('summon');
    hooks.openConsole(opts);
  });
  ipcMain.handle('bar:menu', (_e, projectId) => {
    const p = store.getProject(projectId);
    if (!p || !win) return;
    const items = [{ label: p.name, enabled: false }, { type: 'separator' }];
    if (p.commands.length > 1) {
      items.push({ label: 'Button fires', enabled: false });
      for (const c of p.commands) {
        items.push({ label: `${c.label}   ${c.cmd}`, type: 'radio', checked: c.id === p.activeCommandId, click: () => hooks.setActiveCommand(p.id, c.id) });
      }
      items.push({ type: 'separator' });
    }
    if (p.actions?.length) {
      items.push({ label: 'Action keys', enabled: false });
      for (const a of p.actions) {
        const { live, last } = hooks.actionState(p.id, a.id);
        const label = a.trusted === false ? `Review ${a.label} (added by an agent)…`
          : live && a.kind === 'service' ? `■ Stop ${a.label}${live.url ? `   ${live.url}` : ''}`
            : live ? `${a.label}   running…`
              : `▶ ${a.label}${last?.value ? `   ${last.value}` : last?.status === 'failed' ? '   ✕' : ''}`;
        items.push({ label, enabled: !(live && a.kind !== 'service'), click: () => hooks.runAction(p.id, a.id) });
      }
      items.push({ type: 'separator' });
    }
    items.push({ label: 'Deploy log', click: () => { release('summon'); hooks.openConsole({ projectId: p.id }); } });
    items.push({ label: 'Edit bay…', click: () => { release('summon'); hooks.openConsole({ projectId: p.id, edit: true }); } });
    if (p.url) items.push({ label: 'Open website', click: () => hooks.openUrl(p.url) });
    items.push({ type: 'separator' }, { label: 'Open Ploink console', click: () => { release('summon'); hooks.openConsole({}); } });
    reasons.add('menu');
    Menu.buildFromTemplate(items).popup({ window: win, callback: () => release('menu') });
  });

  return {
    get visible() { return visible; },
    get focused() { return !!(win && visible && win.isFocused()); },
    send,
    toggleSummon() {
      if (!enabled()) return false;
      if (visible && (reasons.has('summon') || (win && win.isFocused()))) {
        release('summon');
        if (cfg().visibility === 'always' && win) win.blur();
      } else show('summon', { focus: true });
      return true;
    },
    announce(run) {
      if (!enabled()) return false;
      show(`announce:${run.id}`);
      send('bar:announce', { runId: run.id, projectId: run.projectId, status: run.status });
      return true;
    },
    request(run) {
      if (!enabled()) return false;
      show(`approval:${run.id}`);
      send('bar:announce', { runId: run.id, projectId: run.projectId, status: run.status });
      return true;
    },
    onRunUpdate(run) {
      if (run.status !== 'awaiting_approval' && reasons.has(`approval:${run.id}`)) release(`approval:${run.id}`);
    },
    projectsChanged() {
      if (visible) place(screen.getAllDisplays().find((d) => d.id === displayId) || cursorDisplay());
    },
    applySettings() {
      startPolling();
      if (!enabled()) { hideNow(); return; }
      create();
      const display = screen.getAllDisplays().find((d) => d.id === displayId) || cursorDisplay();
      // switching mini <-> cockpit (or edge) while visible: slide out, resize, slide back in
      const changedShape = layout && (layout.style !== (cfg().style === 'cockpit' ? 'cockpit' : 'mini') || layout.edge !== cfg().edge);
      if (cfg().visibility === 'always') {
        if (visible && changedShape) relocate(display);
        show('always');
      } else {
        reasons.delete('always');
        if (visible) { if (changedShape) relocate(display); else place(display); }
        maybeHide();
      }
    },
    init() {
      if (!enabled()) return;
      create();
      startPolling();
      if (cfg().visibility === 'always') win.webContents.once('did-finish-load', () => show('always'));
      screen.on('display-metrics-changed', () => this.projectsChanged());
      screen.on('display-removed', () => this.projectsChanged());
    },
    capture() {
      return win && !win.isDestroyed() ? win.webContents.capturePage() : null;
    },
  };
}
