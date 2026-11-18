// The git object model, in memory: objects, trees, commits, packs.
//
// Everything a forge needs and nothing it does not: SHA-1 addressed
// blob/tree/commit/tag objects, tree and commit parsing and building,
// pack writing (whole objects only — a pack without deltas is a legal
// pack) and pack reading (with ofs-delta and ref-delta resolution,
// because real clients send deltas). Standard library only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

const TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** One repository's object store. */
export class ObjectStore {
  readonly objects = new Map<string, { type: ObjectType; data: Buffer }>();

  /** Store an object, returning its sha (the git header is part of the hash). */
  write(type: ObjectType, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
    const sha = sha1Hex(Buffer.concat([header, data]));
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  read(sha: string): { type: ObjectType; data: Buffer } | undefined {
    return this.objects.get(sha);
  }

  /**
   * Every object reachable from a commit: the commit, its trees and blobs.
   * With `depthLimit`, only that many commit generations are included and
   * the commits at the boundary are collected into `boundary` (the caller
   * reports them as shallow).
   */
  closure(rootCommits: readonly string[], depthLimit?: number, boundary?: Set<string>): Set<string> {
    const out = new Set<string>();
    const visitTree = (sha: string): void => {
      if (out.has(sha)) return;
      const obj = this.objects.get(sha);
      if (!obj || obj.type !== 'tree') return;
      out.add(sha);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') visitTree(entry.sha);
        else out.add(entry.sha);
      }
    };
    let frontier = [...rootCommits];
    let depth = 0;
    const seenCommits = new Set<string>();
    while (frontier.length > 0) {
      depth += 1;
      const next: string[] = [];
      for (const sha of frontier) {
        if (seenCommits.has(sha)) continue;
        seenCommits.add(sha);
        const obj = this.objects.get(sha);
        if (!obj) continue;
        if (obj.type === 'tag') {
          // An annotated tag: include it and walk to its target.
          out.add(sha);
          const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
          if (m) next.push(m[1]);
          continue;
        }
        if (obj.type !== 'commit') continue;
        out.add(sha);
        const commit = parseCommit(obj.data);
        visitTree(commit.tree);
        if (depthLimit === undefined || depth < depthLimit) next.push(...commit.parents);
        else if (boundary && commit.parents.length > 0) boundary.add(sha);
      }
      frontier = next;
    }
    return out;
  }

  /** Commits reachable from `tip` (inclusive), newest first by walk order. */
  history(tip: string): string[] {
    const order: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha) || !this.objects.has(sha)) continue;
      seen.add(sha);
      order.push(sha);
      const obj = this.objects.get(sha);
      if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
    return order;
  }

  /** True when `ancestor` is `tip` itself or one of its ancestors. */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    return this.history(tip).includes(ancestor);
  }
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.subarray(i, sp).toString('utf8');
    const nul = data.indexOf(0x00, sp);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(data: CommitData): Buffer {
  const lines = [`tree ${data.tree}`];
  for (const p of data.parents) lines.push(`parent ${p}`);
  lines.push(`author ${data.author}`);
  lines.push(`committer ${data.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${data.message}`, 'utf8');
}

/** Flatten a tree into path -> {mode, sha}, recursively. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = ''): Map<string, { mode: string; sha: string }> {
  const out = new Map<string, { mode: string; sha: string }>();
  const obj = store.read(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [k, v] of flattenTree(store, entry.sha, path)) out.set(k, v);
    } else {
      out.set(path, { mode: entry.mode, sha: entry.sha });
    }
  }
  return out;
}

/**
 * Write a (possibly nested) tree from a flat path -> blob map, returning
 * the root tree sha. Paths use '/'; intermediate trees are created.
 */
export function writeTreeFromFlat(store: ObjectStore, files: Map<string, { mode: string; sha: string }>): string {
  interface Node { dirs: Map<string, Node>; files: TreeEntry[] }
  const root: Node = { dirs: new Map(), files: [] };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.push({ mode: file.mode, name: parts[parts.length - 1], sha: file.sha });
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, sha: emit(dir) });
    return store.write('tree', buildTree(entries));
  };
  return emit(root);
}

/** Look up one path in a tree; returns the entry or undefined. */
export function treeLookup(store: ObjectStore, treeSha: string, path: string): TreeEntry | undefined {
  const parts = path.split('/');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = store.read(current);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) return entry;
    if (entry.mode !== '40000') return undefined;
    current = entry.sha;
  }
  return undefined;
}

/** The entries of the tree at `path` ('' for the root), or undefined. */
export function treeEntriesAt(store: ObjectStore, treeSha: string, path: string): TreeEntry[] | undefined {
  if (path === '') {
    const obj = store.read(treeSha);
    return obj && obj.type === 'tree' ? parseTree(obj.data) : undefined;
  }
  const entry = treeLookup(store, treeSha, path);
  if (!entry || entry.mode !== '40000') return undefined;
  const obj = store.read(entry.sha);
  return obj && obj.type === 'tree' ? parseTree(obj.data) : undefined;
}

