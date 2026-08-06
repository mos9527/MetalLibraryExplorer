// Owns the trace, the metallib parsing and llvm-dis, so the UI thread never
// blocks on inflate or disassembly.
import LLVMDis from "./llvm-dis.js";
import { GpuTrace } from "./gputrace.js";
import { MetalLib } from "./metallib.js";
import { MetalSource, isMetalSource, isText } from "./msl.js";
import { blobSource } from "./source.js";

// display name -> { source, format, parsed }
const opened = new Map();
let wasmModule = null;

function uniqueName(name) {
  if (!opened.has(name)) return name;
  for (let n = 2; ; n++) {
    if (!opened.has(`${name} (${n})`)) return `${name} (${n})`;
  }
}

function add(name, source, format) {
  opened.set(name, { source, format, parsed: null });
  return { name, usize: source.size, format };
}

async function compiler() {
  if (!wasmModule) {
    const url = new URL("./llvm-dis.wasm", import.meta.url);
    try {
      wasmModule = await WebAssembly.compileStreaming(fetch(url));
    } catch {
      // some static hosts serve .wasm with the wrong content type, which makes
      // compileStreaming refuse it; fall back to buffering the bytes
      wasmModule = await WebAssembly.compile(await (await fetch(url)).arrayBuffer());
    }
  }
  return wasmModule;
}

async function disassemble(bitcode) {
  const mod = await compiler();
  // llvm-dis cannot be reset after callMain, so take a fresh instance each
  // time; only instantiation is repeated, not compilation.
  const program = await LLVMDis({
    noInitialRun: true,
    print: () => {},
    printErr: () => {},
    instantiateWasm(imports, onSuccess) {
      const instance = new WebAssembly.Instance(mod, imports);
      onSuccess(instance);
      return instance.exports;
    },
  });
  program.FS.writeFile("shader.air", bitcode);
  await program.callMain(["shader.air"]);
  return new TextDecoder().decode(program.FS.readFile("shader.air.ll"));
}

async function parse(rec) {
  if (!rec.parsed) {
    rec.parsed = rec.format === "msl"
      ? await MetalSource.open(rec.source)
      : await MetalLib.open(rec.source);
  }
  return rec.parsed;
}

const handlers = {
  async open({ indexFile, storeFile }) {
    const t0 = performance.now();
    const trace = await GpuTrace.open(indexFile, storeFile);
    opened.clear();
    const { metallibs, sources, candidates } = await trace.findShaders();
    const libs = [
      ...metallibs.map((e) => add(e.name, trace.source(e), "metallib")),
      ...sources.map((e) => add(e.name, trace.source(e), "msl")),
    ];
    return {
      entryCount: trace.entries.length,
      storeSize: storeFile.size,
      probed: candidates,
      elapsed: performance.now() - t0,
      libs: libs.map((l) => ({ ...l, kind: "trace" })),
    };
  },

  /** Open standalone files, adding them alongside anything already open. */
  async openFiles({ files }) {
    const t0 = performance.now();
    const added = [];
    const rejected = [];
    for (const file of files) {
      const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
      const format = formatOf(head, file.name);
      if (!format) {
        rejected.push(file.name);
        continue;
      }
      const name = uniqueName(file.name);
      added.push({ ...add(name, blobSource(file, name), format), kind: "file" });
    }
    return { libs: added, rejected, elapsed: performance.now() - t0 };
  },

  async list({ name }) {
    const t0 = performance.now();
    const rec = opened.get(name);
    const parsed = await parse(rec);
    const elapsed = performance.now() - t0;

    if (rec.format === "msl") {
      return {
        format: "msl",
        elapsed,
        text: parsed.text,
        functions: parsed.functions.map((f) => ({
          key: `${f.name}@${f.offset}`,
          name: f.name,
          type: f.type,
          line: f.line,
          returns: f.returns,
        })),
      };
    }
    return {
      format: "metallib",
      header: parsed.header,
      elapsed,
      functions: parsed.functions.map((f) => ({
        key: f.name,
        name: f.name,
        type: f.typeName,
        size: f.bitcodeSize,
        hash: f.hash,
        air: f.airVersion,
        metal: f.metalVersion,
      })),
    };
  },

  async disasm({ name, fnName, id }) {
    const lib = opened.get(name).parsed;
    const fn = lib.functions.find((f) => f.name === fnName);
    const t0 = performance.now();
    const bitcode = await lib.bitcode(fn, (at, target) => {
      self.postMessage({ progress: { id, at, target } });
    });
    const fetched = performance.now() - t0;
    const t1 = performance.now();
    const ll = await disassemble(bitcode);
    return { ll, bitcodeSize: bitcode.length, fetchMs: fetched, disasmMs: performance.now() - t1 };
  },
};

const MTLB = "MTLB";

/** Sniff the container, falling back to the extension for plain source. */
function formatOf(head, filename) {
  if (String.fromCharCode(...head.subarray(0, 4)) === MTLB) return "metallib";
  if (isMetalSource(head)) return "msl";
  if (/\.(metal|msl)$/i.test(filename) && isText(head)) return "msl";
  return null;
}

self.onmessage = async ({ data }) => {
  const { id, cmd, ...args } = data;
  try {
    const result = await handlers[cmd]({ ...args, id });
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack ?? err?.message ?? err) });
  }
};
