export async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!("storage" in navigator) || !navigator.storage.getDirectory) {
    throw new Error("OPFS is not available in this environment");
  }
  return navigator.storage.getDirectory();
}

export async function mkdirp(path: string): Promise<FileSystemDirectoryHandle> {
  const segments = path.split("/").filter(Boolean);
  let dir = await opfsRoot();
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return { dir: "", name: path };
  return { dir: path.slice(0, idx), name: path.slice(idx + 1) };
}

export async function writeFile(path: string, data: BlobPart): Promise<void> {
  const { dir, name } = splitPath(path);
  const directory = dir ? await mkdirp(dir) : await opfsRoot();
  const tmpName = `.tmp.${name}.${crypto.randomUUID()}`;
  const tmpHandle = await directory.getFileHandle(tmpName, { create: true });
  const writable = await tmpHandle.createWritable();
  try {
    await writable.write(new Blob([data]));
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => undefined);
    await directory.removeEntry(tmpName).catch(() => undefined);
    throw err;
  }
  await directory.removeEntry(name).catch(() => undefined);
  // Atomic-ish rename via move (Chromium supports FileSystemFileHandle.move since 123);
  // fall back to read-then-write for browsers without it.
  const tmpWithMove = tmpHandle as FileSystemFileHandle & {
    move?: (name: string) => Promise<void>;
  };
  if (typeof tmpWithMove.move === "function") {
    await tmpWithMove.move(name);
  } else {
    const finalHandle = await directory.getFileHandle(name, { create: true });
    const final = await finalHandle.createWritable();
    await final.write(await tmpHandle.getFile());
    await final.close();
    await directory.removeEntry(tmpName).catch(() => undefined);
  }
}

export async function readBlob(path: string): Promise<Blob | null> {
  const { dir, name } = splitPath(path);
  try {
    const directory = dir ? await mkdirp(dir) : await opfsRoot();
    const handle = await directory.getFileHandle(name);
    return await handle.getFile();
  } catch (err) {
    if ((err as DOMException).name === "NotFoundError") return null;
    throw err;
  }
}

export async function exists(path: string): Promise<boolean> {
  const blob = await readBlob(path);
  return blob !== null;
}

export async function removeFile(path: string): Promise<void> {
  const { dir, name } = splitPath(path);
  const directory = dir ? await mkdirp(dir) : await opfsRoot();
  await directory.removeEntry(name).catch(() => undefined);
}

export async function removeDir(path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return;
  const last = segments.pop()!;
  let dir = await opfsRoot();
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: false }).catch(() => dir);
  }
  await dir.removeEntry(last, { recursive: true }).catch(() => undefined);
}

export async function fileSize(path: string): Promise<number | null> {
  const blob = await readBlob(path);
  return blob ? blob.size : null;
}

export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}
