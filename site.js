// SynthFlow product site — a guided demo of the product loop:
// pick a sound → (thinking, mapping, rendering) → hear → refine → versions.
//
// Every sound on the page was rendered by the SynthFlow backend from the
// parameters shown (see backend/scripts/render_site_demo.py, which writes
// site/demo/catalog.json and the audio files). The page only plays those
// files: the waveform is drawn from the decoded samples, Play plays them,
// Download saves them as WAV. Nothing is synthesized or invented here.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------- theme
const THEME_KEY = "synthflow_site_theme";
function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ }
  const btn = $("#theme-btn");
  if (btn) btn.setAttribute("aria-label", theme === "dark" ? "Switch to light appearance" : "Switch to dark appearance");
  drawWave();
}
$("#theme-btn")?.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));

// ---------------------------------------------------------------- state
const state = {
  catalog: null,      // site/demo/catalog.json
  preset: null,       // the catalog entry currently shown
  versions: [],       // [{ key, label, display, diff, buffer, peaks }]
  current: -1,
  busy: false,
  playing: null,      // { source, progress, raf }
};

const el = {
  prompt: $("#prompt"), chips: $("#chips"), picker: $("#picker"),
  stages: $$("#stages .stage"), result: $("#result"), name: $("#result-name"), quote: $("#result-quote"),
  play: $("#play-btn"), undo: $("#undo-btn"), download: $("#download-btn"),
  canvas: $("#wave-canvas"), waveStatic: $("#wave-static"), playhead: $("#playhead"),
  params: $$("#params .param"), refine: $$("#refine button"), versions: $("#versions"),
  note: $("#refine-note"), demoNote: $("#demo-note"), showcase: $("#showcase"),
};

// ---------------------------------------------------------------- audio
const decodeCache = new Map();
let audioCtx = null;
function ctx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
async function loadAudio(url) {
  if (decodeCache.has(url)) return decodeCache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = await res.arrayBuffer();
  const buffer = await ctx().decodeAudioData(bytes);
  const entry = { buffer, peaks: peaks(buffer, 120) };
  decodeCache.set(url, entry);
  return entry;
}

function peaks(buffer, bins) {
  const ch = buffer.getChannelData(0);
  const size = Math.floor(ch.length / bins);
  const out = new Float32Array(bins);
  let max = 0;
  for (let i = 0; i < bins; i++) {
    let m = 0;
    const start = i * size;
    for (let j = start; j < start + size; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; }
    out[i] = m; if (m > max) max = m;
  }
  if (max > 0) for (let i = 0; i < bins; i++) out[i] /= max;
  return out;
}

function encodeWav(buffer) {
  const n = buffer.length, chs = buffer.numberOfChannels;
  const data = new DataView(new ArrayBuffer(44 + n * chs * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); data.setUint32(4, 36 + n * chs * 2, true); str(8, "WAVE"); str(12, "fmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, chs, true);
  data.setUint32(24, buffer.sampleRate, true); data.setUint32(28, buffer.sampleRate * chs * 2, true);
  data.setUint16(32, chs * 2, true); data.setUint16(34, 16, true); str(36, "data"); data.setUint32(40, n * chs * 2, true);
  let o = 44;
  const chans = Array.from({ length: chs }, (_, c) => buffer.getChannelData(c));
  for (let i = 0; i < n; i++) for (let c = 0; c < chs; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]));
    data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
  }
  return new Blob([data], { type: "audio/wav" });
}

// ---------------------------------------------------------------- rendering UI
const PARAM_KEYS = ["wavetable", "cutoff", "resonance", "attack", "decay", "stereo", "level"];

function renderChips(items) {
  el.chips.innerHTML = "";
  items.forEach((k, i) => {
    const s = document.createElement("span");
    s.className = "chip"; s.textContent = k; s.style.animationDelay = `${i * 40}ms`;
    el.chips.appendChild(s);
  });
}

function setStage(name) {
  const order = ["thinking", "mapping", "rendering", "completed"];
  const idx = order.indexOf(name);
  el.stages.forEach((s) => {
    const i = order.indexOf(s.dataset.stage);
    s.classList.toggle("active", i === idx);
    s.classList.toggle("done", idx >= 0 && i < idx);
  });
}

function renderParams(display, prev) {
  el.params.forEach((cell) => {
    const k = cell.dataset.key;
    cell.querySelector(".param-v").textContent = display[k];
    cell.classList.toggle("changed", Boolean(prev && prev[k] !== display[k]));
  });
}

