// A "source" is anything a metallib can be read out of: an object exposing
// `readRange(start, length)` plus a name and a size. GpuTrace builds one that
// inflates on the fly; this one wraps a plain file, where ranged reads are
// free because Blob.slice is already lazy.

export function blobSource(blob, name = blob.name ?? "metallib") {
  return {
    name,
    size: blob.size,
    async readRange(start, length) {
      const end = Math.min(start + length, blob.size);
      if (end <= start) return new Uint8Array(0);
      return new Uint8Array(await blob.slice(start, end).arrayBuffer());
    },
  };
}
