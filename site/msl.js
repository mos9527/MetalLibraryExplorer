// Metal Shading Language sources carried inside a capture.
//
// Not every capture holds compiled libraries. Shaders built from a string at
// runtime, or compiled with source recording on, leave the MSL text in the
// store instead, under the same content-hash names the metallibs use. Those
// blobs fit the browsing model unchanged: a blob is a library, its entry points
// are its functions. There is no bitcode to disassemble, so "inspecting" a
// function means showing the source at its declaration.

/** MSL is C++, but these markers only turn up in Metal sources. */
const MARKERS =
  /metal_stdlib|namespace\s+metal|#include\s*<metal|\[\[\s*(?:kernel|vertex|fragment)\s*\]\]|^[ \t]*(?:kernel|vertex|fragment)[ \t]+[\w:]/m;

/**
 * Entry point declarations, in either the qualifier form Unity and the offline
 * compiler emit (`fragment half4 main(`) or the attribute form (`[[kernel]]
 * void main(`). Anchored to the start of a line so a `vertex` used as an
 * argument name or a struct field cannot match.
 */
const ENTRY =
  /^[ \t]*(?:\[\[[ \t]*(vertex|fragment|kernel)[ \t]*\]\]|(vertex|fragment|kernel))[ \t]+([A-Za-z_][\w:<>, \t*&]*?)[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm;

const CONTROL_OK = new Set([9, 10, 13]);

/** The store keeps sources NUL-terminated, so drop the terminator. */
export function trimNul(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

/** No control bytes, which throws out every binary blob in a capture. */
export function isText(head) {
  for (const b of trimNul(head)) {
    if (b < 0x20 && !CONTROL_OK.has(b)) return false;
  }
  return head.length > 0;
}

/**
 * Does this prefix look like Metal source? Text alone is not enough — a capture
 * also carries plists and JSON — so demand a Metal marker as well. Every
 * generator puts its includes first, so a 1 KB prefix is plenty to decide.
 */
export function isMetalSource(head) {
  return isText(head) && MARKERS.test(new TextDecoder().decode(trimNul(head)));
}

/** Entry points in declaration order, each with the line it starts on. */
export function entryPoints(text) {
  const found = [];
  let line = 1;
  let scanned = 0;
  for (const m of text.matchAll(ENTRY)) {
    const offset = m.index + m[0].length - m[0].trimStart().length;
    while (scanned < offset) {
      if (text.charCodeAt(scanned++) === 10) line++;
    }
    found.push({
      name: m[4],
      type: m[1] ?? m[2],
      returns: m[3].trim().replace(/[ \t]+/g, " "),
      line,
      offset,
    });
  }
  return found;
}

export class MetalSource {
  constructor(name, text) {
    this.name = name;
    this.text = text;
    this.functions = entryPoints(text);
  }

  static async open(source) {
    const bytes = await source.readRange(0, source.size);
    return new MetalSource(source.name, new TextDecoder().decode(trimNul(bytes)));
  }
}
