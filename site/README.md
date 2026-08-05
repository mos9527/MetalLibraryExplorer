# gputrace metallib explorer

> **AI-generated.** Written end to end by Claude (Anthropic) running as a
> [Cursor](https://cursor.com) agent. Tested against real captures, but not
> line-by-line reviewed by a human.


Opens an extracted Xcode `.gputrace` bundle in the browser, lists the metallibs
inside it, and disassembles individual Metal functions on demand. Standalone
`.metallib` files can be opened the same way, with no size limit. No Xcode, no
server-side processing, no upload — everything runs locally in the page.

## Running

Any static file server works; the only requirement is that `.wasm` is served as
`application/wasm` and the page is not opened via `file://` (module workers need
an origin).

```bash
python -m http.server 8777
```

Then open <http://127.0.0.1:8777/> and pick or drag in an extracted `.gputrace`
folder or one or more `.metallib` files. Dropped files are identified by their
`MTLB` magic rather than by extension, and standalone libraries are added
alongside anything already open so they can be compared side by side.

## How it stays cheap

A capture is an `index` file (a name → blob directory) plus `store0`, a bag of
independently zlib-compressed blobs. `store0` here is 506 MB and the largest
metallib inside it inflates to 291 MB, so nothing is ever read whole:

- Opening a bundle never enumerates it. Both files live at the top level, so
  the File System Access API looks them up by name and touches nothing else;
  dropped folders cost one directory listing. A capture can easily contain
  100,000 thumbnail and counter files, and walking those blocks the UI for
  seconds to learn nothing.
- `index` is parsed once (about 1 MB) to recover all 13,574 entries.
- Metallibs are found by inflating the first four bytes of each entry above a
  size threshold and testing for `MTLB`.
- Listing functions inflates only up to `bitcode_off`, because the metallib
  function table is laid out *before* the bitcode. For the 291 MB library that
  is 4.1 MB and roughly 85 ms for all 19,823 functions.
- Disassembling inflates up to that one function's bitcode, discarding chunks
  as they arrive so peak memory stays flat, then hands 3–18 KB to `llvm-dis`.

All of it uses `Blob.slice()` (lazy, backed by the file on disk) and the native
`DecompressionStream`, which inflates at roughly 250 MB/s.

`MetalLib` only ever asks its source for `readRange(start, length)`, so a
standalone file needs no special handling — and because `Blob.slice` is real
random access, seeking is free there rather than merely cheap. Fetching the
last function of a 291 MB library takes about 1.1 s through the compressed
store and about 0.5 ms from a plain file.

## Layout

| File | Role |
| --- | --- |
| `locate.js` | finds `index` + `store0` without walking the bundle |
| `gputrace.js` | `index` parser and ranged reads out of `store0` |
| `source.js` | the same ranged-read interface over a plain file |
| `metallib.js` | MTLB header and function table parser |
| `worker.js` | owns the trace, the parsers and `llvm-dis` |
| `app.js` | UI: folder picking, virtualised function list, IR view |
| `llvm-dis.js` / `.wasm` | from [MetalLibraryExplorer](https://github.com/YuAo/MetalLibraryExplorer) (MIT) |
| `vendor/98.css` | from [98.css](https://github.com/jdan/98.css) (MIT), with its fonts |

Everything under `vendor/` is committed rather than fetched from a CDN, so the
tool works with no network at all. 98.css inlines its icons as data URIs; only
the four MS Sans Serif font files sit beside it.

Only the disassembler is borrowed. The upstream SwiftWasm container parser is
not used, which is what removes its 8 MB input limit — that limit was a
workaround for `fstat` misreporting sizes under wasmer, and its design also
base64s every function's bitcode into one JSON blob inside wasm32 memory.

## Tests

```bash
cd .. && npm test      # core parsers + folder scanning
cd .. && npm run smoke # drives the real UI in headless Chrome
```

`test_web_core.mjs` runs `gputrace.js` and `metallib.js` under Node against the
Python reference extraction and checks the bitcode byte for byte.
`test_locate.mjs` mocks both folder-picking APIs over the real directory tree
and asserts the number of listings stays bounded.
