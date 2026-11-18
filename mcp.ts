// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP.
//
// Speaks the 2026-07-28 revision (server/discover, no handshake) and
// the handshake revisions before it (initialize + notifications/
// initialized, an optional Mcp-Session-Id). The six tools act on the
// same store as REST, so an object made over MCP reads back over
// /api/v3 unchanged. tools/list is built once and served byte for
// byte identically on every call.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type Forge, type IssueRec, type PullRec, type Repo } from './store.ts';
import { Rest, readBody, squashMerge } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/repo full name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/repo full name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/repo full name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/repo full name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/repo full name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tools/list result, serialized once: identical bytes every call. */
const TOOLS_LIST_JSON = JSON.stringify({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: t.properties,
      required: t.required,
      additionalProperties: false,
    },
  })),
});

type Json = Record<string, unknown>;

function rpcResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id: id as never, result };
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id as never, error: { code, message } };
}

function sendRpc(res: ServerResponse, status: number, payload: unknown): void {
  const text = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function toolOk(value: unknown): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as never,
    isError: false,
  };
}

function toolErr(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argStr(args: Json, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

/** Resolve owner/repo from the arguments, honoring a full_name fill. */
function repoArgs(args: Json): { owner: string; repo: string } {
  let owner = argStr(args, 'owner');
  let repo = argStr(args, 'repo');
  const full = argStr(args, 'full_name');
  if ((owner === '' || repo === '') && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    if (owner === '') owner = o;
    if (repo === '') repo = r;
  }
  return { owner, repo };
}

export async function handleMcp(forge: Forge, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendRpc(res, 405, rpcError(null, -32601, 'Method not allowed'));
    return;
  }
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${token}`) {
    sendRpc(res, 401, rpcError(null, -32001, 'Unauthorized'));
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendRpc(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const rest = new Rest(forge, token);
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const item of parsed) {
      const answer = await dispatch(forge, rest, req, item as Json);
      if (answer !== undefined) answers.push(answer);
    }
    sendRpc(res, 200, answers);
    return;
  }
  const answer = await dispatch(forge, rest, req, parsed as Json);
  if (answer === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendRpc(res, 200, answer);
}

async function dispatch(forge: Forge, rest: Rest, req: IncomingMessage, call: Json): Promise<Json | undefined> {
  const method = typeof call.method === 'string' ? call.method : '';
  const id = call.id;
  const params = (call.params ?? {}) as Json;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const version = SUPPORTED_VERSIONS.includes(asked) ? asked : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, JSON.parse(TOOLS_LIST_JSON) as Json);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Json;
      const outcome = await callTool(forge, rest, req, name, args);
      if ('errorCode' in outcome) return rpcError(id, outcome.errorCode as number, outcome.errorMessage as string);
      return rpcResult(id, outcome);
    }
    default:
      if (isNotification) return undefined;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function callTool(forge: Forge, rest: Rest, req: IncomingMessage, name: string, args: Json): Promise<Json> {
  const tool = TOOLS.find((t) => t.name === name.toLowerCase() || name.toLowerCase().endsWith(t.name));
  if (!tool) {
    return { errorCode: -32602, errorMessage: `Unknown tool: ${name}` };
  }
  // Missing required arguments: a tool-level error, not a crash.
  for (const key of tool.required) {
    if (args[key] === undefined || args[key] === '') {
      // owner/repo may arrive as full_name instead.
      if ((key === 'owner' || key === 'repo') && typeof args.full_name === 'string' && (args.full_name as string).includes('/')) continue;
      return toolErr(`Missing required argument: ${key}`);
    }
  }

  switch (tool.name) {
    case 'create_repo': {
      const repoName = argStr(args, 'name');
      if (forge.getRepo(VIEWER.login, repoName)) return toolErr(`Repository ${repoName} already exists`);
      const repo = forge.createRepo(VIEWER.login, repoName, argStr(args, 'description'), args.private === true, 'main');
      return toolOk(rest.repoJson(req, repo));
    }
    case 'get_repo': {
      const { owner, repo } = repoArgs(args);
      const found = owner === VIEWER.login ? forge.getRepo(owner, repo) : undefined;
      if (!found) return toolErr(`Repository ${owner}/${repo} not found`);
      return toolOk(rest.repoJson(req, found));
    }
    case 'create_issue': {
      const { owner, repo } = repoArgs(args);
      const found = owner === VIEWER.login ? forge.getRepo(owner, repo) : undefined;
      if (!found) return toolErr(`Repository ${owner}/${repo} not found`);
      const { iso } = forge.clock.next();
      const issue: IssueRec = {
        id: forge.nextIssueId(),
        number: found.nextNumber,
        title: argStr(args, 'title'),
        body: argStr(args, 'body'),
        state: 'open',
        labels: [],
        comments: [],
        createdAt: iso,
        updatedAt: iso,
      };
      found.nextNumber += 1;
      found.issues.set(issue.number, issue);
      return toolOk(rest.issueJson(req, found, issue));
    }
    case 'list_issues': {
      const { owner, repo } = repoArgs(args);
      const found = owner === VIEWER.login ? forge.getRepo(owner, repo) : undefined;
      if (!found) return toolErr(`Repository ${owner}/${repo} not found`);
      const state = argStr(args, 'state') || 'open';
      const issues = [...found.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => b.number - a.number)
        .map((i) => rest.issueJson(req, found, i));
      return toolOk(issues);
    }
    case 'create_pull_request': {
      const { owner, repo } = repoArgs(args);
      const found = owner === VIEWER.login ? forge.getRepo(owner, repo) : undefined;
      if (!found) return toolErr(`Repository ${owner}/${repo} not found`);
      const headRef = argStr(args, 'head').split(':').pop() as string;
      const baseRef = argStr(args, 'base') || found.defaultBranch;
      const headSha = found.branchSha(headRef);
      if (!headSha) return toolErr(`Head branch ${headRef} not found`);
      const { iso } = forge.clock.next();
      const pull: PullRec = {
        id: forge.nextIssueId(),
        number: found.nextNumber,
        title: argStr(args, 'title'),
        body: argStr(args, 'body'),
        state: 'open',
        headRef,
        headSha,
        baseRef,
        merged: false,
        mergeSha: null,
        createdAt: iso,
        updatedAt: iso,
      };
      found.nextNumber += 1;
      found.pulls.set(pull.number, pull);
      return toolOk(rest.pullJson(req, found, pull));
    }
    case 'merge_pull_request': {
      const { owner, repo } = repoArgs(args);
      const found = owner === VIEWER.login ? forge.getRepo(owner, repo) : undefined;
      if (!found) return toolErr(`Repository ${owner}/${repo} not found`);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = found.pulls.get(number);
      if (!pull) return toolErr(`Pull request ${number} not found`);
      const message = `${pull.title}\n\n${pull.body}`.trimEnd() + '\n';
      const result = squashMerge(forge, found, pull, message);
      if (!result.ok) return toolErr(result.reason);
      return toolOk({ sha: result.sha, merged: true, message: 'Pull Request successfully merged', pull_request: rest.pullJson(req, found, pull) });
    }
    default:
      return toolErr(`Unimplemented tool: ${tool.name}`);
  }
}
