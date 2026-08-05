// Reader for Apple .metallib (MTLB) containers, backed by a GpuTrace entry.
//
// Header (little endian):
//   0x00 'MTLB'
//   0x04 u16 platform, u16 version_major, u16 version_minor
//   0x0a u8 type, u8 os, u16 os_major, u16 os_minor
//   0x10 u64 file_size
//   0x18 u64 func_list_off,  u64 func_list_size
//   0x28 u64 pub_md_off,     u64 pub_md_size
//   0x38 u64 priv_md_off,    u64 priv_md_size
//   0x48 u64 bitcode_off,    u64 bitcode_size
//
// The function list is a u32 count followed by per-function tag groups. Each
// group is a u32 size (counting itself) then FourCC/u16-length/payload tags,
// terminated by 'ENDT'. Crucially the list lives *before* the bitcode, so a
// full function listing only needs the first `bitcode_off` bytes inflated.

const HEADER_SIZE = 0x58;
const FUNCTION_TYPES = ["vertex", "fragment", "kernel"];

export class MetalFunction {
  constructor() {
    this.name = null;
    this.type = null;
    this.hash = null;
    this.offsets = null;
    this.bitcodeSize = 0;
    this.airVersion = null;
    this.metalVersion = null;
  }
  get typeName() {
    return FUNCTION_TYPES[this.type] ?? `type${this.type}`;
  }
}

function parseHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "MTLB") {
    throw new Error("not a metallib");
  }
  const u64 = (o) => Number(view.getBigUint64(o, true));
  return {
    platform: view.getUint16(4, true),
    versionMajor: view.getUint16(6, true),
    versionMinor: view.getUint16(8, true),
    type: view.getUint8(0x0a),
    os: view.getUint8(0x0b),
    osMajor: view.getUint16(0x0c, true),
    osMinor: view.getUint16(0x0e, true),
    fileSize: u64(0x10),
    funcListOff: u64(0x18),
    funcListSize: u64(0x20),
    pubMdOff: u64(0x28),
    pubMdSize: u64(0x30),
    privMdOff: u64(0x38),
    privMdSize: u64(0x40),
    bitcodeOff: u64(0x48),
    bitcodeSize: u64(0x50),
  };
}

function parseFunctionList(bytes, offset, size) {
  const blob = bytes.subarray(offset, offset + size);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const decoder = new TextDecoder();
  const count = view.getUint32(0, true);
  const functions = [];
  let pos = 4;

  for (let i = 0; i < count && pos + 4 <= blob.length; i++) {
    const groupSize = view.getUint32(pos, true);
    const end = Math.min(pos + groupSize, blob.length); // size counts itself
    const fn = new MetalFunction();
    let p = pos + 4;

    while (p + 6 <= end) {
      const tag = decoder.decode(blob.subarray(p, p + 4));
      p += 4;
      if (tag === "ENDT") break;
      const len = view.getUint16(p, true);
      p += 2;
      const payload = blob.subarray(p, p + len);
      p += len;

      switch (tag) {
        case "NAME": {
          let n = payload.length;
          while (n > 0 && payload[n - 1] === 0) n--;
          fn.name = decoder.decode(payload.subarray(0, n));
          break;
        }
        case "TYPE":
          fn.type = payload[0];
          break;
        case "HASH":
          fn.hash = Array.from(payload, (b) => b.toString(16).padStart(2, "0")).join("");
          break;
        case "OFFT":
        case "OFST": {
          if (len === 24) {
            const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            fn.offsets = [0, 8, 16].map((o) => Number(dv.getBigUint64(o, true)));
          }
          break;
        }
        case "MDSZ": {
          const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          fn.bitcodeSize = Number(dv.getBigUint64(0, true));
          break;
        }
        case "VERS": {
          const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          fn.airVersion = [dv.getUint16(0, true), dv.getUint16(2, true)];
          fn.metalVersion = [dv.getUint16(4, true), dv.getUint16(6, true)];
          break;
        }
      }
    }
    functions.push(fn);
    pos = end;
  }
  return functions;
}

export class MetalLib {
  constructor(source, header, functions) {
    this.source = source;
    this.header = header;
    this.functions = functions;
  }

  get name() {
    return this.source.name;
  }

  /**
   * Reads only as far as the end of the function list, which the format places
   * before the bitcode. For a 291 MB library that is roughly 4 MB.
   */
  static async open(source) {
    const head = await source.readRange(0, HEADER_SIZE);
    if (head.length < HEADER_SIZE) throw new Error("truncated before header");
    const header = parseHeader(head);
    const toc = await source.readRange(header.funcListOff, header.funcListSize);
    return new MetalLib(source, header, parseFunctionList(toc, 0, header.funcListSize));
  }

  /** Read just this function's AIR module (typically 3-18 KB). */
  bitcode(fn, onProgress) {
    if (!fn.offsets) throw new Error(`${fn.name}: no bitcode offset`);
    return this.source.readRange(
      this.header.bitcodeOff + fn.offsets[2],
      fn.bitcodeSize,
      onProgress,
    );
  }
}
