// Every sound is synthesized with WebAudio. No sample files.
let ctx = null;
let master = null;
let enabled = true;
let volume = 0.7;
let noiseBuf = null;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function configure({ sound, volume: v }) {
  if (typeof sound === 'boolean') enabled = sound;
  if (typeof v === 'number') {
    volume = v;
    if (master) master.gain.value = v;
  }
}
export const unlock = () => { if (enabled) ac(); };

function env(gainNode, t, attack, peak, decay, sustain = 0.0001) {
  const g = gainNode.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(peak, t + attack);
  g.exponentialRampToValueAtTime(sustain, t + attack + decay);
}

function tone({ type = 'sine', freq = 440, to = null, at = 0, attack = 0.004, peak = 0.3, decay = 0.2, detune = 0, dest = null }) {
  const c = ac();
  if (!c || !enabled) return;
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  o.detune.value = detune;
  env(g, t, attack, peak, decay);
  o.connect(g).connect(dest || master);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

function noise({ at = 0, attack = 0.002, peak = 0.3, decay = 0.08, type = 'bandpass', freq = 2000, to = null, q = 1 }) {
  const c = ac();
  if (!c || !enabled) return;
  const t = c.currentTime + at;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  f.Q.value = q;
  const g = c.createGain();
  env(g, t, attack, peak, decay);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random());
  src.stop(t + attack + decay + 0.05);
}

let echoBus = null;
function echo() {
  const c = ac();
  if (!c) return null;
  if (echoBus) return echoBus;
  const d = c.createDelay();
  d.delayTime.value = 0.16;
  const fb = c.createGain();
  fb.gain.value = 0.28;
  const wet = c.createGain();
  wet.gain.value = 0.35;
  const input = c.createGain();
  input.connect(master);
  input.connect(d);
  d.connect(fb).connect(d);
  d.connect(wet).connect(master);
  echoBus = input;
  return input;
}

export const sfx = {
  // mechanical click when the cap starts to travel
  press() {
    noise({ peak: 0.22, decay: 0.03, type: 'highpass', freq: 2500 });
    tone({ type: 'sine', freq: 160, to: 70, peak: 0.35, decay: 0.09 });
  },
  // letting go early: the cap springs back up with a soft "ploink"
  release() {
    noise({ peak: 0.1, decay: 0.02, type: 'highpass', freq: 3500 });
    tone({ type: 'sine', freq: 380, to: 980, peak: 0.12, attack: 0.004, decay: 0.09 });
    tone({ at: 0.05, type: 'sine', freq: 980, to: 820, peak: 0.05, attack: 0.004, decay: 0.12 });
  },
  // one LED lighting up while charging: rising pitch
  tick(i, total = 24) {
    const f = 520 * Math.pow(2, (i / total) * 1.6);
    tone({ type: 'square', freq: f, peak: 0.035, attack: 0.002, decay: 0.035 });
  },
  // ignition: a thump and an engine spool-up that ends on an unresolved sus4 chord.
  // The success chime resolves it (D -> C#), the failure sound collapses it.
  launch() {
    tone({ type: 'sine', freq: 92, to: 40, peak: 0.55, attack: 0.004, decay: 0.5 });
    noise({ peak: 0.2, attack: 0.02, decay: 0.12, type: 'highpass', freq: 3800 });
    noise({ at: 0.04, peak: 0.16, attack: 0.35, decay: 1.1, type: 'bandpass', freq: 160, to: 1100, q: 1.4 });
    tone({ at: 0.12, type: 'sawtooth', freq: 55, to: 82, peak: 0.05, attack: 0.3, decay: 1.0 });
    const dest = echo();
    tone({ at: 0.32, type: 'sine', freq: 440, peak: 0.07, attack: 0.18, decay: 1.6, dest });
    tone({ at: 0.32, type: 'sine', freq: 587.33, peak: 0.06, attack: 0.18, decay: 1.6, dest });
    tone({ at: 0.32, type: 'triangle', freq: 659.25, peak: 0.025, attack: 0.25, decay: 1.4, dest, detune: -6 });
  },
  success() {
    const dest = echo();
    const notes = [554.37, 659.25, 880, 1108.73]; // A major, resolving the launch chord
    notes.forEach((f, i) => {
      tone({ at: i * 0.075, type: 'sine', freq: f, peak: 0.18, attack: 0.006, decay: 0.6, dest });
      tone({ at: i * 0.075, type: 'triangle', freq: f * 2, peak: 0.03, attack: 0.004, decay: 0.25, dest });
    });
    tone({ at: 0.3, type: 'sine', freq: 1760, peak: 0.06, decay: 1.0, dest });
    tone({ type: 'sine', freq: 220, peak: 0.08, attack: 0.01, decay: 0.8 });
  },
  fail() {
    tone({ type: 'sawtooth', freq: 196, to: 98, peak: 0.12, attack: 0.01, decay: 0.42 });
    tone({ type: 'sawtooth', freq: 185, to: 92, peak: 0.1, attack: 0.01, decay: 0.42, detune: 12 });
    tone({ at: 0.22, type: 'square', freq: 130, to: 65, peak: 0.07, decay: 0.35 });
  },
  request() {
    const dest = echo();
    tone({ type: 'sine', freq: 1046.5, peak: 0.16, decay: 0.35, dest });
    tone({ at: 0.16, type: 'sine', freq: 783.99, peak: 0.16, decay: 0.5, dest });
  },
  click() {
    noise({ peak: 0.16, decay: 0.018, type: 'highpass', freq: 3000 });
    tone({ type: 'square', freq: 1800, peak: 0.03, decay: 0.015 });
  },
  denied() {
    tone({ type: 'triangle', freq: 440, to: 220, peak: 0.12, decay: 0.2 });
  },
  install() {
    [0, 0.07, 0.14, 0.21].forEach((at, i) => {
      noise({ at, peak: 0.12, decay: 0.03, type: 'bandpass', freq: 2600 + i * 400, q: 3 });
    });
    tone({ at: 0.28, type: 'sine', freq: 880, peak: 0.1, decay: 0.3 });
  },
  whoosh(out = false) {
    noise({ peak: 0.05, attack: 0.04, decay: 0.22, type: 'bandpass', freq: out ? 1600 : 500, to: out ? 400 : 1800, q: 0.8 });
  },
  // a thermal printer chattering out a line
  printer() {
    for (let i = 0; i < 7; i++) noise({ at: i * 0.028, peak: 0.05, decay: 0.014, type: 'bandpass', freq: 4200 + (i % 2) * 900, q: 4 });
  },
  // the cockpit panel locking into place
  thunk() {
    tone({ type: 'sine', freq: 110, to: 48, peak: 0.3, attack: 0.004, decay: 0.22 });
    noise({ peak: 0.08, decay: 0.06, type: 'lowpass', freq: 900 });
  },
  boot() {
    tone({ type: 'sine', freq: 220, to: 440, peak: 0.04, attack: 0.02, decay: 0.18 });
  },
};
