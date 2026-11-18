// Git smart HTTP: upload-pack protocol v2 (ls-refs, fetch) with a v0
// fallback, and receive-pack v0 with report-status.
//
// The wire, briefly: pkt-lines everywhere (4 hex digits of length,
// 0000 flush, 0001 delimiter). Advertisements open with the
// "# service=..." preamble in v0 and with "version 2" in v2. Fetches
// answer with a pack built from the object store, framed in
// side-band-64k. Pushes carry ref commands plus a pack; every update
// must fast-forward, and the report says so per ref.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildPack, parseCommit, readPack } from './git.ts';
import { VIEWER, type Forge, type Repo } from './store.ts';
import { readBody } from './rest.ts';

const ZERO = '0'.repeat(40);
const PKT_MAX_PAYLOAD = 65520 - 4;

// ------------------------------------------------------------ pkt-lines

export function pkt(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line too long');
  const header = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Parse as many whole pkt-lines as `buf` holds; returns them + bytes used. */
export function parsePkts(buf: Buffer, offset = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let i = offset;
  while (i + 4 <= buf.length) {
    const header = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const len = parseInt(header, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, next: i };
}

function lines(packets: Packet[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
}

// ------------------------------------------------------------ refs

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** Every ref the server names, HEAD first, the rest sorted. */
function refLines(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (headOid) out.push({ oid: headOid, name: 'HEAD', symrefTarget: headRef });
  else out.push({ oid: ZERO, name: 'HEAD', symrefTarget: headRef, unborn: true });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const peeled = peel(repo, oid);
    if (peeled && peeled !== oid) line.peeled = peeled;
    out.push(line);
  }
  return out;
}

/** Follow tag objects to the commit they name. */
function peel(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 10; guard += 1) {
    const obj = repo.store.read(current);
    if (!obj || obj.type !== 'tag') return current;
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (!m) return current;
    current = m[1];
  }
  return current;
}

// ------------------------------------------------------------ advertisements

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}`
    : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = refLines(repo).filter((r) => !(r.unborn && r.name === 'HEAD'));
  if (refs.length === 0 && repo.refs.size === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const all = refLines(repo);
    for (const ref of all) {
      if (ref.unborn) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (first) {
        line += `\0${caps}`;
        first = false;
      }
      parts.push(pkt(`${line}\n`));
      if (ref.peeled) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
    if (first) {
      // Only an unborn HEAD: advertise it with the zero oid.
      parts.push(pkt(`${ZERO} HEAD\0${caps}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pkt('version 2\n'),
    pkt('agent=forge/1.0\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done filter\n'),
    pkt('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ ls-refs (v2)

function lsRefs(repo: Repo, packets: Packet[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines(packets)) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  for (const ref of refLines(repo)) {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;
    if (ref.unborn) {
      if (!unborn) continue;
      let line = `unborn ${ref.name}`;
      if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      parts.push(pkt(`${line}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
  deepenSince?: number;
  deepenNot: string[];
  done: boolean;
  filter?: string;
}

function parseFetchArgs(packets: Packet[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [], done: false };
  for (const line of lines(packets)) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
    else if (line === 'done') args.done = true;
  }
  return args;
}

/**
 * The object set for a fetch: the wants' closure (depth-limited when
 * asked), minus everything the client already has (the haves' closure
 * and the trees below its shallow boundary).
 */
function fetchObjects(repo: Repo, args: FetchArgs): { objects: Set<string>; boundary: Set<string> } {
  const store = repo.store;
  const boundary = new Set<string>();
  let objects: Set<string>;
  const wants = args.wants.filter((w) => store.has(w));

  if (args.deepen !== undefined) {
    // `deepen N` sets the total depth from the wants (the suite's
    // deepen check: a depth-1 clone deepened by 2 gains exactly the
    // second generation, and the boundary moves to it).
    objects = store.closure(wants, args.deepen, boundary);
  } else if (args.deepenSince !== undefined) {
    // Depth by time: walk until commits older than the cutoff.
    objects = new Set<string>();
    const queue = [...wants];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = store.read(sha);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      const m = / (\d+) [+-]\d{4}$/.exec(commit.committer);
      const epoch = m ? Number(m[1]) : 0;
      for (const s of store.closure([sha], 1)) objects.add(s);
      if (epoch < (args.deepenSince as number)) {
        if (commit.parents.length > 0) boundary.add(sha);
        continue;
      }
      queue.push(...commit.parents);
    }
  } else {
    objects = store.closure(wants);
  }

  // Exclude what the client has: the haves' closure, deepen-not tips,
  // and — for an undeepened fetch — the ancestors of the client's
  // shallow commits (it holds the boundary commits themselves).
  const exclude = new Set<string>();
  const addClosure = (tips: string[]): void => {
    for (const sha of store.closure(tips.filter((t) => store.has(t)))) exclude.add(sha);
  };
  // A have that is also the client's shallow boundary is only held
  // down to that boundary: exclude its own generation (the commit and
  // its tree), never its ancestors — deepening exists to deliver them.
  for (const h of args.haves) {
    if (args.shallow.includes(h)) {
      for (const sha of store.closure([h], 1)) exclude.add(sha);
    } else {
      addClosure([h]);
    }
  }
  addClosure(args.deepenNot);
  if (args.deepen === undefined && args.deepenSince === undefined) {
    for (const s of args.shallow) {
      const obj = store.read(s);
      if (obj && obj.type === 'commit') addClosure(parseCommit(obj.data).parents);
    }
  }
  for (const sha of exclude) objects.delete(sha);

  // Filters (partial clone): blob:none drops blobs, tree:0 drops trees too.
  if (args.filter) {
    const f = args.filter;
    for (const sha of [...objects]) {
      const obj = store.read(sha);
      if (!obj) continue;
      if (obj.type === 'blob' && (f === 'blob:none' || f.startsWith('blob:limit'))) {
        if (f === 'blob:none') objects.delete(sha);
        else {
          const limit = Number(f.slice('blob:limit='.length)) || 0;
          if (obj.data.length > limit) objects.delete(sha);
        }
      }
      if (obj.type === 'tree' && f === 'tree:0') objects.delete(sha);
    }
  }
  return { objects, boundary };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunkSize = PKT_MAX_PAYLOAD - 1;
  for (let i = 0; i < pack.length; i += chunkSize) {
    const chunk = pack.subarray(i, i + chunkSize);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pkt(Buffer.from([1])));
  return parts;
}

function fetchV2(repo: Repo, packets: Packet[]): Buffer {
  const args = parseFetchArgs(packets);
  const { objects, boundary } = fetchObjects(repo, args);
  const parts: Buffer[] = [];

  if (args.haves.length > 0) {
    parts.push(pkt('acknowledgments\n'));
    const known = args.haves.filter((h) => repo.store.read(h)?.type === 'commit');
    if (known.length === 0) {
      parts.push(pkt('NAK\n'));
    } else {
      for (const h of known) parts.push(pkt(`ACK ${h}\n`));
      if (args.done) parts.push(pkt('ready\n'));
    }
    parts.push(PKT_DELIM);
  }

  if (args.deepen !== undefined || args.deepenSince !== undefined || args.shallow.length > 0) {
    const unshallow = args.shallow.filter((s) => !boundary.has(s) && repo.store.read(s)?.type === 'commit'
      && parseCommit(repo.store.read(s)?.data as Buffer).parents.length === 0);
    if (boundary.size > 0 || unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const b of boundary) parts.push(pkt(`shallow ${b}\n`));
      for (const u of unshallow) parts.push(pkt(`unshallow ${u}\n`));
      parts.push(PKT_DELIM);
    }
  }

  parts.push(pkt('packfile\n'));
  const pack = buildPack(repo.store, objects);
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, packets: Packet[]): Buffer {
  // Two sections: wants (+shallow/deepen) flushed, then haves/done flushed.
  const args = parseFetchArgs(packets);
  const { objects, boundary } = fetchObjects(repo, args);
  const parts: Buffer[] = [];
  for (const b of boundary) parts.push(pkt(`shallow ${b}\n`));
  const known = args.haves.filter((h) => repo.store.read(h)?.type === 'commit');
  if (known.length > 0) parts.push(pkt(`ACK ${known[known.length - 1]}\n`));
  else parts.push(pkt('NAK\n'));
  const pack = buildPack(repo.store, objects);
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string[];
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, next } = parsePkts(body, 0);
  const commands: PushCommand[] = [];
  let sideband = false;
  let reportStatus = false;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    let caps: string[] = [];
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    const [oldOid, newOid, ref] = line.split(' ');
    if (oldOid && newOid && ref) commands.push({ oldOid, newOid, ref, caps });
    if (caps.includes('side-band-64k')) sideband = true;
    if (caps.includes('report-status')) reportStatus = true;
  }

  void next;
  // The pack starts right after the command list's terminating flush:
  // walk the pkt-lines (data packets are `len` bytes whole, control
  // packets are just the 4-byte header) until the flush.
  let packStart = body.length;
  {
    let i = 0;
    while (i + 4 <= body.length) {
      const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) break;
      i += len < 4 ? 4 : len;
      if (len === 0) {
        packStart = i;
        break;
      }
    }
  }
  const pack = body.subarray(packStart);

  let unpackOk = true;
  let unpackError = '';
  if (pack.length > 0) {
    try {
      readPack(repo.store, Buffer.from(pack));
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : 'unpack error';
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackError || 'error'}`];
  for (const cmd of commands) {
    reportLines.push(applyPushCommand(repo, cmd, unpackOk));
  }

  if (!reportStatus) return Buffer.alloc(0);
  const reportParts: Buffer[] = reportLines.map((l) => pkt(`${l}\n`));
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (!sideband) return report;
  // The report stream travels inside band 1, itself pkt-framed.
  const wrapped: Buffer[] = [];
  const chunkSize = PKT_MAX_PAYLOAD - 1;
  for (let i = 0; i < report.length; i += chunkSize) {
    wrapped.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(i, i + chunkSize)])));
  }
  wrapped.push(PKT_FLUSH);
  return Buffer.concat(wrapped);
}

