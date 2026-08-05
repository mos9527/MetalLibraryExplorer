import {
  bundleFromDirHandle, bundleFromDropEntry, bundleFromFileList, fileOf, metallibsAmong,
} from "./locate.js";

const $ = (id) => document.getElementById(id);
const ROW_H = 22;

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

let nextId = 1;
const pending = new Map();
const progressHandlers = new Map();

worker.onmessage = ({ data }) => {
  if (data.progress) {
    progressHandlers.get(data.progress.id)?.(data.progress);
    return;
  }
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
};

function call(cmd, args = {}, onProgress) {
  const id = nextId++;
  if (onProgress) progressHandlers.set(id, onProgress);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, ...args });
  }).finally(() => progressHandlers.delete(id));
}

// ---------------------------------------------------------------- state

const state = {
  libs: [],
  lib: null,
  functions: [],
  visible: [],
  types: new Set(),
  filter: "",
  selected: null,
  ll: null,
};

const fmtBytes = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)} KB`
  : `${n} B`;

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
  if (isError) setBusy(false);
}

function setBusy(on) {
  document.body.classList.toggle("busy", on);
}

function setSource(text) {
  $("status-source").textContent = text;
}

function setLibCount() {
  const n = state.libs.length;
  $("status-libs").textContent = n ? `${n} librar${n === 1 ? "y" : "ies"}` : "";
}

// ---------------------------------------------------------------- opening

async function openBundle(bundle) {
  if (!bundle) {
    setStatus("No index/store0 pair found — pick the extracted .gputrace folder.", true);
    setBusy(false);
    return;
  }
  setBusy(true);
  setStatus("Reading index…");
  try {
    const info = await call("open", { indexFile: bundle.index, storeFile: bundle.store0 });
    state.libs = info.libs;
    renderLibs();
    setLibCount();
    setSource(`${bundle.dir || "bundle"} — ${info.entryCount.toLocaleString()} entries, ` +
              `${fmtBytes(info.storeSize)} store`);
    setStatus(`Found ${info.libs.length} metallibs in ${info.elapsed.toFixed(0)} ms`);
    $("layout").classList.remove("empty");
    if (info.libs.length) await selectLib(info.libs[0]);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
}

/** Open standalone .metallib files, adding to whatever is already listed. */
async function openMetallibs(files) {
  if (!files.length) return;
  setBusy(true);
  setStatus(`Opening ${files.length} metallib${files.length > 1 ? "s" : ""}…`);
  try {
    const { libs, rejected } = await call("openFiles", { files });
    state.libs = [...state.libs, ...libs];
    renderLibs();
    setLibCount();
    $("layout").classList.remove("empty");
    if (!libs.length) {
      setStatus(`Not a metallib: ${rejected.join(", ")}`, true);
      return;
    }
    if (state.libs.length === libs.length) setSource("standalone files");
    if (rejected.length) setStatus(`Skipped ${rejected.length} non-metallib file(s)`);
    await selectLib(libs[0]);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- libraries

function renderLibs() {
  const ul = $("lib-list");
  ul.replaceChildren(...state.libs.map((lib) => {
    const li = document.createElement("li");
    li.dataset.name = lib.name;
    li.innerHTML = `<span class="lib-name"></span><span class="lib-size"></span>`;
    li.querySelector(".lib-name").textContent = lib.name;
    li.querySelector(".lib-size").textContent = fmtBytes(lib.usize);
    if (lib.kind === "file") li.classList.add("standalone");
    li.title = lib.kind === "file" ? "standalone .metallib" : "from the capture";
    li.onclick = () => selectLib(lib);
    return li;
  }));
}

async function selectLib(lib) {
  state.lib = lib;
  for (const li of $("lib-list").children) li.classList.toggle("active", li.dataset.name === lib.name);
  setStatus(`Listing functions in ${lib.name}…`);
  try {
    const { functions, header, elapsed } = await call("list", { name: lib.name });
    state.functions = functions;
    state.types = new Set(functions.map((f) => f.type));
    state.filter = "";
    $("filter").value = "";
    renderChips();
    applyFilter();
    const lang = functions[0]?.metal ? `Metal ${functions[0].metal.join(".")}` : "unknown version";
    const read = lib.kind === "file"
      ? `read ${fmtBytes(header.bitcodeOff)} of ${fmtBytes(lib.usize)}`
      : `only ${fmtBytes(header.bitcodeOff)} of ${fmtBytes(lib.usize)} inflated`;
    setStatus(`${lib.name}: ${functions.length.toLocaleString()} functions in ${elapsed.toFixed(0)} ms ` +
              `— ${lang}, ${fmtBytes(header.bitcodeSize)} of bitcode, ${read}`);
  } catch (err) {
    setStatus(err.message, true);
  }
}

// ---------------------------------------------------------------- filtering

const activeTypes = new Set();

function renderChips() {
  activeTypes.clear();
  const box = $("type-chips");
  box.replaceChildren(...[...state.types].sort().map((type) => {
    const count = state.functions.filter((f) => f.type === type).length;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `${type} ${count.toLocaleString()}`;
    chip.onclick = () => {
      activeTypes.has(type) ? activeTypes.delete(type) : activeTypes.add(type);
      chip.classList.toggle("on");
      applyFilter();
    };
    return chip;
  }));
}

function applyFilter() {
  const needle = state.filter.toLowerCase();
  state.visible = state.functions.filter((f) =>
    (activeTypes.size === 0 || activeTypes.has(f.type)) &&
    (needle === "" || f.name.toLowerCase().includes(needle)));
  $("fn-count").textContent = state.visible.length === state.functions.length
    ? `(${state.functions.length.toLocaleString()})`
    : `(${state.visible.length.toLocaleString()} of ${state.functions.length.toLocaleString()})`;
  $("fn-spacer").style.height = `${state.visible.length * ROW_H}px`;
  $("fn-scroll").scrollTop = 0;
  renderRows();
}

/** Render only the rows in view; 19k+ entries stay smooth. */
function renderRows() {
  const scroll = $("fn-scroll");
  const first = Math.max(0, Math.floor(scroll.scrollTop / ROW_H) - 5);
  const count = Math.ceil(scroll.clientHeight / ROW_H) + 10;
  const slice = state.visible.slice(first, first + count);

  $("fn-rows").style.transform = `translateY(${first * ROW_H}px)`;
  $("fn-rows").replaceChildren(...slice.map((fn) => {
    const row = document.createElement("div");
    row.className = "fn-row" + (state.selected === fn.name ? " active" : "");
    row.innerHTML = `<span class="n"></span><span class="t"></span><span class="s"></span>`;
    row.querySelector(".n").textContent = fn.name;
    const t = row.querySelector(".t");
    t.textContent = fn.type.slice(0, 4);
    t.classList.add(fn.type);
    row.querySelector(".s").textContent = fmtBytes(fn.size);
    row.onclick = () => showFunction(fn);
    return row;
  }));
}

// ---------------------------------------------------------------- disasm

async function showFunction(fn) {
  state.selected = fn.name;
  renderRows();
  $("fn-name").textContent = fn.name;
  $("fn-meta").textContent =
    `${fn.type} · ${fmtBytes(fn.size)} bitcode · AIR ${fn.air?.join(".")} · Metal ${fn.metal?.join(".")}`;
  $("detail-legend").textContent = `Disassembly — ${fn.name}`;
  $("ir-code").textContent = "Inflating bitcode…";
  $("save-btn").disabled = true;

  try {
    const res = await call("disasm", { name: state.lib.name, fnName: fn.name }, ({ at, target }) => {
      $("ir-code").textContent = `Seeking to bitcode… ${fmtBytes(at)} / ${fmtBytes(target)}`;
    });
    state.ll = res.ll;
    $("ir-code").innerHTML = highlight(res.ll);
    $("ir-panel").scrollTop = 0;
    $("save-btn").disabled = false;
    $("fn-meta").textContent =
      `${fn.type} · ${fmtBytes(res.bitcodeSize)} bitcode · AIR ${fn.air?.join(".")} · ` +
      `fetch ${res.fetchMs.toFixed(0)} ms · disasm ${res.disasmMs.toFixed(0)} ms`;
  } catch (err) {
    $("ir-code").textContent = err.message;
  }
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const esc = (s) => s.replace(/[&<>]/g, (c) => ESCAPES[c]);

// One pass with a single alternation, so escaping never runs over markup this
// function itself inserted.
const TOKEN = new RegExp([
  /(;[^\n]*)/,                                                     // comment
  /("(?:[^"\\\n]|\\.)*")/,                                         // string
  /(![-\w.]+)/,                                                    // metadata
  /\b(define|declare|ret|call|tail|local_unnamed_addr|attributes|target|source_filename|datalayout|triple|zeroinitializer|nounwind|readnone|readonly|norecurse|alloca|load|store|br|switch|phi|select|getelementptr|bitcast|fmul|fadd|fsub|fdiv|extractelement|insertelement|shufflevector|icmp|fcmp|type)\b/,
  /\b(void|i1|i8|i16|i32|i64|half|float|double|ptr)\b/,            // types
].map((r) => r.source).join("|"), "g");

const CLASSES = ["cm", "str", "md", "k", "ty"];

function highlight(text) {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    out += esc(text.slice(last, m.index));
    const cls = CLASSES[m.slice(1).findIndex((g) => g !== undefined)];
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

// ---------------------------------------------------------------- wiring

$("pick-btn").onclick = async () => {
  if (!window.showDirectoryPicker) {
    // no direct-by-name lookup available; the browser must enumerate
    setStatus("Scanning folder… (large bundles can take a moment)");
    $("picker").click();
    return;
  }
  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: "read", id: "gputrace" });
  } catch { return; } // user cancelled
  setBusy(true);
  setStatus("Looking for index/store0…");
  openBundle(await bundleFromDirHandle(dir));
};

$("picker").onchange = (e) => openBundle(bundleFromFileList([...e.target.files]));

$("lib-btn").onclick = async () => {
  if (!window.showOpenFilePicker) return $("lib-picker").click();
  try {
    const handles = await window.showOpenFilePicker({
      multiple: true,
      id: "metallib",
      types: [{ description: "Metal library", accept: { "application/octet-stream": [".metallib"] } }],
    });
    openMetallibs(await Promise.all(handles.map((h) => h.getFile())));
  } catch { /* cancelled */ }
};

$("lib-picker").onchange = (e) => openMetallibs([...e.target.files]);
$("fn-scroll").onscroll = renderRows;
$("filter").oninput = (e) => { state.filter = e.target.value; applyFilter(); };
$("save-btn").onclick = () => {
  const blob = new Blob([state.ll], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${state.selected}.ll`;
  a.click();
  URL.revokeObjectURL(a.href);
};
window.addEventListener("resize", renderRows);

const about = (on) => $("about-overlay").classList.toggle("on", on);
$("about-btn").onclick = () => about(true);
$("about-close").onclick = () => about(false);
$("about-ok").onclick = () => about(false);
$("about-overlay").onclick = (e) => { if (e.target.id === "about-overlay") about(false); };
window.addEventListener("keydown", (e) => { if (e.key === "Escape") about(false); });

const overlay = $("drop-overlay");
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); if (++dragDepth === 1) overlay.classList.add("on"); });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove("on"); } });
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.remove("on");
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry()).filter(Boolean);
  setBusy(true);
  setStatus("Inspecting drop…");

  // a folder is treated as a capture bundle
  for (const entry of entries.filter((en) => en.isDirectory)) {
    const hit = await bundleFromDropEntry(entry);
    if (hit) return openBundle(hit);
  }

  const loose = await Promise.all(entries.filter((en) => en.isFile).map(fileOf));
  const metallibs = await metallibsAmong(loose);
  if (metallibs.length) return openMetallibs(metallibs);

  // or index/store0 dropped directly
  openBundle(bundleFromFileList(loose));
});
