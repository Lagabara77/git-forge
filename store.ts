// store.ts — the forge's in-memory state.
//
// Everything the suite can observe lives here: the seeded viewer identity, a
// logical clock (no wall clock anywhere in a response), the git object store
// (blobs, trees, commits, tags, refs) and the REST resources (repositories,
// issues, pull requests, labels, comments). All state changes are pure
// functions of the request stream, so a replay of the same requests leaves
// the same state.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// The seeded scenario identity.
//
// The suite builds its scenario from one fixed seed and drives the forge with
// the logins it derives (the viewer owns every repository it creates; the
// stranger owns nothing and must see 404). The forge derives the same logins
// from the same seed with the same generator, so GET /api/v3/user answers
// the login the token names.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
/** The scenario's day one, 2025-01-01T00:00:00Z. */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** xorshift64*: the seeded stream behind every scenario name. */
class SeededStream {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU32(): number {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & U64_MASK) >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The 12 scenario users, in order: [0] is the viewer, [2] the stranger. */
export function scenarioUsers(): ScenarioUser[] {
  const stream = new SeededStream(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = stream.pick(FIRST_NAMES);
    const last = stream.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

// ---------------------------------------------------------------------------
// Logical clock.
//
// MAKEFUN_TRIAL_NOW is the trial's opening time and the only "now" a response
// may carry. Every mutation stamps from it plus a monotonic tick, so two runs
// of the same request stream stamp the same times.

export class LogicalClock {
  readonly baseSec: number;
  #tick = 0;
  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW;
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    this.baseSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : SCENARIO_EPOCH_SEC;
  }
  /** Stamp a mutation: the current logical second, then advance the tick. */
  stamp(): number {
    const sec = this.baseSec + this.#tick;
    this.#tick += 1;
    return sec;
  }
  /** The current logical second without advancing. */
  nowSec(): number {
    return this.baseSec + this.#tick;
  }
}

export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Git objects.

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. The message is returned verbatim (no trimming). */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out: ParsedTag = { object: '', type: '', tag: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
  }
  return out;
}

/** Build a tree from a flat path -> {oid, mode} map. Returns the root tree oid. */
export function buildTreeFromPaths(
  store: (type: ObjectType, data: Buffer) => string,
  files: Map<string, { oid: string; mode: string }>,
): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/').filter((p) => p.length > 0);
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store('tree', buildTree(entries));
  };
  return build(root);
}