function renderVersions() {
  if (state.versions.length < 2) { el.versions.hidden = true; el.versions.innerHTML = ""; return; }
  el.versions.hidden = false;
  el.versions.innerHTML = "";
  state.versions.forEach((v, i) => {
    const row = document.createElement("div");
    row.className = "ver" + (i === state.current ? " current" : "");
    row.innerHTML = `<span class="ver-n">v${i + 1}</span><span class="ver-t"></span><button class="ver-restore" type="button">Restore</button>`;
    const t = row.querySelector(".ver-t");
    t.textContent = v.label;
    if (v.diff.length) { const s = document.createElement("small"); s.textContent = v.diff.join(" · "); t.appendChild(s); }
    row.querySelector(".ver-restore").addEventListener("click", () => showVersion(i));
    el.versions.appendChild(row);
  });
}

function renderPicker() {
  el.picker.innerHTML = "";
  state.catalog.presets.forEach((p) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "pick"; b.textContent = p.name.toLowerCase();
    b.setAttribute("aria-pressed", String(state.preset && state.preset.id === p.id));
    b.addEventListener("click", () => pick(p.id));
    el.picker.appendChild(b);
  });
}

function drawWave() {
  const v = state.versions[state.current];
  if (!v || !el.canvas) return;
  const c = el.canvas;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const styles = getComputedStyle(document.documentElement);
  const color = styles.getPropertyValue("--wave").trim();
  const dim = styles.getPropertyValue("--wave-dim").trim();
  const bars = v.peaks.length, gap = 2, bw = (w - gap * (bars - 1)) / bars;
  const played = state.playing ? state.playing.progress : -1;
  for (let i = 0; i < bars; i++) {
    const bh = Math.max(2, v.peaks[i] * h);
    g.fillStyle = played >= 0 && i / bars > played ? dim : color;
    g.fillRect(i * (bw + gap), (h - bh) / 2, bw, bh);
  }
}

function showVersion(i, { animate = true } = {}) {
  stopPlayback();
  const prev = state.versions[state.current];
  state.current = i;
  const v = state.versions[i];
  el.name.textContent = state.preset.name;
  el.quote.textContent = `“${state.preset.prompt}”`;
  renderParams(v.display, animate ? prev?.display : null);
  renderVersions();
  el.undo.disabled = i === 0;
  el.play.disabled = false; el.download.disabled = false;
  el.refine.forEach((b) => { b.disabled = false; b.setAttribute("aria-pressed", String(v.key === b.dataset.refine)); });
  if (el.waveStatic) { el.waveStatic.remove(); el.waveStatic = null; el.canvas.hidden = false; }
  drawWave();
}

let noteTimer = null;
function note(text) {
  if (!el.note) return;
  el.note.textContent = text; el.note.hidden = false;
  clearTimeout(noteTimer); noteTimer = setTimeout(() => { el.note.hidden = true; }, 3000);
}

// ---------------------------------------------------------------- flows
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function pick(id) {
  if (state.busy || !state.catalog) return;
  const preset = state.catalog.presets.find((p) => p.id === id);
  if (!preset) return;
  state.busy = true; el.result.classList.add("pending");
  stopPlayback();
  state.preset = preset;
  renderPicker();
  await typePrompt(preset.prompt);
  setStage("thinking");
  await wait(360);
  renderChips(preset.understood);
  setStage("mapping");
  await wait(320);
  setStage("rendering");
  try {
    const { buffer, peaks: pk } = await loadAudio(preset.audio);
    state.versions = [{ key: null, label: preset.prompt.length > 48 ? preset.prompt.slice(0, 48) + "…" : preset.prompt, display: preset.display, diff: [], buffer, peaks: pk }];
    setStage("completed");
    el.result.classList.remove("pending");
    showVersion(0, { animate: false });
  } catch (err) {
    setStage(null);
    el.result.classList.remove("pending");
    note("This sound’s audio failed to load.");
    console.error(err);
  }
  state.busy = false;
}

async function refine(key) {
  if (state.busy || !state.preset) return;
  const existing = state.versions.findIndex((v) => v.key === key);
  if (existing >= 0) { showVersion(existing); return; }
  const branch = state.preset.refines[key];
  if (!branch) { note("Nothing to change — that parameter is already at its limit for this sound."); return; }
  state.busy = true; el.result.classList.add("pending");
  setStage("rendering");
  try {
    const { buffer, peaks: pk } = await loadAudio(branch.audio);
    state.versions.push({ key, label: branch.label, display: branch.display, diff: branch.diff, buffer, peaks: pk });
    setStage("completed");
    el.result.classList.remove("pending");
    showVersion(state.versions.length - 1);
  } catch (err) {
    setStage("completed");
    el.result.classList.remove("pending");
    note("This version’s audio failed to load.");
    console.error(err);
  }
  state.busy = false;
}

function stopPlayback() {
  if (!state.playing) return;
  try { state.playing.source.stop(); } catch (e) { /* already stopped */ }
  cancelAnimationFrame(state.playing.raf);
  state.playing = null;
  el.playhead.classList.remove("on");
  el.play.querySelector(".label").textContent = "Play";
  drawWave();
}

