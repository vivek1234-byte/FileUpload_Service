// Synthesised sound effects (Web Audio, no audio files needed).
// Audio can only start after a user gesture, so call sfx.init() from a click or key press.

let ctx = null;
let master = null;
let noiseBuffer = null;
let muted = false;
const VOLUME = 0.5;

try { muted = localStorage.getItem('vortex-muted') === '1'; } catch { /* storage blocked */ }

function tone({ f = 440, to = null, dur = 0.15, type = 'square', vol = 0.15, delay = 0, attack = 0.005 }) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function noise({ dur = 0.3, vol = 0.15, f = 1200, to = null, type = 'bandpass', q = 1, delay = 0 }) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(f, t);
  if (to) filter.frequency.exponentialRampToValueAtTime(to, t + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(gain).connect(master);
  src.start(t);
  src.stop(t + dur + 0.05);
}

const NOTES = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568];

export const sfx = {
  get muted() { return muted; },

  init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : VOLUME;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  },

  toggle() {
    muted = !muted;
    try { localStorage.setItem('vortex-muted', muted ? '1' : '0'); } catch { /* storage blocked */ }
    if (master) master.gain.setTargetAtTime(muted ? 0 : VOLUME, ctx.currentTime, 0.02);
    return muted;
  },

  start() {
    tone({ f: 110, to: 880, dur: 0.7, type: 'sawtooth', vol: 0.1 });
    tone({ f: 220, to: 1760, dur: 0.7, type: 'square', vol: 0.04, delay: 0.05 });
    noise({ dur: 0.8, vol: 0.12, f: 300, to: 5000 });
    tone({ f: 1046.5, dur: 0.5, type: 'triangle', vol: 0.12, delay: 0.65 });
  },

  hover() { tone({ f: 1500, dur: 0.035, vol: 0.03 }); },
  ui() { tone({ f: 600, to: 900, dur: 0.07, vol: 0.06 }); },

  launch() {
    tone({ f: 140, to: 700, dur: 0.45, type: 'sawtooth', vol: 0.08 });
    noise({ dur: 0.5, vol: 0.1, f: 500, to: 3500 });
  },

  tick(p) { tone({ f: 900 + p * 1400, dur: 0.025, type: 'triangle', vol: 0.03 }); },

  store(rarity) {
    tone({ f: 170, to: 38, dur: 0.6, type: 'sine', vol: 0.55 });
    noise({ dur: 0.55, vol: 0.22 + rarity * 0.04, f: 4000, to: 150, type: 'lowpass' });
    for (let i = 0; i < rarity + 2; i++) {
      tone({ f: NOTES[i], dur: 0.28, type: 'triangle', vol: 0.11, delay: 0.08 + i * 0.075 });
    }
  },

  combo(n) {
    tone({ f: 330 * Math.pow(1.122, Math.min(n, 12)), dur: 0.12, vol: 0.08 });
    tone({ f: 660 * Math.pow(1.122, Math.min(n, 12)), dur: 0.12, vol: 0.05, delay: 0.06 });
  },

  levelUp() {
    [392, 523.25, 659.25, 783.99].forEach((f, i) => tone({ f, dur: 0.12, vol: 0.1, delay: i * 0.08 }));
    tone({ f: 1046.5, dur: 0.6, vol: 0.12, delay: 0.32 });
    tone({ f: 1318.5, dur: 0.6, type: 'triangle', vol: 0.08, delay: 0.32 });
    noise({ dur: 0.9, vol: 0.08, f: 800, to: 8000, delay: 0.3 });
  },

  achievement() {
    tone({ f: 880, dur: 0.25, type: 'triangle', vol: 0.14 });
    tone({ f: 1318.5, dur: 0.45, type: 'triangle', vol: 0.14, delay: 0.12 });
    tone({ f: 1760, dur: 0.5, type: 'sine', vol: 0.06, delay: 0.12 });
  },

  retrieve() {
    tone({ f: 1400, to: 300, dur: 0.3, vol: 0.07 });
    tone({ f: 659.25, dur: 0.15, type: 'triangle', vol: 0.1, delay: 0.05 });
    tone({ f: 987.8, dur: 0.25, type: 'triangle', vol: 0.1, delay: 0.13 });
  },

  alarm() {
    for (let i = 0; i < 3; i++) {
      tone({ f: 880, to: 440, dur: 0.34, type: 'sawtooth', vol: 0.09, delay: i * 0.4 });
      tone({ f: 660, to: 330, dur: 0.34, type: 'square', vol: 0.05, delay: i * 0.4 + 0.02 });
    }
  },

  shatter() {
    noise({ dur: 0.5, vol: 0.3, f: 3000, to: 800, type: 'highpass' });
    tone({ f: 200, to: 50, dur: 0.5, type: 'sawtooth', vol: 0.12 });
    for (let i = 0; i < 10; i++) {
      tone({ f: 2000 + Math.random() * 3000, dur: 0.12, type: 'triangle', vol: 0.05, delay: Math.random() * 0.45 });
    }
  },

  shield() {
    [392, 587.3, 784, 1174.7].forEach((f, i) => tone({ f, dur: 1.0, type: 'triangle', vol: 0.07, delay: i * 0.07 }));
    noise({ dur: 1.2, vol: 0.06, f: 2000, to: 6000 });
  },

  catch(chain) {
    const base = 880 * Math.pow(1.06, Math.min(chain, 10));
    tone({ f: base, dur: 0.06, vol: 0.08 });
    tone({ f: base * 1.5, dur: 0.14, type: 'triangle', vol: 0.09, delay: 0.05 });
  },

  crateDrop() {
    tone({ f: 120, to: 50, dur: 0.3, type: 'sine', vol: 0.5 });
    noise({ dur: 0.15, vol: 0.2, f: 600, type: 'lowpass' });
    tone({ f: 1318.5, dur: 0.4, type: 'triangle', vol: 0.08, delay: 0.15 });
    tone({ f: 1760, dur: 0.5, type: 'triangle', vol: 0.06, delay: 0.25 });
  },

  rattle() {
    noise({ dur: 0.06, vol: 0.18, f: 1800, q: 4 });
    tone({ f: 300 + Math.random() * 200, dur: 0.04, vol: 0.05 });
  },

  crateOpen(rarity) {
    noise({ dur: 0.6, vol: 0.2, f: 400, to: 6000 });
    tone({ f: 150, to: 40, dur: 0.5, type: 'sine', vol: 0.45 });
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568, 2093];
    for (let i = 0; i < 3 + rarity; i++) tone({ f: notes[i], dur: 0.35, vol: 0.07, delay: 0.12 + i * 0.07 });
  },

  grab() { tone({ f: 220, to: 330, dur: 0.08, vol: 0.07 }); },

  destroy() {
    tone({ f: 90, to: 30, dur: 0.9, type: 'sawtooth', vol: 0.25 });
    tone({ f: 60, dur: 0.6, type: 'sine', vol: 0.5 });
    noise({ dur: 0.9, vol: 0.3, f: 5000, to: 100, type: 'lowpass' });
  },

  error() {
    tone({ f: 220, to: 70, dur: 0.45, type: 'sawtooth', vol: 0.13 });
    tone({ f: 233, to: 73, dur: 0.45, type: 'sawtooth', vol: 0.1 });
  },
};
