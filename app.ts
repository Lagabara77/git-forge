// app.ts — the HTTP server: routing, bearer auth, REST v3, GraphQL, MCP and
// git smart HTTP. Every REST reply is application/json and carries a
// non-empty X-GitHub-Request-Id; unknown routes are 404 JSON, never HTML.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import type { Repo } from './store.ts';
import {
  branchJson,
  commitJson,
  commentJson,
  issueJson,
  issueJsonCached,
  labelJson,
  pullJson,
  repoJson,
  userJson,
  flattenTree,
  buildTreeFromPaths,
  parseCommit,
  parseTree,
  walkCommits,
} from './store.ts';
import { advertisement, handleReceivePack, handleUploadPack } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY = 64 * 1024 * 1024;

export function createApp(store: Store) {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  function authorized(request: IncomingMessage): boolean {
    if (!expectedToken) return true;
    const header = request.headers.authorization ?? '';
    return header === `Bearer ${expectedToken}`;
  }

  function sendJson(response: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    response.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': store.nextRequestId(),
      ...extraHeaders,
    });
    response.end(body);
  }

  function sendRaw(response: ServerResponse, status: number, contentType: string, body: Buffer | string): void {
    response.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': store.nextRequestId(),
    });
    response.end(body);
  }

  function notFound(response: ServerResponse): void {
    sendJson(response, 404, { message: 'Not Found' });
  }

  function unauthorized(response: ServerResponse): void {
    sendJson(response, 401, { message: 'Bad credentials' });
  }

  function badRequest(response: ServerResponse, message: string): void {
    sendJson(response, 400, { message });
  }

  async function readBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > MAX_BODY) throw new Error('request body is too large');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  function readJson(body: Buffer): { ok: true; value: Record<string, unknown> | unknown[] } | { ok: false } {
    if (body.length === 0) return { ok: true, value: {} };
    try {
      return { ok: true, value: JSON.parse(body.toString('utf8')) as Record<string, unknown> | unknown[] };
    } catch {
      return { ok: false };
    }
  }

  function pagination(request: IncomingMessage, url: URL): { page: number; perPage: number } {
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
    const perPage = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
    return { page, perPage };
  }

  function pageLink(request: IncomingMessage, url: URL, page: number, perPage: number, hasNext: boolean): Record<string, string> {
    if (!hasNext) return {};
    const host = request.headers.host ?? '127.0.0.1';
    const next = new URL(url.pathname, `http://${host}`);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    return { link: `<${next.toString()}>; rel="next"` };
  }

  function paginate<T>(items: T[], page: number, perPage: number): { page: T[]; hasNext: boolean } {
    const start = (page - 1) * perPage;
    return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
  }

  const server = createServer(async (request, response) => {
    try {
      await handle(request, response);
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
      else response.end();
    }
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const segments = path.split('/').filter((part) => part.length > 0).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });

    if (method === 'GET' && path === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (!authorized(request)) {
      unauthorized(response);
      return;
    }

    // ---- git smart HTTP: /{owner}/{repo}.git/... -------------------------
    if (segments.length >= 2 && segments[1].endsWith('.git')) {
      const owner = segments[0];
      const repoName = segments[1].slice(0, -'.git'.length);
      const repo = store.visibleRepo(owner, repoName);
      if (!repo) {
        notFound(response);
        return;
      }
      const rest = segments.slice(2);
      const version2 = (request.headers['git-protocol'] ?? '') === 'version=2';
      if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          badRequest(response, 'service is required');
          return;
        }
        const body = advertisement(repo, service, version2);
        sendRaw(response, 200, service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement', body);
        return;
      }
      if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
        const body = await readBody(request);
        try {
          const out = handleUploadPack(repo, body, version2);
          sendRaw(response, 200, 'application/x-git-upload-pack-result', out);
        } catch (error) {
          badRequest(response, error instanceof Error ? error.message : 'upload-pack failed');
        }
        return;
      }
      if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
        const body = await readBody(request);
        try {
          const out = handleReceivePack(repo, body);
          sendRaw(response, 200, 'application/x-git-receive-pack-result', out);
        } catch (error) {
          badRequest(response, error instanceof Error ? error.message : 'receive-pack failed');
        }
        return;
      }
      notFound(response);
      return;
    }

    // ---- GraphQL ----------------------------------------------------------
    if (method === 'POST' && path === '/api/graphql') {
      const body = await readBody(request);
      const parsed = readJson(body);
      if (!parsed.ok) {
        badRequest(response, 'Problems parsing JSON');
        return;
      }
      if (Array.isArray(parsed.value)) {
        const results = parsed.value.map((entry) => {
          const item = (entry ?? {}) as Record<string, unknown>;
          return executeGraphQL(store, String(item.query ?? ''), (item.variables ?? {}) as Record<string, unknown>, (item.operationName as string | null) ?? null);
        });
        sendJson(response, 200, results);
        return;
      }
      const item = parsed.value as Record<string, unknown>;
      sendJson(response, 200, executeGraphQL(store, String(item.query ?? ''), (item.variables ?? {}) as Record<string, unknown>, (item.operationName as string | null) ?? null));
      return;
    }

    // ---- MCP --------------------------------------------------------------
    if (method === 'POST' && path === '/mcp') {
      const body = await readBody(request);
      const out = handleMcp(store, body);
      response.writeHead(out.status, {
        'content-type': 'application/json',
        'x-github-request-id': store.nextRequestId(),
        ...(out.headers ?? {}),
      });
      response.end(out.body);
      return;
    }

    // ---- REST v3 ----------------------------------------------------------
    if (segments[0] === 'api' && segments[1] === 'v3') {
      await handleRest(request, response, method, url, segments.slice(2));
      return;
    }

    notFound(response);
  }

  async function handleRest(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL,
    segments: string[],
  ): Promise<void> {
    const read = async (): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> => {
      const body = await readBody(request);
      const parsed = readJson(body);
      if (!parsed.ok || Array.isArray(parsed.value)) return { ok: false };
      return { ok: true, value: parsed.value as Record<string, unknown> };
    };

    // GET /api/v3/
    if (segments.length === 0 && method === 'GET') {
      sendJson(response, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_repositories_url: '/api/v3/user/repos',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // GET /api/v3/meta
    if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
      sendJson(response, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', version: '1.0.0' });
      return;
    }

    // GET /api/v3/user
    if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
      sendJson(response, 200, userJson(store.viewer));
      return;
    }

    // /api/v3/user/repos
    if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      if (method === 'GET') {
        const { page, perPage } = pagination(request, url);
        const owned = [...store.repos.values()].filter((repo) => repo.owner === store.viewer.login);
        const { page: items, hasNext } = paginate(owned, page, perPage);
        sendJson(response, 200, items.map((repo) => repoJson(store, repo)), pageLink(request, url, page, perPage, hasNext));
        return;
      }
      if (method === 'POST') {
        const parsed = await read();
        if (!parsed.ok) {
          badRequest(response, 'Problems parsing JSON');
          return;
        }
        const name = String(parsed.value.name ?? '');
        if (!name) {
          sendJson(response, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing' }] });
          return;
        }
        const repo = store.createRepo(name, parsed.value.private === true, String(parsed.value.description ?? ''));
        if (!repo) {
          sendJson(response, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] });
          return;
        }
        sendJson(response, 201, repoJson(store, repo));
        return;
      }
    }

    // /api/v3/repos/{owner}/{repo}/...
    if (segments.length >= 3 && segments[0] === 'repos') {
      const owner = segments[1];
      const repoName = segments[2];
      const repo = store.visibleRepo(owner, repoName);
      const rest = segments.slice(3);
      if (!repo) {
        notFound(response);
        return;
      }
      await handleRepo(request, response, method, url, repo, rest, read);
      return;
    }

    notFound(response);
  }

  async function handleRepo(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL,
    repo: Repo,
    rest: string[],
    read: () => Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }>,
  ): Promise<void> {
    // /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(response, 200, repoJson(store, repo));
        return;
      }
      if (method === 'PATCH') {
        const parsed = await read();
        if (!parsed.ok) {
          badRequest(response, 'Problems parsing JSON');
          return;
        }
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
        repo.updatedSec = store.clock.stamp();
        sendJson(response, 200, repoJson(store, repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        response.writeHead(204, { 'x-github-request-id': store.nextRequestId() });
        response.end();
        return;
      }
      notFound(response);
      return;
    }

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => branchJson(repo, ref.slice('refs/heads/'.length), repo.refs.get(ref) as string));
        sendJson(response, 200, branches);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) {
          notFound(response);
          return;
        }
        sendJson(response, 200, branchJson(repo, rest[1], sha));
        return;
      }
      notFound(response);
      return;
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${ref}`);
      if (!tip && repo.objects.get(ref)?.type === 'commit') tip = ref;
      if (!tip) {
        sendJson(response, 200, []);
        return;
      }
      const commits = walkCommits((oid) => repo.objects.get(oid), [tip])
        .map((sha) => commitJson(store, repo, sha))
        .filter((entry): entry is Record<string, unknown> => entry !== undefined);
      sendJson(response, 200, commits);
      return;
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const parsed = await read();
        if (!parsed.ok) {
          badRequest(response, 'Problems parsing JSON');
          return;
        }
        const ref = String(parsed.value.ref ?? '');
        const sha = String(parsed.value.sha ?? '');
        if (!ref || !sha || repo.objects.get(sha)?.type !== 'commit') {
          sendJson(response, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', code: 'invalid' }] });
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(response, 422, { message: 'Reference already exists' });
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(response, 201, { ref, object: { sha, type: 'commit' } });
        return;
      }
      if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[3]}`);
        if (!sha) {
          notFound(response);
          return;
        }
        sendJson(response, 200, { ref: `refs/heads/${rest[3]}`, object: { sha, type: 'commit' } });
        return;
      }
      notFound(response);
      return;
    }

    // contents
    if (rest[0] === 'contents') {
      await handleContents(request, response, method, url, repo, rest.slice(1).join('/'), read);
      return;
    }

    // labels
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        sendJson(response, 200, [...repo.labels.values()].map((label) => labelJson(label)));
        return;
      }
      if (rest.length === 1 && method === 'POST') {
        const parsed = await read();
        if (!parsed.ok) {
          badRequest(response, 'Problems parsing JSON');
          return;
        }
        const name = String(parsed.value.name ?? '');
        if (!name) {
          sendJson(response, 422, { message: 'Validation Failed' });
          return;
        }
        if (repo.labels.has(name)) {
          sendJson(response, 422, { message: 'Label already exists' });
          return;
        }
        const label = { name, color: String(parsed.value.color ?? 'ededed') };
        repo.labels.set(name, label);
        sendJson(response, 201, labelJson(label));
        return;
      }
      notFound(response);
      return;
    }

    // issues
    if (rest[0] === 'issues') {
      await handleIssues(request, response, method, url, repo, rest.slice(1), read);
      return;
    }

    // pulls
    if (rest[0] === 'pulls') {
      await handlePulls(request, response, method, url, repo, rest.slice(1), read);
      return;
    }

    notFound(response);
  }

  async function handleContents(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL,
    repo: Repo,
    path: string,
    read: () => Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }>,
  ): Promise<void> {
    const branch = url.searchParams.get('ref') ?? repo.defaultBranch;
    const tipOid = repo.refs.get(`refs/heads/${branch}`) ?? (repo.objects.get(branch)?.type === 'commit' ? branch : undefined);
    const resolveTree = (): Map<string, { oid: string; mode: string }> => {
      if (!tipOid) return new Map();
      const commit = repo.objects.get(tipOid);
      if (!commit || commit.type !== 'commit') return new Map();
      return flattenTree((oid) => repo.objects.get(oid), parseCommit(commit.data).tree);
    };
    if (method === 'GET') {
      const files = resolveTree();
      const entry = files.get(path);
      if (entry) {
        const blob = repo.objects.get(entry.oid);
        sendJson(response, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob?.data.length ?? 0,
          name: path.split('/').pop(),
          path,
          content: blob?.data.toString('base64') ?? '',
          sha: entry.oid,
        });
        return;
      }
      const prefix = path ? `${path}/` : '';
      const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
      for (const [filePath, fileEntry] of files) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const first = rest.split('/')[0];
        if (rest.includes('/')) {
          children.set(first, { type: 'dir', name: first, path: `${prefix}${first}`, sha: '' });
        } else {
          children.set(first, { type: 'file', name: first, path: filePath, sha: fileEntry.oid });
        }
      }
      if (children.size === 0) {
        notFound(response);
        return;
      }
      // Directory shas are the subtree oids; resolve them for a faithful listing.
      const out = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
      if (tipOid) {
        const commit = repo.objects.get(tipOid);
        if (commit && commit.type === 'commit') {
          const walk = (treeOid: string, base: string): void => {
            const obj = repo.objects.get(treeOid);
            if (!obj || obj.type !== 'tree') return;
            for (const treeEntry of parseTree(obj.data)) {
              const childPath = base ? `${base}/${treeEntry.name}` : treeEntry.name;
              if (treeEntry.mode === '40000') {
                const match = out.find((entry) => entry.path === childPath && entry.type === 'dir');
                if (match) match.sha = treeEntry.oid;
                walk(treeEntry.oid, childPath);
              }
            }
          };
          walk(parseCommit(commit.data).tree, '');
        }
      }
      sendJson(response, 200, out);
      return;
    }
    if (method === 'PUT') {
      const parsed = await read();
      if (!parsed.ok) {
        badRequest(response, 'Problems parsing JSON');
        return;
      }
      const targetBranch = String(parsed.value.branch ?? repo.defaultBranch);
      let branchTip = repo.refs.get(`refs/heads/${targetBranch}`);
      if (!branchTip) {
        // A branch that does not exist starts at the default branch tip; a
        // repository with no commits at all starts with a root commit.
        branchTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (branchTip) repo.refs.set(`refs/heads/${targetBranch}`, branchTip);
      }
      const content = Buffer.from(String(parsed.value.content ?? ''), 'base64');
      const files = branchTip ? resolveTreeForTip(repo, branchTip) : new Map<string, { oid: string; mode: string }>();
      const existing = files.get(path);
      if (existing && typeof parsed.value.sha === 'string' && parsed.value.sha !== existing.oid) {
        sendJson(response, 409, { message: 'sha does not match the current file' });
        return;
      }
      const isUpdate = existing !== undefined;
      const blobOid = store.storeObject(repo, 'blob', content);
      files.set(path, { oid: blobOid, mode: '100644' });
      const treeOid = buildTreeFromPaths((type, data) => store.storeObject(repo, type, data), files);
      const message = String(parsed.value.message ?? `Update ${path}`);
      const commitOid = store.makeCommit(repo, treeOid, branchTip ? [branchTip] : [], message);
      repo.refs.set(`refs/heads/${targetBranch}`, commitOid);
      sendJson(response, isUpdate ? 200 : 201, {
        content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64' },
        commit: { sha: commitOid },
      });
      return;
    }
    if (method === 'DELETE') {
      const parsed = await read();
      if (!parsed.ok) {
        badRequest(response, 'Problems parsing JSON');
        return;
      }
      const targetBranch = String(parsed.value.branch ?? repo.defaultBranch);
      const branchTip = repo.refs.get(`refs/heads/${targetBranch}`);
      if (!branchTip) {
        notFound(response);
        return;
      }
      const files = resolveTreeForTip(repo, branchTip);
      if (!files.has(path)) {
        notFound(response);
        return;
      }
      files.delete(path);
      const treeOid = buildTreeFromPaths((type, data) => store.storeObject(repo, type, data), files);
      const message = String(parsed.value.message ?? `Delete ${path}`);
      const commitOid = store.makeCommit(repo, treeOid, [branchTip], message);
      repo.refs.set(`refs/heads/${targetBranch}`, commitOid);
      sendJson(response, 200, { commit: { sha: commitOid } });
      return;
    }
    notFound(response);
  }

  function resolveTreeForTip(repo: Repo, tipOid: string): Map<string, { oid: string; mode: string }> {
    const commit = repo.objects.get(tipOid);
    if (!commit || commit.type !== 'commit') return new Map();
    return flattenTree((oid) => repo.objects.get(oid), parseCommit(commit.data).tree);
  }

  async function handleIssues(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL,
    repo: Repo,
    rest: string[],
    read: () => Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }>,
  ): Promise<void> {
    if (rest.length === 0) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let list = repo.issues.slice();
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.createdSec - b.createdSec || a.number - b.number : b.createdSec - a.createdSec || b.number - a.number));
        }
        const { page, perPage } = pagination(request, url);
        const { page: items, hasNext } = paginate(list, page, perPage);
        sendJson(response, 200, items.map((issue) => issueJson(store, repo, issue)), pageLink(request, url, page, perPage, hasNext));
        return;
      }
      if (method === 'POST') {
        const parsed = await read();
        if (!parsed.ok) {
          badRequest(response, 'Problems parsing JSON');
          return;
        }
        const labels = (parsed.value.labels ?? []) as unknown[];
        const labelNames = labels.map((label) => (typeof label === 'string' ? label : (label as Record<string, unknown>).name as string));
        const created = store.createIssue(repo, String(parsed.value.title ?? ''), String(parsed.value.body ?? ''), labelNames);
        if ('error' in created) {
          sendJson(response, 422, { message: created.error });
          return;
        }
        sendJson(response, 201, issueJson(store, repo, created));
        return;
      }
      notFound(response);
      return;
    }
    const number = Number(rest[0]);
    const issue = repo.issues.find((entry) => entry.number === number);
    if (!issue) {
      notFound(response);
      return;
    }
    if (rest.length === 1) {
      if (method === 'GET') {
        // Hot path: serve the cached serialization for sequential reads.
        const body = issueJsonCached(store, repo, issue);
        response.writeHead(200, { 'content-type': 'application/json', 'x-github-request-id': store.nextRequestId() });
        response.end(body);
        return;
      }
      if (method === 'PATCH') {
        const parsed = await read();
        if (!parsed.ok) {
          badRequest(response, 'Problems parsing JSON');
          return;
        }
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') {
          issue.state = parsed.value.state;
          issue.closedSec = issue.state === 'closed' ? store.clock.stamp() : null;
        }
        issue.updatedSec = store.clock.stamp();
        repo.issueJsonCache.delete(issue.number);
        sendJson(response, 200, issueJson(store, repo, issue));
        return;
      }
      notFound(response);
      return;
    }
    if (rest.length === 2 && rest[1] === 'comments') {
      if (method === 'GET') {
        sendJson(response, 200, issue.comments.map((comment) => commentJson(store, repo, issue, comment)));
        return;
      }
      if (method === 'POST') {
        const parsed = await read();
        if (!parsed.ok) {
          badRequest(response, 'Problems parsing JSON');
          return;
        }
        const comment = store.addComment(repo, issue, String(parsed.value.body ?? ''));
        sendJson(response, 201, commentJson(store, repo, issue, comment));
        return;
      }
    }
    notFound(response);
  }

  async function handlePulls(
    request: IncomingMessage,
    response: ServerResponse,
    method: string,
    url: URL,
    repo: Repo,
    rest: string[],
    read: () => Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }>,
  ): Promise<void> {
    if (rest.length === 0) {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let list = repo.pulls.slice();
        if (state !== 'all') list = list.filter((pull) => (state === 'closed' ? pull.state === 'closed' : pull.state === 'open'));
        const { page, perPage } = pagination(request, url);
        const { page: items, hasNext } = paginate(list, page, perPage);
        sendJson(response, 200, items.map((pull) => pullJson(store, repo, pull)), pageLink(request, url, page, perPage, hasNext));
        return;
      }
      if (method === 'POST') {
        const parsed = await read();
        if (!parsed.ok) {
          badRequest(response, 'Problems parsing JSON');
          return;
        }
        const created = store.createPull(repo, String(parsed.value.title ?? ''), String(parsed.value.body ?? ''), String(parsed.value.head ?? ''), String(parsed.value.base ?? ''));
        if ('error' in created) {
          sendJson(response, 422, { message: created.error });
          return;
        }
        sendJson(response, 201, pullJson(store, repo, created));
        return;
      }
      notFound(response);
      return;
    }
    const number = Number(rest[0]);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) {
      notFound(response);
      return;
    }
    if (rest.length === 1 && method === 'GET') {
      sendJson(response, 200, pullJson(store, repo, pull));
      return;
    }
    if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
      sendJson(response, 200, store.pullFiles(repo, pull).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })));
      return;
    }
    if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) {
        sendJson(response, merged.status, { message: merged.error });
        return;
      }
      sendJson(response, 200, { merged: true, sha: merged.sha, message: 'Pull request successfully merged.' });
      return;
    }
    notFound(response);
  }

  return server;
}