function play() {
  const v = state.versions[state.current];
  if (!v) return;
  if (state.playing) { stopPlayback(); return; }
  const ac = ctx();
  if (ac.state === "suspended") ac.resume();
  const source = ac.createBufferSource();
  source.buffer = v.buffer; source.connect(ac.destination);
  const startedAt = ac.currentTime;
  source.start();
  el.play.querySelector(".label").textContent = "Stop";
  el.playhead.classList.add("on");
  const wave = el.canvas.parentElement;
  const tick = () => {
    if (!state.playing) return;
    const p = Math.min(1, (ac.currentTime - startedAt) / v.buffer.duration);
    state.playing.progress = p;
    const pad = 20, inner = wave.clientWidth - pad * 2;
    el.playhead.style.left = `${pad + inner * p}px`;
    drawWave();
    state.playing.raf = requestAnimationFrame(tick);
  };
  state.playing = { source, progress: 0, raf: 0 };
  source.onended = () => { if (state.playing && state.playing.source === source) stopPlayback(); };
  tick();
}

function download() {
  const v = state.versions[state.current];
  if (!v) return;
  const url = URL.createObjectURL(encodeWav(v.buffer));
  const a = document.createElement("a");
  const suffix = v.key ? `-${v.key}` : "";
  a.href = url; a.download = `${state.preset.id}${suffix}.wav`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- typewriter
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function typePrompt(text) {
  if (reduceMotion) { el.prompt.textContent = text; return Promise.resolve(); }
  // Time-based so a throttled background tab still finishes in ~0.6 s.
  return new Promise((resolve) => {
    const t0 = performance.now(), total = Math.min(700, text.length * 9);
    const step = () => {
      const f = Math.min(1, (performance.now() - t0) / total);
      el.prompt.textContent = text.slice(0, Math.ceil(text.length * f));
      if (f < 1) setTimeout(step, 16);
      else resolve();
    };
    step();
  });
}

// ---------------------------------------------------------------- showcase
function renderShowcase() {
  if (!el.showcase) return;
  $$("[data-showcase]", el.showcase).forEach((card) => {
    const p = state.catalog.presets.find((x) => x.id === card.dataset.showcase);
    if (!p) { card.hidden = true; return; }
    $(".case-prompt", card).textContent = `“${p.prompt}”`;
    const chips = $(".case-chips", card);
    chips.innerHTML = "";
    p.understood.forEach((k) => { const s = document.createElement("span"); s.className = "chip"; s.textContent = k; chips.appendChild(s); });
    const rows = $(".case-params", card);
    rows.innerHTML = "";
    PARAM_KEYS.forEach((k) => {
      const d = document.createElement("div"); d.className = "param";
      d.innerHTML = `<div class="param-k"></div><div class="param-v"></div>`;
      $(".param-k", d).textContent = $(`#params .param[data-key="${k}"] .param-k`).textContent;
      $(".param-v", d).textContent = p.display[k];
      rows.appendChild(d);
    });
    const btn = $(".case-play", card);
    btn.disabled = false;
    btn.addEventListener("click", () => { pick(p.id).then(() => { $("#result").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" }); }); });
  });
}

// ---------------------------------------------------------------- wiring
el.refine.forEach((b) => b.addEventListener("click", () => refine(b.dataset.refine)));
el.play.addEventListener("click", play);
el.undo.addEventListener("click", () => { if (state.current > 0) showVersion(state.current - 1); });
el.download.addEventListener("click", download);
window.addEventListener("resize", drawWave);

const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
}, { rootMargin: "0px 0px -10% 0px" });
$$(".reveal").forEach((n) => io.observe(n));

// Early-access form: no backend is wired yet, say so instead of pretending.
$("#cta-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  $("#cta-note").textContent = "Sign-up isn’t connected yet. [Wire this form to your list provider.]";
});

// Dev hook (used by the page checks in the repo; harmless in production).
window.__synthflow = { state, pick, refine, play, showVersion };

// Boot: load the catalogue, then play the first sound through the loop.
(async () => {
  try {
    const res = await fetch("demo/catalog.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`catalog ${res.status}`);
    state.catalog = await res.json();
  } catch (err) {
    console.error(err);
    if (el.demoNote) el.demoNote.textContent = "Demo audio isn’t available in this build. [Run backend/scripts/render_site_demo.py.]";
    return;
  }
  if (el.demoNote && state.catalog.engine) {
    el.demoNote.textContent = `Every sound on this page was rendered by the ${state.catalog.engine}, from the parameters shown. The page only plays the files.`;
  }
  renderPicker();
  renderShowcase();
  await pick(state.catalog.presets[0].id);
})();
