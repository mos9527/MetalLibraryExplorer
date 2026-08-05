// Owns the trace, the metallib parsing and llvm-dis, so the UI thread never
// blocks on inflate or disassembly.
import LLVMDis from "./llvm-dis.js";
import { GpuTrace } from "./gputrace.js";
import { MetalLib } from "./metallib.js";
import { blobSource } from "./source.js";

const sources = new Map();   // display name -> byte source
const libs = new Map();      // display name -> parsed MetalLib
let wasmModule = null;

function uniqueName(name) {
  if (!sources.has(name)) return name;
  for (let n = 2; ; n++) {
    if (!sources.has(`${name} (${n})`)) return `${name} (${n})`;
  }
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

const handlers = {
  async open({ indexFile, storeFile }) {
    const t0 = performance.now();
    const trace = await GpuTrace.open(indexFile, storeFile);
    sources.clear();
    libs.clear();
    const found = await trace.findByMagic("MTLB");
    for (const entry of found) sources.set(entry.name, trace.source(entry));
    return {
      entryCount: trace.entries.length,
      storeSize: storeFile.size,
      elapsed: performance.now() - t0,
      libs: found.map((e) => ({ name: e.name, usize: e.usize, kind: "trace" })),
    };
  },

  /** Open standalone .metallib files, adding them alongside anything already open. */
  async openFiles({ files }) {
    const t0 = performance.now();
    const added = [];
    const rejected = [];
    for (const file of files) {
      const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (new TextDecoder().decode(magic) !== "MTLB") {
        rejected.push(file.name);
        continue;
      }
      const name = uniqueName(file.name);
      sources.set(name, blobSource(file, name));
      added.push({ name, usize: file.size, kind: "file" });
    }
    return { libs: added, rejected, elapsed: performance.now() - t0 };
  },

  async list({ name }) {
    const t0 = performance.now();
    let lib = libs.get(name);
    if (!lib) {
      lib = await MetalLib.open(sources.get(name));
      libs.set(name, lib);
    }
    return {
      header: lib.header,
      elapsed: performance.now() - t0,
      functions: lib.functions.map((f) => ({
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
    const lib = libs.get(name);
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

self.onmessage = async ({ data }) => {
  const { id, cmd, ...args } = data;
  try {
    const result = await handlers[cmd]({ ...args, id });
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack ?? err?.message ?? err) });
  }
};
