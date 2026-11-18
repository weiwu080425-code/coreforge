// GraphQL v4: the documents gh and github-mcp-server send, answered
// from the same store as REST.
//
// A small honest engine: a lexer and parser for the query language
// (operations, variables, aliases, fragments, inline fragments, list
// and object literals), a schema table the introspection probes read,
// and resolvers over the forge's repositories, issues and pull
// requests. Global ids are the REST node ids (R_ / I_ / PR_ / C_), so
// an object keeps one id on every surface.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type Forge, type IssueRec, type PullRec, type Repo } from './store.ts';
import { Rest, readBody, squashMerge } from './rest.ts';

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: Value }>;
  selections: Selection[];
}

type Selection =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selections: Selection[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$!@='.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end === -1 ? source.length : end)}"`);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          out += source[j + 1];
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z0-9_.-]+/.exec(source.slice(i));
    if (m) {
      tokens.push(m[0]);
      i += m[0].length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        const type = this.next() as Operation['type'];
        let name: string | null = null;
        if (this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.parseVariableDefs();
        this.skipDirectives();
        operations.push({ type, name, selections: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefs(): void {
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.peek() === '=') {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          this.next(); // arg name
          this.expect(':');
          this.parseValue();
        }
        this.expect(')');
      }
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else if (this.peek() === '{') {
          selections.push({ kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: FieldNode['args'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    this.skipDirectives();
    const selections = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { name, alias, args, selections };
  }

  private parseValue(): Value {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t.startsWith('"')) return { kind: 'string', value: t.slice(1, -1) };
    if (t === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t === 'true' || t === 'false') return { kind: 'bool', value: t === 'true' };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: Number(t) };
    if (/^-?\d*\.\d+/.test(t)) return { kind: 'float', value: Number(t) };
    return { kind: 'enum', value: t };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

// ------------------------------------------------------------------ schema

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE';
  fields: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', '__type', '__schema', '__typename'] },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email', 'url', '__typename'] },
  RepositoryOwner: { kind: 'INTERFACE', fields: ['login', 'id', 'url', '__typename'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
      'url', 'createdAt', 'updatedAt', '__typename',
    ],
  },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix', '__typename'] },
  Issue: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'createdAt', 'updatedAt',
      'closed', 'url', 'comments', 'labels', '__typename',
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
      'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergeCommit', '__typename',
    ],
  },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor', '__typename'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor', '__typename'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount', '__typename'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType', '__typename'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'] },
  Comment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt', '__typename'] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor', '__typename'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId', '__typename'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId', '__typename'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId', '__typename'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId', '__typename'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'subject', 'clientMutationId', '__typename'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', '__typename'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason', '__typename'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason', '__typename'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'REBASE', 'SQUASH'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
};

// ------------------------------------------------------------------ execution

type Ctx = {
  forge: Forge;
  rest: Rest;
  req: IncomingMessage;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
};

/** A resolved object: its GraphQL type plus a bag of field resolvers. */
interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

function obj(type: string, fields: Record<string, unknown>): GqlObject {
  return { __type: type, ...fields };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}

function repoObject(ctx: Ctx, repo: Repo): GqlObject {
  return obj('Repository', {
    _repo: repo,
    id: `R_${repo.id}`,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    description: repo.description,
    isPrivate: repo.isPrivate,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    owner: obj('User', { login: VIEWER.login, id: `U_${VIEWER.id}` }),
    defaultBranchRef: obj('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/' }),
  });
}

function issueObject(issue: IssueRec): GqlObject {
  return obj('Issue', {
    _issue: issue,
    id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    closed: issue.state === 'closed',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: obj('User', { login: VIEWER.login, id: `U_${VIEWER.id}` }),
  });
}

function pullObject(ctx: Ctx, repo: Repo, pull: PullRec): GqlObject {
  return obj('PullRequest', {
    _pull: pull,
    _repo: repo,
    id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: mergeableOf(ctx.forge, repo, pull),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    author: obj('User', { login: VIEWER.login, id: `U_${VIEWER.id}` }),
  });
}

function mergeableOf(forge: Forge, repo: Repo, pull: PullRec): string {
  if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
  // Probe with a dry merge decision: reuse the REST conflict rule.
  const probe: PullRec = { ...pull };
  const before = repo.branchSha(pull.baseRef);
  const result = squashMerge(forge, repo, probe, 'probe\n');
  if (result.ok) {
    // Undo the probe: restore the ref and the pull's flags.
    if (before) repo.refs.set(`refs/heads/${pull.baseRef}`, before);
    else repo.refs.delete(`refs/heads/${pull.baseRef}`);
    return 'MERGEABLE';
  }
  return 'CONFLICTING';
}

