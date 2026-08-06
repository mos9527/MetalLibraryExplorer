# MetalLibraryExplorer (fork)

> [!NOTE]
> **`site/` is AI-generated.** It was written end to end by Claude (Anthropic),
> running as a [Cursor](https://cursor.com) agent, in a single session. It has
> been tested against real captures but has not been line-by-line reviewed by a
> human. Everything outside `site/` is unmodified upstream work by
> [@YuAo](https://github.com/YuAo).

## What this fork adds: `site/`

A standalone explorer that opens **Xcode `.gputrace` captures** as well as raw
`.metallib` libraries and `.metal` sources, with **no size limit** and **no
build step**.

Upstream refuses inputs over 8 MB. That cap is a workaround in the SwiftWasm
file reader — `fstat` misreports sizes under wasmer, so it reads into a fixed
8 MB buffer ([`main.swift`](src/MetalLibraryArchiveParser/Sources/MetalLibraryArchiveParser/main.swift)).
Raising it would not be enough on its own: the parser also base64s every
function's bitcode into one JSON blob inside wasm32 memory, which for a 291 MB
library is well over a gigabyte before the page sees any of it.

`site/` sidesteps both by parsing the container in plain JavaScript and reading
lazily. It keeps upstream's `llvm-dis.wasm` — the genuinely hard-to-replace
piece — and drops the SwiftWasm parser entirely.

- Opens a `.gputrace` bundle directly, finds the shaders inside it and streams
  them out of the capture's compressed store.
- Lists functions by inflating only up to the function table, which the format
  places before the bitcode. For a 291 MB library that is 4.1 MB and about
  85 ms for all 19,823 functions.
- Disassembles a single function on demand, discarding inflate output as it
  goes so peak memory stays flat.
- Reads **MSL source** too. Captures of shaders compiled from a string, or built
  with source recording on, carry the Metal text rather than a library; those are
  listed the same way, with their entry points parsed out of the source.
- Styled with [98.css](https://github.com/jdan/98.css), because why not.

Measured on a real capture (506 MB store, five metallibs, 49,116 functions):

| Step | 291 MB library |
| --- | --- |
| Parse index, find all metallibs | 138 ms |
| List all 19,823 functions | 84 ms, 4.1 MB inflated |
| Disassemble an early function | 9 ms fetch + 32 ms disasm |
| Disassemble the deepest function | ~1.1 s fetch + 4 ms disasm |
| Same library as a standalone file | 0.5 ms fetch |

See [`site/README.md`](site/README.md) for the format notes and how it stays
cheap. It is served by GitHub Pages straight from `site/` with no toolchain —
see [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

---

## Upstream

[![Build](https://github.com/YuAo/MetalLibraryExplorer/actions/workflows/build.yml/badge.svg)](https://github.com/YuAo/MetalLibraryExplorer/actions/workflows/build.yml)
[![Deploy](https://github.com/YuAo/MetalLibraryExplorer/actions/workflows/deploy.yml/badge.svg)](https://github.com/YuAo/MetalLibraryExplorer/actions/workflows/deploy.yml)

Parse and disassemble .metallib files in browser. https://yuao.github.io/MetalLibraryExplorer

**This is a [WebAssembly](https://webassembly.org/) port of [MetalLibraryArchive](https://github.com/YuAo/MetalLibraryArchive). In order to use this tool your browser must [support WebAssembly](https://caniuse.com/wasm).**

## Features

- Inspect `.metallib` files. Get information about library type, target platform, Metal functions, etc.

- Disassemble Metal function bitcode.

- Download Metal bitcode and assembly as a zip archive.

## Technologies

### Metal Library Archive Parser

The parser uses a WebAssembly version of the [MetalLibraryArchive](https://github.com/YuAo/MetalLibraryArchive) core library, built with [SwiftWasm](https://github.com/swiftwasm/swift).

[wasmer-js](https://github.com/wasmerio/wasmer-js) is used as WASI polyfill. ~~However due to [wasmer/issues/2792](https://github.com/wasmerio/wasmer/issues/2792), the parser has to run in a Web Worker.~~

`wasm-strip` from [WABT](https://github.com/WebAssembly/wabt) and `wasm-opt` from [binaryen](https://github.com/WebAssembly/binaryen) are used mainly to reduce the `.wasm` binary size.

### LLVM Disassembler

[llvm-dis](https://llvm.org/docs/CommandGuide/llvm-dis.html) is used to convert the Metal bitcode into human-readable LLVM assembly language. This is also compiled to WebAssembly using [this workflow](https://github.com/YuAo/llvm-wasm/blob/master/.github/workflows/build-llvm-dis.yml).

### User Interface

The UI is built with [React](https://reactjs.org/) and [tailwindcss](https://tailwindcss.com/)

### Zip Archive & File Download

[JSZip](https://stuk.github.io/jszip/) & [FileSaver](https://github.com/eligrey/FileSaver.js/)

## Building

To build this library you will need to have installed in your system:

- [Node.js](https://nodejs.org/)
- [WABT](https://github.com/WebAssembly/wabt)
- [binaryen](https://github.com/WebAssembly/binaryen)
- [SwiftWasm](https://swiftwasm.org/)

### Build

```shell
npm install
npm run build
```

### Develop

```shell
npm install
npm run start
```

## More About `.metallib` Files

See [MetalLibraryArchive](https://github.com/YuAo/MetalLibraryArchive).
