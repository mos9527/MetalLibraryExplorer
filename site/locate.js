// Finding `index` + `store0` inside a picked or dropped folder.
//
// A .gputrace keeps both files at its top level, so nothing here walks the
// whole tree. That matters: a capture can hold six figures of thumbnails and
// raw counter files, and enumerating those costs seconds of main-thread time
// to learn nothing. Look in the chosen directory, then one level down in case
// the user picked the parent, and stop the moment both files turn up.

import { isMetalSource, isText } from "./msl.js";

const MAX_DEPTH = 1;

/** File System Access API. Looks files up by name, never lists the directory. */
export async function bundleFromDirHandle(dir, depth = 0) {
  try {
    const [index, store0] = await Promise.all([
      dir.getFileHandle("index").then((h) => h.getFile()),
      dir.getFileHandle("store0").then((h) => h.getFile()),
    ]);
    return { dir: dir.name, index, store0 };
  } catch { /* not this directory */ }

  if (depth >= MAX_DEPTH) return null;
  for await (const handle of dir.values()) {
    if (handle.kind !== "directory") continue;
    const hit = await bundleFromDirHandle(handle, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const readEntries = (reader) =>
  new Promise((resolve, reject) => reader.readEntries(resolve, reject));

async function listDir(entry) {
  const reader = entry.createReader();
  const all = [];
  for (;;) {
    const batch = await readEntries(reader);
    if (!batch.length) return all;
    all.push(...batch);
  }
}

export const fileOf = (entry) =>
  new Promise((resolve, reject) => entry.file(resolve, reject));

/** Sniff the contents rather than trusting the extension. */
export async function isShader(file) {
  if (file.size < 4) return false;
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (String.fromCharCode(...head.subarray(0, 4)) === "MTLB") return true;
  return isMetalSource(head) || (/\.(metal|msl)$/i.test(file.name) && isText(head));
}

/** Which of these dropped files are a library or a Metal source? */
export async function shadersAmong(files) {
  const flags = await Promise.all(files.map((f) => isShader(f).catch(() => false)));
  return files.filter((_, i) => flags[i]);
}

/** Drag and drop, via webkitGetAsEntry. */
export async function bundleFromDropEntry(entry, depth = 0) {
  if (!entry.isDirectory) return null;
  const children = await listDir(entry);
  const byName = new Map(children.map((c) => [c.name, c]));
  const index = byName.get("index");
  const store0 = byName.get("store0");
  if (index?.isFile && store0?.isFile) {
    return { dir: entry.name, index: await fileOf(index), store0: await fileOf(store0) };
  }
  if (depth >= MAX_DEPTH) return null;
  for (const child of children) {
    if (!child.isDirectory) continue;
    const hit = await bundleFromDropEntry(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Fallback for browsers without the File System Access API, where a
 * <input webkitdirectory> hands us the whole tree whether we want it or not.
 */
export function bundleFromFileList(files) {
  const dirs = new Map();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    const cut = path.lastIndexOf("/");
    const base = path.slice(cut + 1);
    if (base !== "index" && base !== "store0") continue;
    const dir = cut < 0 ? "" : path.slice(0, cut);
    if (!dirs.has(dir)) dirs.set(dir, {});
    dirs.get(dir)[base] = file;
  }
  for (const [dir, found] of dirs) {
    if (found.index && found.store0) return { dir, ...found };
  }
  return null;
}