function typeObject(name: string): GqlObject | null {
  const info = SCHEMA[name];
  if (!info) return null;
  return obj('__Type', {
    _typeName: name,
    name,
    kind: info.kind,
    description: null,
    fields: info.fields.map((f) => obj('__Field', { name: f, description: null, isDeprecated: false, deprecationReason: null })),
    enumValues: (info.enumValues ?? []).map((v) => obj('__EnumValue', { name: v, description: null, isDeprecated: false, deprecationReason: null })),
    possibleTypes: [],
  });
}

function findRepoByGlobalId(forge: Forge, id: string): Repo | undefined {
  const m = /^R_(\d+)$/.exec(id);
  if (!m) return undefined;
  return forge.viewerRepos().find((r) => r.id === Number(m[1]));
}

function findIssueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: IssueRec } | undefined {
  const m = /^I_(\d+)$/.exec(id);
  if (!m) return undefined;
  for (const repo of forge.viewerRepos()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === Number(m[1])) return { repo, issue };
    }
  }
  return undefined;
}

function findPullByGlobalId(forge: Forge, id: string): { repo: Repo; pull: PullRec } | undefined {
  const m = /^PR_(\d+)$/.exec(id);
  if (!m) return undefined;
  for (const repo of forge.viewerRepos()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === Number(m[1])) return { repo, pull };
    }
  }
  return undefined;
}

function nodeById(ctx: Ctx, id: string): GqlObject | null {
  const repo = findRepoByGlobalId(ctx.forge, id);
  if (repo) return repoObject(ctx, repo);
  const issueHit = findIssueByGlobalId(ctx.forge, id);
  if (issueHit) return issueObject(issueHit.issue);
  const pullHit = findPullByGlobalId(ctx.forge, id);
  if (pullHit) return pullObject(ctx, pullHit.repo, pullHit.pull);
  return null;
}

function validateSelections(typeName: string, selections: Selection[], doc: Document, ctx: Ctx): void {
  const info = SCHEMA[typeName];
  if (!info) return;
  for (const sel of selections) {
    if (sel.kind === 'field') {
      if (!info.fields.includes(sel.field.name)) {
        ctx.errors.push({ message: `Field '${sel.field.name}' doesn't exist on type '${typeName}'` });
      }
    } else if (sel.kind === 'spread') {
      const frag = doc.fragments.get(sel.name);
      if (frag) validateSelections(frag.typeCondition, frag.selections, doc, ctx);
    } else if (sel.kind === 'inline' && sel.typeCondition) {
      validateSelections(sel.typeCondition, sel.selections, doc, ctx);
    }
  }
}