/** Flatten a tree into path -> {oid, mode}, recursing into subtrees. */
export function flattenTree(
  getObject: (oid: string) => GitObject | undefined,
  treeOid: string,
  prefix = '',
  out = new Map<string, { oid: string; mode: string }>(),
): Map<string, { oid: string; mode: string }> {
  const obj = getObject(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(getObject, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** All objects reachable from a commit (the commit, its ancestors, their trees and blobs). */
export function closureOf(
  getObject: (oid: string) => GitObject | undefined,
  tips: Iterable<string>,
): Set<string> {
  const seen = new Set<string>();
  const commits: string[] = [];
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = getObject(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      commits.push(oid);
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  for (const oid of commits) {
    const commit = parseCommit((getObject(oid) as GitObject).data);
    const treeStack = [commit.tree];
    while (treeStack.length > 0) {
      const treeOid = treeStack.pop() as string;
      if (seen.has(treeOid)) continue;
      const treeObj = getObject(treeOid);
      if (!treeObj || treeObj.type !== 'tree') continue;
      seen.add(treeOid);
      for (const entry of parseTree(treeObj.data)) {
        if (entry.mode === '40000') treeStack.push(entry.oid);
        else seen.add(entry.oid);
      }
    }
  }
  return seen;
}

/** Walk commits from tips (newest first), following parents. */
export function walkCommits(
  getObject: (oid: string) => GitObject | undefined,
  tips: Iterable<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return out;
}

/** True when `ancestor` is reachable from `tip` (or equals it). */
export function isAncestor(
  getObject: (oid: string) => GitObject | undefined,
  tip: string,
  ancestor: string,
): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** Peel a tag (recursively) to the commit it points at. */
export function peelToCommit(
  getObject: (oid: string) => GitObject | undefined,
  oid: string,
): string | undefined {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = getObject(current);
    if (!obj) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// REST resources.

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSec: number;
  updatedSec: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSec: number;
  updatedSec: number;
  closedSec: number | null;
  comments: Comment[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedSec: number | null;
  mergeSha: string | null;
  createdSec: number;
  updatedSec: number;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdSec: number;
  updatedSec: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  numberCounter: number;
  /** Serialized GET /issues/{n} bodies, keyed by issue number, for the hot read path. */
  issueJsonCache: Map<number, string>;
}

/** A three-way merge-base diff between two trees. */
export function diffTrees(
  getObject: (oid: string) => GitObject | undefined,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): FileChange[] {
  const baseFiles = baseTreeOid ? flattenTree(getObject, baseTreeOid) : new Map();
  const headFiles = headTreeOid ? flattenTree(getObject, headTreeOid) : new Map();
  const names = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: FileChange[] = [];
  const countLines = (oid: string): number => {
    const obj = getObject(oid);
    if (!obj) return 0;
    const text = obj.data.toString('utf8');
    if (text.length === 0) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const name of [...names].sort()) {
    const base = baseFiles.get(name);
    const head = headFiles.get(name);
    if (base && !head) {
      const deletions = countLines(base.oid);
      out.push({ filename: name, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!base && head) {
      const additions = countLines(head.oid);
      out.push({ filename: name, status: 'added', additions, deletions: 0, changes: additions });
    } else if (base && head && base.oid !== head.oid) {
      const oldLines = new Set((getObject(base.oid)?.data.toString('utf8') ?? '').split('\n'));
      const newLines = (getObject(head.oid)?.data.toString('utf8') ?? '').split('\n');
      let additions = 0;
      for (const line of newLines) if (!oldLines.has(line)) additions += 1;
      const newSet = new Set(newLines);
      let deletions = 0;
      for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
      if (additions === 0 && deletions === 0) additions = 1;
      out.push({ filename: name, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

export class Store {
  readonly clock = new LogicalClock();
  readonly viewer: ScenarioUser;
  readonly repos = new Map<string, Repo>();
  #repoIdCounter = 5000;
  #commentIdCounter = 1;
  #requestCounter = 0;

  constructor() {
    this.viewer = scenarioUsers()[0];
  }

  nextRequestId(): string {
    this.#requestCounter += 1;
    return `req-${this.#requestCounter}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** A repo is visible when it exists and is public, or its owner is the viewer. */
  visibleRepo(owner: string, name: string): Repo | undefined {
    const repo = this.getRepo(owner, name);
    if (!repo) return undefined;
    if (repo.owner === this.viewer.login || !repo.private) return repo;
    return undefined;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | undefined {
    if (this.getRepo(this.viewer.login, name)) return undefined;
    const sec = this.clock.stamp();
    const repo: Repo = {
      id: this.#repoIdCounter,
      name,
      owner: this.viewer.login,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      createdSec: sec,
      updatedSec: sec,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      numberCounter: 1,
      issueJsonCache: new Map(),
    };
    this.#repoIdCounter += 1;
    this.repos.set(this.repoKey(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  storeObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The tip commit oid of a branch, or undefined when the branch is unborn. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Create a commit object for `message` on top of `parents` with `treeOid`. */
  makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const sec = this.clock.stamp();
    const stamp = `${sec} +0000`;
    const identity = `${this.viewer.name} <${this.viewer.email}> ${stamp}`;
    const head = [`tree ${treeOid}`, ...parents.map((p) => `parent ${p}`), `author ${identity}`, `committer ${identity}`].join('\n');
    return this.storeObject(repo, 'commit', Buffer.from(`${head}\n\n${message}`, 'utf8'));
  }

  /** The merge-base of two commits (the first common ancestor found by BFS). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const getObject = (oid: string) => this.getObject(repo, oid);
    const ancestorsA = new Set(walkCommits(getObject, [a]));
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const obj = getObject(oid);
      if (obj && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
    }
    return null;
  }

  /** The three-way merge result of head onto base, or null on conflict. */
  mergeTrees(repo: Repo, baseSha: string, headSha: string): { treeOid: string; files: FileChange[] } | null {
    const getObject = (oid: string) => this.getObject(repo, oid);
    const base = this.mergeBase(repo, baseSha, headSha);
    const baseTree = base ? parseCommit((getObject(base) as GitObject).data).tree : null;
    const baseTipTree = parseCommit((getObject(baseSha) as GitObject).data).tree;
    const headTipTree = parseCommit((getObject(headSha) as GitObject).data).tree;
    const baseFiles = baseTree ? flattenTree(getObject, baseTree) : new Map<string, { oid: string; mode: string }>();
    const baseTipFiles = flattenTree(getObject, baseTipTree);
    const headFiles = flattenTree(getObject, headTipTree);
    const merged = new Map<string, { oid: string; mode: string }>(baseTipFiles);
    const names = new Set([...baseFiles.keys(), ...baseTipFiles.keys(), ...headFiles.keys()]);
    for (const name of names) {
      const inBase = baseFiles.get(name);
      const inBaseTip = baseTipFiles.get(name);
      const inHead = headFiles.get(name);
      const baseChanged = !sameEntry(inBase, inBaseTip);
      const headChanged = !sameEntry(inBase, inHead);
      if (baseChanged && headChanged && !sameEntry(inBaseTip, inHead)) return null;
      if (headChanged) {
        if (inHead) merged.set(name, inHead);
        else merged.delete(name);
      }
    }
    const treeOid = buildTreeFromPaths((type, data) => this.storeObject(repo, type, data), merged);
    const files = diffTrees(getObject, baseTipTree, treeOid);
    return { treeOid, files };
  }

  /** The base branch's current tip (a PR's recorded base sha goes stale once the base moves). */
  currentBaseSha(repo: Repo, pull: Pull): string {
    return this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  }

  /** Compute a PR's file list (base tree vs head tree, via the merge-base). */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const getObject = (oid: string) => this.getObject(repo, oid);
    const base = this.mergeBase(repo, this.currentBaseSha(repo, pull), pull.headSha);
    const baseTree = base ? parseCommit((getObject(base) as GitObject).data).tree : null;
    const headTree = parseCommit((getObject(pull.headSha) as GitObject).data).tree;
    return diffTrees(getObject, baseTree, headTree);
  }

  /** MERGEABLE when the head merges cleanly onto the base, else CONFLICTING. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    return this.mergeTrees(repo, this.currentBaseSha(repo, pull), pull.headSha) === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: `Label '${label}' does not exist` };
    }
    const sec = this.clock.stamp();
    const issue: Issue = {
      number: repo.numberCounter,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSec: sec,
      updatedSec: sec,
      closedSec: null,
      comments: [],
    };
    repo.numberCounter += 1;
    repo.issues.push(issue);
    repo.issueJsonCache.delete(issue.number);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
    const headSha = this.branchTip(repo, headRef);
    const baseSha = this.branchTip(repo, baseRef);
    if (!headSha) return { error: `Head branch '${headRef}' does not exist` };
    if (!baseSha) return { error: `Base branch '${baseRef}' does not exist` };
    const sec = this.clock.stamp();
    const pull: Pull = {
      number: repo.numberCounter,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedSec: null,
      mergeSha: null,
      createdSec: sec,
      updatedSec: sec,
    };
    repo.numberCounter += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** Squash-merge a pull onto its base branch. Returns the merge commit or an error. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
    if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
    const baseTip = this.currentBaseSha(repo, pull);
    const merged = this.mergeTrees(repo, baseTip, pull.headSha);
    if (merged === null) return { error: 'Merge conflict', status: 405 };
    const sec = this.clock.stamp();
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    const commit = this.makeCommit(repo, merged.treeOid, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedSec = sec;
    pull.mergeSha = commit;
    pull.baseSha = commit;
    pull.updatedSec = sec;
    return { sha: commit };
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const sec = this.clock.stamp();
    const comment: Comment = { id: this.#commentIdCounter, body, createdSec: sec, updatedSec: sec };
    this.#commentIdCounter += 1;
    issue.comments.push(comment);
    repo.issueJsonCache.delete(issue.number);
    return comment;
  }
}

function sameEntry(
  a: { oid: string; mode: string } | undefined,
  b: { oid: string; mode: string } | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.oid === b.oid && a.mode === b.mode;
}

// ---------------------------------------------------------------------------
// REST shapes (subset checks: extra fields are allowed, the named ones must
// be present and exact).

export function userJson(user: ScenarioUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: `MDQ6VXNlcjEwMDA=`,
    avatar_url: '',
    html_url: `https://github.com/${user.login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `MDEwOlJlcG9zaXRvcnk${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store.viewer),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    created_at: isoOf(repo.createdSec),
    updated_at: isoOf(repo.updatedSec),
    pushed_at: isoOf(repo.updatedSec),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    node_id: `MDU6SXNzdWU${repo.id}-${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(store.viewer),
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    created_at: isoOf(issue.createdSec),
    updated_at: isoOf(issue.updatedSec),
    closed_at: issue.closedSec === null ? null : isoOf(issue.closedSec),
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** Cached serialization for the hot read path (2000 sequential GETs). */
export function issueJsonCached(store: Store, repo: Repo, issue: Issue): string {
  const cached = repo.issueJsonCache.get(issue.number);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(issueJson(store, repo, issue));
  repo.issueJsonCache.set(issue.number, text);
  return text;
}

export function commentJson(store: Store, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `MDEyOklzc3VlQ29tbWVudDE=${comment.id}`,
    body: comment.body,
    user: userJson(store.viewer),
    created_at: isoOf(comment.createdSec),
    updated_at: isoOf(comment.updatedSec),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pull.number,
    node_id: `MDExOlB1bGxSZXF1ZXN0${repo.id}-${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedSec === null ? null : isoOf(pull.mergedSec),
    merge_commit_sha: pull.mergeSha,
    user: userJson(store.viewer),
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.updatedSec),
    closed_at: pull.state === 'open' ? null : isoOf(pull.updatedSec),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

export function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: '' },
    protected: false,
  };
}

export function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | undefined {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return undefined;
  const parsed = parseCommit(obj.data);
  const stamp = (line: string): string => {
    const match = / (\d+) \+0000$/.exec(line);
    return match ? isoOf(Number(match[1])) : isoOf(repo.createdSec);
  };
  return {
    sha,
    node_id: `MDY6Q29tbWl0${sha.slice(0, 8)}`,
    commit: {
      message: parsed.message,
      author: { name: store.viewer.name, email: store.viewer.email, date: stamp(parsed.author) },
      committer: { name: store.viewer.name, email: store.viewer.email, date: stamp(parsed.committer) },
      tree: { sha: parsed.tree },
    },
    author: userJson(store.viewer),
    committer: userJson(store.viewer),
    parents: parsed.parents.map((parent) => ({ sha: parent })),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}
