// git.ts — git smart HTTP: pkt-line codec, packfile read/write, and the
// upload-pack (v0 + v2) / receive-pack (v0) handlers.
//
// The suite speaks the protocol in-process with no git binary on either side,
// so this is a real implementation: objects are hashed, packed and verified
// here, in pure Node (node:zlib + node:crypto only).

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import type { GitObject, ObjectType, Repo } from './store.ts';
import {
  ZERO_OID,
  buildTree,
  closureOf,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line codec (git's framing: 4 hex digits of length incl. the 4, then payload).

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
const PKT_MAX = 65520;

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  const out = Buffer.alloc(length);
  out.write(length.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  payload.copy(out, 4);
  return out;
}

export type Pkt = { kind: 'data' | 'flush' | 'delim'; payload: Buffer };

/** Decode a whole buffer of pkt-lines. Throws on anything that is not one. */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line header is truncated');
    const length = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0 || length > PKT_MAX + 4) throw new Error('pkt-line length is not valid');
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + length > buffer.length) throw new Error('pkt-line payload is truncated');
    out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return out;
}

/** The data payloads of a pkt-line stream, as strings (flush/delim skipped, trailing newline stripped). */
export function pktStrings(buffer: Buffer): string[] {
  return decodePktLines(buffer)
    .filter((pkt) => pkt.kind === 'data')
    .map((pkt) => pkt.payload.toString('utf8').replace(/\r?\n$/, ''));
}

/** Split a receive-pack body into command lines and the raw pack that follows. */
export function splitPackBody(body: Buffer): { commands: string[]; pack: Buffer } {
  let offset = 0;
  const commands: string[] = [];
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0) throw new Error('pkt-line length is not valid');
    if (length === 0) {
      offset += 4;
      break;
    }
    if (offset + length > body.length) throw new Error('pkt-line payload is truncated');
    commands.push(body.subarray(offset + 4, offset + length).toString('utf8'));
    offset += length;
  }
  return { commands, pack: body.subarray(offset) };
}

// ---------------------------------------------------------------------------
// Packfiles.

export interface PackEntry {
  type: ObjectType;
  oid: string;
  data: Buffer;
}

/** Apply a git delta (copy/insert ops) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset |= delta[offset] << (i * 8);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize |= delta[offset] << (i * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert is truncated');
      if (written + op > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Inflate the deflate stream starting at `offset`, whose inflated size is
 * `expectedSize`. inflateSync ignores trailing bytes and throws on a cut
 * stream, so the stream's end is the smallest prefix that inflates cleanly
 * to the expected size; it is found by binary search.
 */
