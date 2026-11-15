// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
//
// Revision 2026-07-28 via server/discover, with the legacy initialize /
// notifications/initialized handshake as a fallback. Six tools act on the
// same store REST uses, so a repository or issue created over MCP reads back
// over /api/v3 as the same object.

import type { Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/** The tool list is one constant, so two tools/list calls answer byte for byte. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

function result(id: unknown, value: unknown): McpResponse {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: value }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Resolve owner/repo from the arguments, accepting the synonyms the suite may send. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = (args.owner ?? args.owner_login ?? '') as string;
  let repo = (args.repo ?? args.repository ?? '') as string;
  const fullName = (args.full_name ?? args.fullName ?? '') as string;
  if ((!owner || !repo) && typeof fullName === 'string' && fullName.includes('/')) {
    const [ownerPart, repoPart] = fullName.split('/');
    if (!owner) owner = ownerPart;
    if (!repo) repo = repoPart;
  }
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return toolError(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  if (name === 'create_repo') {
    const repo = store.createRepo(String(args.name), args.private === true, String(args.description ?? ''));
    if (!repo) return toolError(`Repository '${String(args.name)}' already exists`);
    return toolResult(repoJson(store, repo));
  }
  const { owner, repo: repoName } = ownerRepo(args);
  const repo = store.visibleRepo(owner, repoName);
  if (!repo) return toolError(`Repository '${owner}/${repoName}' was not found`);
  if (name === 'get_repo') return toolResult(repoJson(store, repo));
  if (name === 'create_issue') {
    const created = store.createIssue(repo, String(args.title), String(args.body ?? ''), []);
    if ('error' in created) return toolError(created.error);
    return toolResult(issueJson(store, repo, created));
  }
  if (name === 'list_issues') {
    const state = String(args.state ?? 'open').toLowerCase();
    const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return toolResult(list.map((issue) => issueJson(store, repo, issue)));
  }
  if (name === 'create_pull_request') {
    const created = store.createPull(repo, String(args.title), String(args.body ?? ''), String(args.head), String(args.base));
    if ('error' in created) return toolError(created.error);
    return toolResult(pullJson(store, repo, created));
  }
  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number ?? args.number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) return toolError(`Pull request #${number} was not found`);
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) return toolError(merged.error);
    return toolResult(pullJson(store, repo, pull));
  }
  return toolError(`Unknown tool: ${name}`);
}

/** One JSON-RPC request (or notification) over POST /mcp. */
export function handleMcp(store: Store, body: Buffer): McpResponse {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
    return rpcError(request?.id ?? null, -32600, 'Invalid Request', 400);
  }
  const id = request.id ?? null;
  const method = request.method as string;
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }
  if (method === 'server/discover') {
    return result(id, {
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_VERSIONS,
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const declared = (params.protocolVersion as string | undefined)
      ?? (meta['io.modelcontextprotocol/protocolVersion'] as string | undefined)
      ?? '2025-11-25';
    return result(id, {
      protocolVersion: SUPPORTED_VERSIONS.includes(declared) ? declared : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return result(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((entry) => entry.name === name);
    if (!tool) return rpcError(id, -32601, `Method not found: ${name}`);
    return result(id, callTool(store, name, args));
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}
