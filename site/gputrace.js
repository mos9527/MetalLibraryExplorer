// Reader for the `index` + `store0` pair inside an Xcode .gputrace bundle.
//
// index layout (little endian):
//   0x00  'xdic', u32 version
//   0x08  u32 bucket_count, u32 entry_count, u32 entry_count
//   0x14  u32 hash_buckets[bucket_count]
//         24-byte entries[entry_count]: u32 usize, u32 csize, u64 offset, u32, u32
//         u16 name_lengths[entry_count]
//         NUL-terminated names[entry_count]
//
// store0 holds each blob as an independent zlib stream at (offset, csize).
// Nothing here reads store0 whole: every access is a Blob.slice piped through
// DecompressionStream, so a 500 MB store costs no more memory than the slice
// currently being consumed.

const ENTRY_SIZE = 24;
const NAME_LEN_SIZE = 2;

export class Entry {
  constructor(index, name, usize, csize, offset) {
    this.index = index;
    this.name = name;
    this.usize = usize;
    this.csize = csize;
    this.offset = offset;
  }
  get stored() {
    return this.csize === this.usize;
  }
}

export class GpuTrace {
  constructor(indexBuffer, storeBlob) {
    this.store = storeBlob;
    this.view = new DataView(indexBuffer);
    this.bytes = new Uint8Array(indexBuffer);

    const magic = new TextDecoder().decode(this.bytes.subarray(0, 4));
    if (magic !== "xdic") throw new Error(`not a gputrace index (magic "${magic}")`);
    this.count = this.view.getUint32(12, true);
    this.entries = this.#parse();
  }

  static async open(indexFile, storeFile) {
    return new GpuTrace(await indexFile.arrayBuffer(), storeFile);
  }

  // The u16 length array sitting between the entry table and the name blob has
  // a slightly fuzzy size, so derive a guess from the names and then slide the
  // table start until every sampled entry addresses a real region of the store.
  #locateTable(guess) {
    const storeSize = this.store.size;
    const step = Math.max(1, Math.floor(this.count / 200));
    for (let delta = -64; delta <= 64; delta++) {
      const off = guess + delta;
      if (off < 20 || off + this.count * ENTRY_SIZE > this.bytes.length) continue;
      let ok = true;
      for (let i = 0; i < this.count; i += step) {
        const p = off + i * ENTRY_SIZE;
        const usize = this.view.getUint32(p, true);
        const csize = this.view.getUint32(p + 4, true);
        const soff = Number(this.view.getBigUint64(p + 8, true));
        if (usize === 0 || csize === 0 || soff + csize > storeSize) {
          ok = false;
          break;
        }
      }
      if (ok) return off;
    }
    throw new Error("could not locate the index entry table");
  }

  #findNamesStart() {
    // walk back over `count` NUL terminators from the end of the file
    let pos = this.bytes.length;
    for (let seen = 0; seen < this.count && pos > 0; seen++) {
      pos = this.bytes.lastIndexOf(0, pos - 1);
      if (pos < 0) return 0;
    }
    return pos + 1;
  }

  #parse() {
    const guess = this.#findNamesStart() - this.count * (ENTRY_SIZE + NAME_LEN_SIZE);
    const tableOffset = this.#locateTable(guess);
    this.tableOffset = tableOffset;
    const namesOffset = tableOffset + this.count * (ENTRY_SIZE + NAME_LEN_SIZE);

    const decoder = new TextDecoder();
    const entries = [];
    let namePos = namesOffset;
    for (let i = 0; i < this.count; i++) {
      let end = this.bytes.indexOf(0, namePos);
      if (end < 0) end = this.bytes.length;
      const name = decoder.decode(this.bytes.subarray(namePos, end));
      namePos = end + 1;

      const p = tableOffset + i * ENTRY_SIZE;
      entries.push(new Entry(
        i,
        name,
        this.view.getUint32(p, true),
        this.view.getUint32(p + 4, true),
        Number(this.view.getBigUint64(p + 8, true)),
      ));
    }
    return entries;
  }

  #reader(entry) {
    const slice = this.store.slice(entry.offset, entry.offset + entry.csize);
    if (entry.stored) return slice.stream().getReader();
    return slice.stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  }

  readPrefix(entry, length) {
    return this.readRange(entry, 0, length);
  }

  read(entry) {
    return this.readRange(entry, 0, entry.usize);
  }

  /** A random-access view of one entry, for consumers that don't know or care
   *  that the bytes live inside a compressed store. */
  source(entry) {
    return {
      name: entry.name,
      size: entry.usize,
      readRange: (start, length, onProgress) =>
        this.readRange(entry, start, length, onProgress),
    };
  }

  /**
   * Read `length` bytes starting at `start` in the *inflated* blob. Chunks
   * before `start` are discarded as they arrive, so peak memory stays flat no
   * matter how deep the range sits.
   */
  async readRange(entry, start, length, onProgress) {
    if (entry.stored) {
      const at = entry.offset + start;
      return new Uint8Array(await this.store.slice(at, at + length).arrayBuffer());
    }
    const reader = this.#reader(entry);
    const out = new Uint8Array(length);
    let pos = 0;
    let filled = 0;
    try {
      while (filled < length) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkStart = pos;
        pos += value.length;
        if (pos > start) {
          const from = Math.max(0, start - chunkStart);
          const to = Math.min(value.length, start + length - chunkStart);
          if (to > from) {
            out.set(value.subarray(from, to), filled);
            filled += to - from;
          }
        } else if (onProgress) {
          onProgress(pos, start);
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return out.subarray(0, filled);
  }

  /** Entries whose inflated contents begin with `magic`. */
  async findByMagic(magic, minSize = 64 * 1024) {
    const want = new TextEncoder().encode(magic);
    const candidates = this.entries.filter((e) => e.usize >= minSize);
    const hits = [];
    const BATCH = 32;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      const heads = await Promise.all(batch.map((e) =>
        this.readPrefix(e, want.length).catch(() => new Uint8Array())));
      heads.forEach((head, j) => {
        if (head.length === want.length && want.every((b, k) => head[k] === b)) {
          hits.push(batch[j]);
        }
      });
    }
    return hits.sort((a, b) => b.usize - a.usize);
  }
}