function inflateAt(buffer: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  let low = 0;
  let high = buffer.length - offset;
  const tries = (length: number): Buffer | null => {
    try {
      const out = inflateSync(buffer.subarray(offset, offset + length));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  if (tries(high) === null) throw new Error('deflate stream is truncated');
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (tries(mid) !== null) high = mid;
    else low = mid;
  }
  const data = tries(high);
  if (data === null) throw new Error('deflate stream is truncated');
  return { data, consumed: high };
}

/** Parse a packfile. Verifies the trailer checksum and the declared count. */
export function parsePack(buffer: Buffer): PackEntry[] {
  if (buffer.length < 12) throw new Error('pack is too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack magic is not PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = buffer.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryStart = offset;
    let byte = buffer[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buffer[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let deltaBase: { kind: 'ofs'; baseOffset: number } | { kind: 'ref'; baseOid: string } | null = null;
    if (typeCode === 6) {
      byte = buffer[offset];
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buffer[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      deltaBase = { kind: 'ofs', baseOffset: entryStart - baseOffset };
    } else if (typeCode === 7) {
      deltaBase = { kind: 'ref', baseOid: buffer.subarray(offset, offset + 20).toString('hex') };
      offset += 20;
    }
    const { data: raw, consumed } = inflateAt(buffer, offset, size);
    offset += consumed;
    let type: ObjectType;
    let data: Buffer;
    if (deltaBase === null) {
      type = typeCode === 1 ? 'commit' : typeCode === 2 ? 'tree' : typeCode === 3 ? 'blob' : typeCode === 4 ? 'tag' : (() => { throw new Error(`pack object type ${typeCode} is not supported`); })();
      data = raw;
    } else {
      const baseEntry = deltaBase.kind === 'ofs'
        ? byOffset.get(deltaBase.baseOffset)
        : entries.find((entry) => entry.oid === deltaBase.baseOid);
      if (!baseEntry) throw new Error('delta base is not in the pack');
      type = baseEntry.type;
      data = applyDelta(baseEntry.data, raw);
    }
    const entry: PackEntry = { type, oid: hashObject(type, data), data };
    entries.push(entry);
    byOffset.set(entryStart, entry);
  }
  if (entries.length !== count) throw new Error('pack count does not match its entries');
  if (offset + 20 > buffer.length) throw new Error('pack trailer is missing');
  const trailer = buffer.subarray(offset, offset + 20);
  const digest = createHash('sha1').update(buffer.subarray(0, offset)).digest();
  if (!digest.equals(trailer)) throw new Error('pack trailer checksum does not match');
  return entries;
}

/** Write plain (non-delta) objects as a v2 pack, entries sorted by oid. */
export function writePack(objects: Map<string, GitObject> | GitObject[]): Buffer {
  const list = (objects instanceof Map ? [...objects.values()] : objects).slice();
  list.sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    const typeCode = obj.type === 'commit' ? 1 : obj.type === 'tree' ? 2 : obj.type === 'blob' ? 3 : 4;
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let byte = (typeCode << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) byte |= 0x80;
    headerBytes.push(byte);
    while (remaining > 0) {
      byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

// ---------------------------------------------------------------------------
// Fetch object selection.
//
// The walk starts at the wants with a depth limit (the want is depth 1). A
// commit the client already holds (a have, with its full closure) is neither
// sent nor walked past — except that a commit the client lists as shallow is
// held without its parents, so the parents stay sendable. Commits at exactly
// the depth limit are the new shallow boundary; a shallow commit whose
// parents are now sent becomes unshallow.

export interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

export function selectFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowLines: string[],
  depth: number | null,
): FetchSelection {
  const getObject = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const exclusion = closureOf(getObject, haves);
  for (const shallowOid of shallowLines) {
    const obj = getObject(shallowOid);
    if (obj && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) {
        for (const oid of closureOf(getObject, [parent])) exclusion.delete(oid);
      }
    }
  }
  const includedCommits = new Set<string>();
  const shallowOut: string[] = [];
  const shallowSet = new Set(shallowLines);
  const visited = new Set<string>();
  const queue: [string, number][] = [];
  for (const want of wants) {
    const peeled = peelToCommit(getObject, want);
    if (peeled) queue.push([peeled, 1]);
    else if (getObject(want)?.type === 'commit') queue.push([want, 1]);
  }
  let head = 0;
  while (head < queue.length) {
    const [oid, dist] = queue[head];
    head += 1;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (exclusion.has(oid) && !shallowSet.has(oid)) continue;
    if (exclusion.has(oid)) {
      // Held but shallow: the client has this commit and not its parents, so
      // a deepen descends past it (unless the depth limit is already met).
      if (depth !== null && dist >= depth) continue;
      for (const parent of parseCommit(obj.data).parents) queue.push([parent, dist + 1]);
      continue;
    }
    includedCommits.add(oid);
    if (depth !== null && dist >= depth) {
      shallowOut.push(oid);
      continue;
    }
    for (const parent of parseCommit(obj.data).parents) queue.push([parent, dist + 1]);
  }
  const unshallowOut: string[] = [];
  for (const shallowOid of shallowLines) {
    const obj = getObject(shallowOid);
    if (obj && obj.type === 'commit') {
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0 && parents.every((parent) => includedCommits.has(parent))) unshallowOut.push(shallowOid);
    }
  }
  const objects = new Map<string, GitObject>();
  for (const want of wants) {
    const obj = getObject(want);
    if (obj && obj.type === 'tag' && !exclusion.has(want)) objects.set(want, obj);
  }
  for (const oid of includedCommits) {
    const commit = parseCommit((getObject(oid) as GitObject).data);
    objects.set(oid, getObject(oid) as GitObject);
    const stack = [commit.tree];
    while (stack.length > 0) {
      const treeOid = stack.pop() as string;
      if (exclusion.has(treeOid) || objects.has(treeOid)) continue;
      const treeObj = getObject(treeOid);
      if (!treeObj || treeObj.type !== 'tree') continue;
      objects.set(treeOid, treeObj);
      for (const entry of parseTree(treeObj.data)) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else if (!exclusion.has(entry.oid) && !objects.has(entry.oid)) {
          const blob = getObject(entry.oid);
          if (blob) objects.set(entry.oid, blob);
        }
      }
    }
  }
  return { objects, shallow: shallowOut, unshallow: unshallowOut };
}

// ---------------------------------------------------------------------------
// Advertisements.

const AGENT = 'forge/1.0';

interface RefLine {
  name: string;
  oid: string;
}

function sortedRefs(repo: Repo): RefLine[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function peeledCommit(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj) return undefined;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') return peelToCommit((id) => repo.objects.get(id), oid);
  return undefined;
}

function headOid(repo: Repo): string {
  return repo.refs.get('refs/heads/main') ?? ZERO_OID;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'symref=HEAD:refs/heads/main multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag agent=forge/1.0'
    : 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid(repo)} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (service === 'git-upload-pack' && ref.name.startsWith('refs/tags/')) {
        const peeled = peeledCommit(repo, ref.oid);
        if (peeled && peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('object-format=sha1\n'),
    pktLine('fetch=shallow\n'),
    pktLine('ls-refs=unborn\n'),
    PKT_FLUSH,
  ]);
}

/** The info/refs advertisement for a service, in v0 or v2 as requested. */
export function advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', version2: boolean): Buffer {
  if (service === 'git-receive-pack') return v0Advertisement(repo, service);
  return version2 ? v2Advertisement() : v0Advertisement(repo, service);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2).

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  let prefix: string | null = null;
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefix = line.slice('ref-prefix '.length);
  }
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const matches = (name: string): boolean => prefix === null || name.startsWith(prefix);
  if (refs.length === 0) {
    if (unborn && matches('HEAD')) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  } else {
    if (symrefs && matches('HEAD')) {
      const main = repo.refs.get('refs/heads/main');
      if (main) parts.push(pktLine(`${main} HEAD symref-target:refs/heads/main\n`));
    }
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.name.startsWith('refs/tags/')) {
        const peeled = peeledCommit(repo, ref.oid);
        if (peeled && peeled !== ref.oid) line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (protocol v2 and v0).

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 32768) {
    const chunk = pack.subarray(offset, Math.min(offset + 32768, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function fetchResponse(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowLines: string[],
  depth: number | null,
  version2: boolean,
): Buffer {
  const selection = selectFetch(repo, wants, haves, shallowLines, depth);
  const parts: Buffer[] = [];
  if (version2) {
    if (haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM);
    }
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    if (selection.objects.size > 0) {
      parts.push(pktLine('packfile\n'));
      parts.push(...sidebandPackets(writePack(selection.objects)));
    }
  } else {
    parts.push(pktLine('NAK\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    if (selection.objects.size > 0) parts.push(...sidebandPackets(writePack(selection.objects)));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function parseFetchLines(lines: string[]): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of lines) {
    const line = raw.split('\0')[0];
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  return { wants, haves, shallow, depth };
}

/** POST git-upload-pack: ls-refs or fetch, in v2 or v0 as requested. */
export function handleUploadPack(repo: Repo, body: Buffer, version2: boolean): Buffer {
  const lines = pktStrings(body);
  const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length);
  if (version2 && command === 'ls-refs') return handleLsRefs(repo, lines);
  if (version2 && command !== 'fetch') throw new Error(`unknown upload-pack command '${command ?? ''}'`);
  const { wants, haves, shallow, depth } = parseFetchLines(lines);
  return fetchResponse(repo, wants, haves, shallow, depth, version2);
}

// ---------------------------------------------------------------------------
// receive-pack (protocol v0).

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: store the pack, apply the ref updates, report. */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = splitPackBody(body);
  const updates: RefUpdate[] = [];
  for (const raw of commands) {
    const line = raw.split('\0')[0].trim();
    if (line.length === 0) continue;
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`receive-pack command '${line}' is not valid`);
    updates.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (updates.length === 0) throw new Error('receive-pack carries no ref updates');
  const entries = pack.length === 0 ? [] : parsePack(pack);
  for (const entry of entries) {
    if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
  }
  const getObject = (oid: string) => repo.objects.get(oid);
  const report: string[] = ['unpack ok'];
  for (const update of updates) {
    const current = repo.refs.get(update.ref);
    if (update.newOid === ZERO_OID) {
      if (!current) report.push(`ng ${update.ref} remote ref does not exist`);
      else {
        repo.refs.delete(update.ref);
        report.push(`ok ${update.ref}`);
      }
    } else if (update.oldOid === ZERO_OID) {
      if (current) {
        report.push(`ng ${update.ref} already exists`);
      } else {
        const obj = getObject(update.newOid);
        const commitOid = obj?.type === 'commit'
          ? update.newOid
          : obj?.type === 'tag'
            ? peelToCommit(getObject, update.newOid)
            : undefined;
        if (!commitOid) report.push(`ng ${update.ref} invalid new object`);
        else {
          repo.refs.set(update.ref, update.newOid);
          report.push(`ok ${update.ref}`);
        }
      }
    } else {
      if (!current) {
        report.push(`ng ${update.ref} remote ref does not exist`);
      } else if (current !== update.oldOid) {
        report.push(`ng ${update.ref} non-fast-forward`);
      } else {
        const peeled = peelToCommit(getObject, update.newOid) ?? update.newOid;
        if (!isAncestor(getObject, peeled, update.oldOid)) {
          report.push(`ng ${update.ref} non-fast-forward`);
        } else {
          repo.refs.set(update.ref, update.newOid);
          report.push(`ok ${update.ref}`);
        }
      }
    }
  }
  const frames: Buffer[] = [];
  for (const line of report) {
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(`${line}\n`)])));
  }
  frames.push(pktLine(Buffer.concat([Buffer.from([1]), PKT_FLUSH])));
  frames.push(PKT_FLUSH);
  return Buffer.concat(frames);
}