function applyPushCommand(repo: Repo, cmd: PushCommand, unpackOk: boolean): string {
  const { oldOid, newOid, ref } = cmd;
  if (!unpackOk) return `ng ${ref} unpacker error`;
  const current = repo.refs.get(ref) ?? ZERO;
  const isDelete = newOid === ZERO;
  const isCreate = oldOid === ZERO;

  if (isDelete) {
    if (!repo.refs.has(ref)) return `ng ${ref} reference does not exist`;
    if (oldOid !== current) return `ng ${ref} stale info`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }

  const newObj = repo.store.read(newOid);
  if (!newObj) return `ng ${ref} missing object`;
  const isTagRef = ref.startsWith('refs/tags/');
  if (!isTagRef && newObj.type !== 'commit') return `ng ${ref} not a commit`;
  if (isTagRef && newObj.type !== 'commit' && newObj.type !== 'tag') return `ng ${ref} not a commit`;

  if (isCreate) {
    if (repo.refs.has(ref)) return `ng ${ref} already exists`;
  } else {
    if (oldOid !== current) return `ng ${ref} stale info`;
    if (!isTagRef && current !== ZERO && !repo.store.isAncestor(current, newOid)) {
      return `ng ${ref} non-fast-forward`;
    }
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

// ------------------------------------------------------------ HTTP routing

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    pragma: 'no-cache',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
  });
  res.end(body);
}