function resolveField(ctx: Ctx, parent: GqlObject | null, field: FieldNode, doc: Document): unknown {
  const args = argsOf(field, ctx.variables);
  const typeName = parent === null ? (field.name === '__type' || field.name === '__schema' ? 'Query' : '') : parent.__type;

  if (field.name === '__typename') return parent?.__type ?? 'Query';
  if (field.name === '__type') {
    return typeObject(String(args.name ?? ''));
  }

  if (parent === null) {
    // Query / Mutation roots are handled by executeOperation.
    return null;
  }

  const raw = parent[field.name];
  if (typeof raw === 'function') return (raw as (a: Record<string, unknown>) => unknown)(args);
  if (raw !== undefined) return raw;

  // Computed fields that need arguments or the document.
  if (parent.__type === 'Repository') {
    const repo = parent._repo as Repo;
    if (field.name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueObject(issue) : null;
    }
    if (field.name === 'issues') return issuesConnection(ctx, repo, args);
    if (field.name === 'pullRequest') {
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullObject(ctx, repo, pull) : null;
    }
    if (field.name === 'pullRequests') return pullsConnection(ctx, repo, args);
  }
  if (parent.__type === 'PullRequest' && field.name === 'files') {
    const repo = parent._repo as Repo;
    const pull = parent._pull as PullRec;
    const files = ctx.rest.pullFiles(repo, pull);
    const first = typeof args.first === 'number' ? args.first : files.length;
    return obj('PullRequestChangedFileConnection', {
      nodes: files.slice(0, first).map((f) => obj('PullRequestChangedFile', {
        path: f.filename, additions: f.additions, deletions: f.deletions, changeType: String(f.status).toUpperCase(),
      })),
      totalCount: files.length,
    });
  }
  if (parent.__type === '__Type') {
    if (field.name === 'fields') return parent.fields;
    if (field.name === 'enumValues') return parent.enumValues;
  }
  return null;
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues.values()];
  const states = args.states as unknown[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = states.map((s) => String(s).toLowerCase());
    issues = issues.filter((i) => wanted.includes(i.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'DESC');
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  return connection('IssueConnection', 'IssueEdge', issues, args, (i) => issueObject(i));
}

function pullsConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): GqlObject {
  let pulls = [...repo.pulls.values()];
  const states = args.states as unknown[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = states.map((s) => String(s));
    pulls = pulls.filter((p) => wanted.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
  }
  pulls.sort((a, b) => b.number - a.number);
  return connection('PullRequestConnection', 'PullRequestEdge', pulls, args, (p) => pullObject(ctx, repo, p));
}

function connection<T>(type: string, edgeType: string, items: T[], args: Record<string, unknown>, map: (item: T) => GqlObject): GqlObject {
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    start = indexFromCursor(args.after) + 1;
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(start, start + first);
  const hasNext = start + page.length < items.length;
  const endCursor = page.length > 0 ? cursorFor(start + page.length - 1) : null;
  return obj(type, {
    nodes: page.map(map),
    edges: page.map((item, i) => obj(edgeType, { node: map(item), cursor: cursorFor(start + i) })),
    pageInfo: obj('PageInfo', {
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
      endCursor,
    }),
    totalCount: items.length,
  });
}

function executeSelections(ctx: Ctx, parent: GqlObject | null, selections: Selection[], doc: Document): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'field') {
      const key = sel.field.alias ?? sel.field.name;
      const value = resolveField(ctx, parent, sel.field, doc);
      out[key] = completeValue(ctx, value, sel.field, doc);
    } else if (sel.kind === 'spread') {
      const frag = doc.fragments.get(sel.name);
      if (frag && (parent === null || frag.typeCondition === parent.__type)) {
        Object.assign(out, executeSelections(ctx, parent, frag.selections, doc));
      }
    } else if (sel.kind === 'inline') {
      if (parent === null || sel.typeCondition === null || sel.typeCondition === parent.__type) {
        Object.assign(out, executeSelections(ctx, parent, sel.selections, doc));
      }
    }
  }
  return out;
}

function completeValue(ctx: Ctx, value: unknown, field: FieldNode, doc: Document): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => completeValue(ctx, v, field, doc));
  if (typeof value === 'object' && (value as GqlObject).__type) {
    if (field.selections.length === 0) return value;
    return executeSelections(ctx, value as GqlObject, field.selections, doc);
  }
  return value;
}

function executeOperation(ctx: Ctx, op: Operation, doc: Document): Record<string, unknown> {
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(rootType, op.selections, doc, ctx);
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind !== 'field') continue;
    const field = sel.field;
    const key = field.alias ?? field.name;
    const args = argsOf(field, ctx.variables);
    let value: unknown = null;

    if (op.type === 'query') {
      if (field.name === 'viewer') {
        value = obj('User', { login: VIEWER.login, id: `U_${VIEWER.id}`, name: VIEWER.name, email: VIEWER.email });
        validateSelections('User', field.selections, doc, ctx);
      } else if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = owner === VIEWER.login ? ctx.forge.getRepo(owner, name) : undefined;
        value = repo ? repoObject(ctx, repo) : null;
        if (repo) validateSelections('Repository', field.selections, doc, ctx);
      } else if (field.name === 'node') {
        value = nodeById(ctx, String(args.id ?? ''));
      } else if (field.name === '__type') {
        value = typeObject(String(args.name ?? ''));
      } else if (field.name === '__typename') {
        value = 'Query';
      } else {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Query'` });
        value = null;
      }
    } else {
      value = executeMutation(ctx, field, args);
    }
    out[key] = completeValue(ctx, value, field, doc);
  }
  return out;
}

