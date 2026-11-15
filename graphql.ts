// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send: viewer/repository/node lookups, issue and pull
// request reads and mutations, and __type introspection. It parses the query
// text (no schema language needed), validates each field against the field
// sets below, and executes against the same store REST uses.

import type { Issue, Pull, Repo, Store } from './store.ts';
import { isoOf, parseCommit } from './store.ts';

// ---------------------------------------------------------------------------
// Lexer.

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const next = input[i + 1];
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else value += next;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      let isFloat = false;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if ((input[j] === 'e' || input[j] === 'E') && /[0-9+-]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      tokens.push(isFloat ? { kind: 'float', value: input.slice(i, j) } : { kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character '${ch}' in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST.

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[];
}

export type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] };

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  #tokens: Token[];
  #pos = 0;
  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }
  #peek(): Token {
    return this.#tokens[this.#pos];
  }
  #next(): Token {
    return this.#tokens[this.#pos++];
  }
  #expectPunct(value: string): void {
    const token = this.#next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}' in GraphQL document`);
  }
  #expectName(): string {
    const token = this.#next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }
  #isPunct(value: string): boolean {
    const token = this.#peek();
    return token.kind === 'punct' && token.value === value;
  }
  #skipDirectives(): void {
    while (this.#isPunct('@')) {
      this.#next();
      this.#expectName();
      if (this.#isPunct('(')) this.#parseArguments();
    }
  }
  #parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.#expectPunct('(');
    while (!this.#isPunct(')')) {
      const name = this.#expectName();
      this.#expectPunct(':');
      args.push({ name, value: this.#parseValue() });
    }
    this.#expectPunct(')');
    return args;
  }
  #parseValue(): ValueNode {
    const token = this.#next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.#expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.#isPunct(']')) values.push(this.#parseValue());
      this.#expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.#isPunct('}')) {
        const name = this.#expectName();
        this.#expectPunct(':');
        fields.push({ name, value: this.#parseValue() });
      }
      this.#expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
  #parseType(): void {
    if (this.#isPunct('[')) {
      this.#next();
      this.#parseType();
      this.#expectPunct(']');
    } else {
      this.#expectName();
    }
    if (this.#isPunct('!')) this.#next();
  }
  #parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    this.#expectPunct('{');
    while (!this.#isPunct('}')) {
      selections.push(this.#parseSelection());
    }
    this.#expectPunct('}');
    return selections;
  }
  #parseSelection(): SelectionNode {
    if (this.#isPunct('...')) {
      this.#next();
      const token = this.#peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.#next();
        const typeCondition = this.#expectName();
        this.#skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.#parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.#next().value;
        this.#skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.#skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: this.#parseSelectionSet() };
    }
    const first = this.#expectName();
    let alias: string | null = null;
    let name = first;
    if (this.#isPunct(':')) {
      this.#next();
      alias = first;
      name = this.#expectName();
    }
    const args = this.#isPunct('(') ? this.#parseArguments() : [];
    this.#skipDirectives();
    const selections = this.#isPunct('{') ? this.#parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }
  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.#peek().kind !== 'eof') {
      const token = this.#peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'operation', operation: 'query', name: null, selections: this.#parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.#next();
        const name = this.#expectName();
        const on = this.#expectName();
        if (on !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.#expectName();
        this.#skipDirectives();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selections: this.#parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = this.#next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.#peek().kind === 'name') name = this.#next().value;
        if (this.#isPunct('(')) {
          this.#next();
          while (!this.#isPunct(')')) {
            if (this.#isPunct('$')) {
              this.#next();
              this.#expectName();
              this.#expectPunct(':');
              this.#parseType();
              if (this.#isPunct('=')) {
                this.#next();
                this.#parseValue();
              }
            } else {
              this.#next();
            }
          }
          this.#expectPunct(')');
        }
        this.#skipDirectives();
        operations.push({ kind: 'operation', operation, name, selections: this.#parseSelectionSet() });
        continue;
      }
      throw new Error('unexpected definition in GraphQL document');
    }
    return { operations, fragments };
  }
}

export function parseDocument(query: string): DocumentNode {
  return new Parser(lex(query)).parseDocument();
}

/** Resolve a value node against the request's variables. */
export function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

export function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Schema: the fields each type answers. A field outside the set is an error
// naming it (the invalid-field check reads that message).

const FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  User: new Set(['login', 'id', 'name', 'email', 'url']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'createdAt', 'updatedAt', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests']),
  Ref: new Set(['name', 'prefix', 'target']),
  Commit: new Set(['oid', 'message']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'url', 'author', 'repository', 'comments', 'labels']),
  PullRequest: new Set(['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'repository', 'author', 'files']),
  IssueComment: new Set(['id', 'body', 'createdAt', 'updatedAt', 'author', 'url']),
  Label: new Set(['id', 'name', 'color', 'description']),
  FileChange: new Set(['path', 'additions', 'deletions', 'changes', 'status']),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  IssueCommentConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  LabelConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  FileChangeConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  IssueEdge: new Set(['node', 'cursor']),
  PullRequestEdge: new Set(['node', 'cursor']),
  IssueCommentEdge: new Set(['node', 'cursor']),
  LabelEdge: new Set(['node', 'cursor']),
  FileChangeEdge: new Set(['node', 'cursor']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  TypeInfo: new Set(['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields']),
  FieldInfo: new Set(['name', 'description', 'type']),
  EnumValueInfo: new Set(['name', 'description']),
  TypeRef: new Set(['name', 'kind']),
  SchemaInfo: new Set(['queryType', 'mutationType', 'types']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'subject', 'clientMutationId']),
};

const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI', 'PACKAGE'];

// ---------------------------------------------------------------------------
// Global ids: opaque, stable, and decodable here (base64 of a typed tag).

function gid(kind: string, parts: string[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function ungid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('Repository', [repo.owner, repo.name]);
}
function issueGid(repo: Repo, issue: Issue): string {
  return gid('Issue', [repo.owner, repo.name, String(issue.number)]);
}
function pullGid(repo: Repo, pull: Pull): string {
  return gid('PullRequest', [repo.owner, repo.name, String(pull.number)]);
}
function commentGid(repo: Repo, issue: Issue, commentId: number): string {
  return gid('IssueComment', [repo.owner, repo.name, String(issue.number), String(commentId)]);
}

// ---------------------------------------------------------------------------
// Execution.

interface GqlParent {
  __typename: string;
  [key: string]: unknown;
}

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, FragmentNode>;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const value = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function connection<T>(nodes: T[], first: number | null, after: string | null | undefined, cursorOf: (node: T) => string, connectionType: string): GqlParent & { __nodes: T[] } {
  const afterNumber = numberOfCursor(after);
  let page = nodes;
  if (afterNumber !== null) page = page.filter((node) => {
    const text = Buffer.from(cursorOf(node), 'base64').toString('utf8');
    return Number.parseInt(text.slice('cursor:'.length), 10) > afterNumber;
  });
  const hasNext = first !== null && page.length > first;
  if (first !== null) page = page.slice(0, first);
  return {
    __typename: connectionType,
    __nodes: page,
    __hasNext: hasNext,
    __cursorOf: cursorOf,
    __edgeType: connectionType.replace('Connection', 'Edge'),
  } as GqlParent & { __nodes: T[] };
}

function executeSelections(
  executor: Executor,
  parent: GqlParent,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = executor.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelections(executor, parent, fragment.selections));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === parent.__typename) {
        Object.assign(out, executeSelections(executor, parent, selection.selections));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = parent.__typename;
      continue;
    }
    const allowed = FIELDS[parent.__typename];
    if (!allowed || !allowed.has(selection.name)) {
      executor.errors.push({ message: `Cannot query field "${selection.name}" on type "${parent.__typename}".` });
      continue;
    }
    const value = resolveField(executor, parent, selection);
    if (value === undefined) continue;
    if (selection.selections.length === 0) {
      out[key] = value;
    } else if (value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      out[key] = executeSelections(executor, value as GqlParent, selection.selections);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)
          ? executeSelections(executor, item as GqlParent, selection.selections)
          : item,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

function issueParent(store: Store, repo: Repo, issue: Issue): GqlParent {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: issueGid(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: isoOf(issue.createdSec),
    updatedAt: isoOf(issue.updatedSec),
    closedAt: issue.closedSec === null ? null : isoOf(issue.closedSec),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullParent(store: Store, repo: Repo, pull: Pull): GqlParent {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: pullGid(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: store.pullMergeable(repo, pull),
    createdAt: isoOf(pull.createdSec),
    updatedAt: isoOf(pull.updatedSec),
    mergedAt: pull.mergedSec === null ? null : isoOf(pull.mergedSec),
  };
}

function repoParent(store: Store, repo: Repo): GqlParent {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: repoGid(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    private: repo.private,
    createdAt: isoOf(repo.createdSec),
    updatedAt: isoOf(repo.updatedSec),
    url: `https://github.com/${repo.owner}/${repo.name}`,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function resolveField(executor: Executor, parent: GqlParent, field: FieldNode): unknown {
  const store = executor.store;
  const args = argsOf(field, executor.variables);
  const type = parent.__typename;
  if (type === 'Query') {
    if (field.name === 'viewer') {
      return {
        __typename: 'User',
        login: store.viewer.login,
        id: String(store.viewer.id),
        name: store.viewer.name,
        email: store.viewer.email,
        url: `https://github.com/${store.viewer.login}`,
      };
    }
    if (field.name === 'repository') {
      const repo = store.visibleRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoParent(store, repo) : null;
    }
    if (field.name === 'node') {
      const decoded = ungid(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'Repository' && decoded.parts.length === 2) {
        const repo = store.visibleRepo(decoded.parts[0], decoded.parts[1]);
        return repo ? repoParent(store, repo) : null;
      }
      if (decoded.kind === 'Issue' && decoded.parts.length === 3) {
        const repo = store.visibleRepo(decoded.parts[0], decoded.parts[1]);
        const issue = repo?.issues.find((entry) => entry.number === Number(decoded.parts[2]));
        return repo && issue ? issueParent(store, repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest' && decoded.parts.length === 3) {
        const repo = store.visibleRepo(decoded.parts[0], decoded.parts[1]);
        const pull = repo?.pulls.find((entry) => entry.number === Number(decoded.parts[2]));
        return repo && pull ? pullParent(store, repo, pull) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      return typeInfo(String(args.name ?? ''));
    }
    if (field.name === '__schema') {
      return {
        __typename: 'SchemaInfo',
        queryType: { __typename: 'TypeRef', name: 'Query', kind: 'OBJECT' },
        mutationType: { __typename: 'TypeRef', name: 'Mutation', kind: 'OBJECT' },
        types: Object.keys(FIELDS).map((name) => typeInfo(name)),
      };
    }
    return undefined;
  }
  if (type === 'Repository') {
    const repo = parent.__repo as Repo;
    if (field.name === 'owner') {
      return {
        __typename: 'User',
        login: repo.owner,
        id: repo.owner === store.viewer.login ? String(store.viewer.id) : '0',
        name: repo.owner === store.viewer.login ? store.viewer.name : repo.owner,
        email: repo.owner === store.viewer.login ? store.viewer.email : '',
        url: `https://github.com/${repo.owner}`,
      };
    }
    if (field.name === 'defaultBranchRef') {
      return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null, message: '' } };
    }
    if (field.name === 'issue') {
      const issue = repo.issues.find((entry) => entry.number === Number(args.number));
      return issue ? issueParent(store, repo, issue) : null;
    }
    if (field.name === 'issues') {
      return issueConnection(store, repo, args);
    }
    if (field.name === 'pullRequest') {
      const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
      return pull ? pullParent(store, repo, pull) : null;
    }
    if (field.name === 'pullRequests') {
      return pullConnection(store, repo, args);
    }
    return parent[field.name];
  }
  if (type === 'Issue') {
    const repo = parent.__repo as Repo;
    const issue = parent.__issue as Issue;
    if (field.name === 'author') {
      return { __typename: 'User', login: store.viewer.login, id: String(store.viewer.id), name: store.viewer.name, email: store.viewer.email, url: `https://github.com/${store.viewer.login}` };
    }
    if (field.name === 'repository') return repoParent(store, repo);
    if (field.name === 'comments') {
      const nodes = issue.comments.map((comment, index) => ({
        __typename: 'IssueComment',
        __index: index,
        id: commentGid(repo, issue, comment.id),
        body: comment.body,
        createdAt: isoOf(comment.createdSec),
        updatedAt: isoOf(comment.updatedSec),
        url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
      }));
      return connection(nodes, typeof args.first === 'number' ? args.first : null, args.after as string | null, (node) => cursorFor(node.__index + 1), 'IssueCommentConnection');
    }
    if (field.name === 'labels') {
      const nodes = issue.labels.map((name, index) => ({
        __typename: 'Label',
        __index: index,
        id: gid('Label', [repo.owner, repo.name, name]),
        name,
        color: repo.labels.get(name)?.color ?? 'ededed',
        description: '',
      }));
      return connection(nodes, typeof args.first === 'number' ? args.first : null, args.after as string | null, (node) => cursorFor(node.__index + 1), 'LabelConnection');
    }
    return parent[field.name];
  }
  if (type === 'PullRequest') {
    const repo = parent.__repo as Repo;
    const pull = parent.__pull as Pull;
    if (field.name === 'author') {
      return { __typename: 'User', login: store.viewer.login, id: String(store.viewer.id), name: store.viewer.name, email: store.viewer.email, url: `https://github.com/${store.viewer.login}` };
    }
    if (field.name === 'repository') return repoParent(store, repo);
    if (field.name === 'mergeCommit') {
      if (!pull.mergeSha) return null;
      const parsed = parseCommit((repo.objects.get(pull.mergeSha) as { data: Buffer }).data);
      return { __typename: 'Commit', oid: pull.mergeSha, message: parsed.message };
    }
    if (field.name === 'files') {
      const changes = store.pullFiles(repo, pull);
      const nodes = changes.map((change, index) => ({
        __typename: 'FileChange',
        path: change.filename,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
        status: change.status.toUpperCase(),
        __index: index,
      }));
      return connection(nodes, typeof args.first === 'number' ? args.first : null, args.after as string | null, (node) => cursorFor(node.__index + 1), 'FileChangeConnection');
    }
    return parent[field.name];
  }
  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'IssueCommentConnection' || type === 'LabelConnection' || type === 'FileChangeConnection') {
    const conn = parent as GqlParent & { __nodes: GqlParent[]; __hasNext: boolean; __cursorOf: (node: GqlParent) => string; __edgeType: string };
    if (field.name === 'nodes') return conn.__nodes;
    if (field.name === 'edges') {
      return conn.__nodes.map((node) => ({ __typename: conn.__edgeType, node, cursor: conn.__cursorOf(node) }));
    }
    if (field.name === 'pageInfo') {
      const nodes = conn.__nodes;
      return {
        __typename: 'PageInfo',
        hasNextPage: conn.__hasNext,
        hasPreviousPage: false,
        startCursor: nodes.length > 0 ? conn.__cursorOf(nodes[0]) : null,
        endCursor: nodes.length > 0 ? conn.__cursorOf(nodes[nodes.length - 1]) : null,
      };
    }
    if (field.name === 'totalCount') return conn.__nodes.length;
    return undefined;
  }
  if (type === 'IssueEdge' || type === 'PullRequestEdge' || type === 'IssueCommentEdge' || type === 'LabelEdge' || type === 'FileChangeEdge') {
    return parent[field.name];
  }
  if (type === 'TypeInfo') {
    return parent[field.name];
  }
  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload' || type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload' || type === 'AddCommentPayload') {
    return parent[field.name];
  }
  return parent[field.name];
}

function typeInfo(name: string): GqlParent | null {
  if (name === 'SearchType') {
    return {
      __typename: 'TypeInfo',
      name: 'SearchType',
      kind: 'ENUM',
      description: 'The types of search results.',
      fields: null,
      enumValues: SEARCH_ENUM.map((value) => ({ __typename: 'EnumValueInfo', name: value, description: '' })),
      inputFields: null,
    };
  }
  const fields = FIELDS[name];
  if (!fields) return null;
  return {
    __typename: 'TypeInfo',
    name,
    kind: 'OBJECT',
    description: '',
    fields: [...fields].sort().map((field) => ({ __typename: 'FieldInfo', name: field, description: '', type: { __typename: 'TypeRef', name: 'String', kind: 'SCALAR' } })),
    enumValues: null,
    inputFields: null,
  };
}

function issueConnection(store: Store, repo: Repo, args: Record<string, unknown>): GqlParent {
  let list = repo.issues.slice();
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
    list.sort((a, b) => b.createdSec - a.createdSec || b.number - a.number);
  } else if (orderBy && orderBy.field === 'CREATED_AT' && orderBy.direction === 'ASC') {
    list.sort((a, b) => a.createdSec - b.createdSec || a.number - b.number);
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  const nodes = list.map((issue) => issueParent(store, repo, issue));
  return connection(nodes, typeof args.first === 'number' ? args.first : null, args.after as string | null, (node) => cursorFor((node as GqlParent).number as number), 'IssueConnection');
}

function pullConnection(store: Store, repo: Repo, args: Record<string, unknown>): GqlParent {
  let list = repo.pulls.slice();
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    list = list.filter((pull) => wanted.has(pull.merged ? 'merged' : pull.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
    list.sort((a, b) => b.createdSec - a.createdSec || b.number - a.number);
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  const nodes = list.map((pull) => pullParent(store, repo, pull));
  return connection(nodes, typeof args.first === 'number' ? args.first : null, args.after as string | null, (node) => cursorFor((node as GqlParent).number as number), 'PullRequestConnection');
}

// ---------------------------------------------------------------------------
// Mutations.

function executeMutation(executor: Executor, field: FieldNode): GqlParent | null {
  const store = executor.store;
  const args = argsOf(field, executor.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field.name === 'createIssue') {
    const decoded = ungid(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'Repository' || decoded.parts.length !== 2) return null;
    const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
    if (!repo) return null;
    const created = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) return null;
    return { __typename: 'CreateIssuePayload', issue: issueParent(store, repo, created) };
  }
  if (field.name === 'closeIssue') {
    const decoded = ungid(String(input.issueId ?? ''));
    if (!decoded || decoded.kind !== 'Issue' || decoded.parts.length !== 3) return null;
    const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
    const issue = repo?.issues.find((entry) => entry.number === Number(decoded.parts[2]));
    if (!repo || !issue) return null;
    issue.state = 'closed';
    issue.closedSec = store.clock.stamp();
    issue.updatedSec = issue.closedSec;
    repo.issueJsonCache.delete(issue.number);
    return { __typename: 'CloseIssuePayload', issue: issueParent(store, repo, issue) };
  }
  if (field.name === 'createPullRequest') {
    const decoded = ungid(String(input.repositoryId ?? ''));
    if (!decoded || decoded.kind !== 'Repository' || decoded.parts.length !== 2) return null;
    const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
    if (!repo) return null;
    const created = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if ('error' in created) return null;
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullParent(store, repo, created) };
  }
  if (field.name === 'mergePullRequest') {
    const decoded = ungid(String(input.pullRequestId ?? ''));
    if (!decoded || decoded.kind !== 'PullRequest' || decoded.parts.length !== 3) return null;
    const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
    const pull = repo?.pulls.find((entry) => entry.number === Number(decoded.parts[2]));
    if (!repo || !pull) return null;
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) return null;
    return { __typename: 'MergePullRequestPayload', pullRequest: pullParent(store, repo, pull) };
  }
  if (field.name === 'addComment') {
    const decoded = ungid(String(input.subjectId ?? ''));
    if (!decoded || decoded.kind !== 'Issue' || decoded.parts.length !== 3) return null;
    const repo = store.getRepo(decoded.parts[0], decoded.parts[1]);
    const issue = repo?.issues.find((entry) => entry.number === Number(decoded.parts[2]));
    if (!repo || !issue) return null;
    const comment = store.addComment(repo, issue, String(input.body ?? ''));
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: {
          __typename: 'IssueComment',
          id: commentGid(repo, issue, comment.id),
          body: comment.body,
          createdAt: isoOf(comment.createdSec),
          updatedAt: isoOf(comment.updatedSec),
        },
        cursor: cursorFor(comment.id),
      },
      subject: issueParent(store, repo, issue),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point: one document -> one result object.

export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string | null,
): Record<string, unknown> {
  let document: DocumentNode;
  try {
    document = parseDocument(query);
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL document is not valid' }] };
  }
  const operation = operationName
    ? document.operations.find((entry) => entry.name === operationName) ?? document.operations[0]
    : document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'GraphQL document carries no operation' }] };
  const executor: Executor = { store, variables, errors: [], fragments: document.fragments };
  const data: Record<string, unknown> = {};
  if (operation.operation === 'mutation') {
    for (const selection of operation.selections) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      const payload = executeMutation(executor, selection);
      if (payload === null) {
        data[key] = null;
        continue;
      }
      data[key] = selection.selections.length === 0 ? payload : executeSelections(executor, payload, selection.selections);
    }
  } else {
    const root: GqlParent = { __typename: 'Query' };
    Object.assign(data, executeSelections(executor, root, operation.selections));
  }
  const result: Record<string, unknown> = { data };
  if (executor.errors.length > 0) result.errors = executor.errors;
  return result;
}