export async function handleGit(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!m) return false;
  const owner = decodeURIComponent(m[1]);
  const repoName = decodeURIComponent(m[2]);
  const endpoint = m[3];

  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${token}`) {
    sendBuffer(res, 401, 'text/plain; charset=utf-8', Buffer.from('Authentication required\n'));
    return true;
  }
  const repo = owner === VIEWER.login ? forge.getRepo(owner, repoName) : undefined;
  if (!repo) {
    sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('Repository not found\n'));
    return true;
  }

  if (endpoint === 'info/refs' && req.method === 'GET') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('Bad service\n'));
      return true;
    }
    const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    sendBuffer(res, 200, `application/x-${service}-advertisement`, body);
    return true;
  }

  if (endpoint === 'git-upload-pack' && req.method === 'POST') {
    const body = await readBody(req);
    const { packets } = parsePkts(body, 0);
    const firstLine = packets.find((p) => p.kind === 'data')?.payload.toString('utf8') ?? '';
    const isV2 = firstLine.startsWith('command=');
    const out = isV2
      ? firstLine.startsWith('command=ls-refs')
        ? lsRefs(repo, packets)
        : fetchV2(repo, packets)
      : fetchV0(repo, packets);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', out);
    return true;
  }

  if (endpoint === 'git-receive-pack' && req.method === 'POST') {
    const body = await readBody(req);
    const out = receivePack(repo, body);
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', out);
    return true;
  }

  sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('Not found\n'));
  return true;
}