// ---------------------------------------------------------------- packs

function packEntryHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_IDS[type] << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size >>= 7;
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a pack holding the given objects, whole (no deltas). */
export function buildPack(store: ObjectStore, shas: Iterable<string>): Buffer {
  const list = [...shas];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const sha of list) {
    const obj = store.read(sha);
    if (!obj) throw new Error(`pack: missing object ${sha}`);
    parts.push(packEntryHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream starting at `offset`; returns data + bytes used. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; used: number } {
  // The deflate stream is self-terminating: the shortest prefix that
  // inflates without error is exactly the stream. Binary search it.
  let lo = 1;
  let hi = buf.length - offset;
  // Grow hi until it inflates (it must, at the full remainder).
  const tryLen = (len: number): Buffer | null => {
    try {
      return inflateSync(buf.subarray(offset, offset + len));
    } catch {
      return null;
    }
  };
  let full = tryLen(hi);
  if (full === null) throw new Error('pack: corrupt deflate stream');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tryLen(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  full = tryLen(lo) as Buffer;
  return { data: full, used: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[i];
      i += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('pack: delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[i]; i += 1; }
      if (op & 0x02) { offset |= delta[i] << 8; i += 1; }
      if (op & 0x04) { offset |= delta[i] << 16; i += 1; }
      if (op & 0x08) { offset |= delta[i] << 24; i += 1; }
      if (op & 0x10) { size = delta[i]; i += 1; }
      if (op & 0x20) { size |= delta[i] << 8; i += 1; }
      if (op & 0x40) { size |= delta[i] << 16; i += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      produced += op;
      i += op;
    } else {
      throw new Error('pack: delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('pack: delta size mismatch');
  return result;
}

/**
 * Read a pack into the store. Returns the shas written. Deltas are
 * resolved against objects already in the store or earlier in the pack.
 */
export function readPack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('utf8') !== 'PACK') {
    throw new Error('pack: bad header');
  }
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const pending: Array<{ kind: 'ofs'; entryStart: number; baseOffset: number; delta: Buffer } |
                       { kind: 'ref'; entryStart: number; baseSha: string; delta: Buffer }> = [];
  const written: string[] = [];
  const byOffset = new Map<number, string>();

  for (let n = 0; n < count; n += 1) {
    const entryStart = offset;
    let byte = pack[offset];
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // ofs-delta: negative offset to the base entry, variable length.
      let byte2 = pack[offset];
      offset += 1;
      let baseDelta = byte2 & 0x7f;
      while (byte2 & 0x80) {
        byte2 = pack[offset];
        offset += 1;
        baseDelta = ((baseDelta + 1) << 7) | (byte2 & 0x7f);
      }
      const { data, used } = inflateAt(pack, offset);
      offset += used;
      pending.push({ kind: 'ofs', entryStart, baseOffset: entryStart - baseDelta, delta: data });
    } else if (typeId === 7) {
      const baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, used } = inflateAt(pack, offset);
      offset += used;
      pending.push({ kind: 'ref', entryStart, baseSha, delta: data });
    } else {
      const type = ID_TYPES[typeId];
      if (!type) throw new Error(`pack: unknown type ${typeId}`);
      const { data, used } = inflateAt(pack, offset);
      offset += used;
      if (data.length !== size) throw new Error('pack: size mismatch');
      const sha = store.write(type, data);
      byOffset.set(entryStart, sha);
      written.push(sha);
    }
  }

  // Resolve deltas (a delta's base may itself be a delta: loop until done).
  const resolveOne = (p: (typeof pending)[number]): string | null => {
    let baseSha: string | undefined;
    if (p.kind === 'ofs') baseSha = byOffset.get(p.baseOffset);
    else baseSha = p.baseSha;
    if (!baseSha) return null;
    const base = store.read(baseSha);
    if (!base) return null;
    const data = applyDelta(base.data, p.delta);
    const sha = store.write(base.type, data);
    byOffset.set(p.entryStart, sha);
    return sha;
  };
  let remaining = [...pending];
  let guard = 0;
  while (remaining.length > 0 && guard < 1000) {
    guard += 1;
    const next: typeof remaining = [];
    for (const p of remaining) {
      const sha = resolveOne(p);
      if (sha === null) next.push(p);
      else written.push(sha);
    }
    if (next.length === remaining.length) throw new Error('pack: unresolvable delta');
    remaining = next;
  }
  if (remaining.length > 0) throw new Error('pack: unresolvable delta');
  return written;
}