function executeMutation(ctx: Ctx, field: FieldNode, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repo = findRepoByGlobalId(forge, String(input.repositoryId ?? ''));
      if (!repo) return null;
      const { iso } = forge.clock.next();
      const issue: IssueRec = {
        id: forge.nextIssueId(),
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        createdAt: iso,
        updatedAt: iso,
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return obj('CreateIssuePayload', { issue: issueObject(issue), clientMutationId: input.clientMutationId ?? null });
    }
    case 'closeIssue': {
      const hit = findIssueByGlobalId(forge, String(input.issueId ?? ''));
      if (!hit) return null;
      hit.issue.state = 'closed';
      hit.issue.updatedAt = forge.clock.next().iso;
      return obj('CloseIssuePayload', { issue: issueObject(hit.issue), clientMutationId: input.clientMutationId ?? null });
    }
    case 'reopenIssue': {
      const hit = findIssueByGlobalId(forge, String(input.issueId ?? ''));
      if (!hit) return null;
      hit.issue.state = 'open';
      hit.issue.updatedAt = forge.clock.next().iso;
      return obj('CloseIssuePayload', { issue: issueObject(hit.issue), clientMutationId: input.clientMutationId ?? null });
    }
    case 'createPullRequest': {
      const repo = findRepoByGlobalId(forge, String(input.repositoryId ?? ''));
      if (!repo) return null;
      const headRef = String(input.headRefName ?? '').split(':').pop() as string;
      const baseRef = String(input.baseRefName ?? '') || repo.defaultBranch;
      const headSha = repo.branchSha(headRef);
      if (!headSha) return null;
      const { iso } = forge.clock.next();
      const pull: PullRec = {
        id: forge.nextIssueId(),
        number: repo.nextNumber,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        headRef,
        headSha,
        baseRef,
        merged: false,
        mergeSha: null,
        createdAt: iso,
        updatedAt: iso,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return obj('CreatePullRequestPayload', { pullRequest: pullObject(ctx, repo, pull), clientMutationId: input.clientMutationId ?? null });
    }
    case 'mergePullRequest': {
      const hit = findPullByGlobalId(forge, String(input.pullRequestId ?? ''));
      if (!hit) return null;
      const message = `${hit.pull.title}\n\n${hit.pull.body}`.trimEnd() + '\n';
      const result = squashMerge(forge, hit.repo, hit.pull, message);
      if (!result.ok) {
        ctx.errors.push({ message: result.reason });
        return obj('MergePullRequestPayload', { pullRequest: pullObject(ctx, hit.repo, hit.pull), clientMutationId: input.clientMutationId ?? null });
      }
      return obj('MergePullRequestPayload', { pullRequest: pullObject(ctx, hit.repo, hit.pull), clientMutationId: input.clientMutationId ?? null });
    }
    case 'addComment': {
      const hit = findIssueByGlobalId(forge, String(input.subjectId ?? ''));
      if (!hit) return null;
      const { iso } = forge.clock.next();
      const comment = { id: forge.nextCommentId(), body: String(input.body ?? ''), createdAt: iso, updatedAt: iso };
      hit.issue.comments.push(comment);
      const node = obj('Comment', {
        id: `C_${comment.id}`,
        body: comment.body,
        createdAt: iso,
        updatedAt: iso,
        author: obj('User', { login: VIEWER.login, id: `U_${VIEWER.id}` }),
      });
      return obj('AddCommentPayload', {
        commentEdge: obj('CommentEdge', { node, cursor: cursorFor(hit.issue.comments.length - 1) }),
        subject: issueObject(hit.issue),
        clientMutationId: input.clientMutationId ?? null,
      });
    }
    default:
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'` });
      return null;
  }
}

// ------------------------------------------------------------------ HTTP

export async function handleGraphql(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Method not allowed' }));
    return;
  }
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }));
    return;
  }
  const rest = new Rest(forge, token);
  const runOne = (entry: Record<string, unknown>): Record<string, unknown> => {
    const query = String(entry.query ?? '');
    const variables = (entry.variables ?? {}) as Record<string, unknown>;
    const ctx: Ctx = { forge, rest, req, variables, errors: [] };
    let doc: Document;
    try {
      doc = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
    const opName = typeof entry.operationName === 'string' ? entry.operationName : null;
    const op = doc.operations.find((o) => opName === null || o.name === opName) ?? doc.operations[0];
    if (!op) return { errors: [{ message: 'No operation found' }] };
    const data = executeOperation(ctx, op, doc);
    const answer: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) answer.errors = ctx.errors;
    return answer;
  };
  const payload = Array.isArray(body) ? body.map((entry) => runOne(entry as Record<string, unknown>)) : runOne(body as Record<string, unknown>);
  const text = `${JSON.stringify(payload)}\n`;
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
