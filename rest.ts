// The REST v3 surface: repositories, branches, commits, contents,
// issues, comments, labels and pull requests, GitHub-shaped.
//
// Every reply is JSON with an X-GitHub-Request-Id header; errors are
// JSON with a string message; a request without the trial's bearer
// token is 401; another owner's repository is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { flattenTree, parseCommit, treeEntriesAt, treeLookup } from './git.ts';
import { VIEWER, type Forge, type IssueRec, type PullRec, type Repo } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  const all: Record<string, string> = { ...headers };
  if (body !== undefined) {
    all['content-type'] = JSON_TYPE;
    all['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, all);
  res.end(text);
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; undefined body counts as {}, bad JSON as null. */
export function parseJsonBody(raw: Buffer): Record<string, unknown> | null {
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class Rest {
  private readonly forge: Forge;
  private readonly token: string;

  constructor(forge: Forge, token: string) {
    this.forge = forge;
    this.token = token;
  }

  private base(req: IncomingMessage): string {
    const host = req.headers.host ?? 'localhost';
    return `http://${host}`;
  }

  private userJson(): Record<string, unknown> {
    return {
      login: VIEWER.login,
      id: VIEWER.id,
      type: 'User',
      name: VIEWER.name,
      email: VIEWER.email,
      site_admin: false,
    };
  }

  repoJson(req: IncomingMessage, repo: Repo): Record<string, unknown> {
    const base = this.base(req);
    const api = `${base}/api/v3/repos/${repo.fullName}`;
    return {
      id: repo.id,
      node_id: `R_${repo.id}`,
      name: repo.name,
      full_name: repo.fullName,
      owner: this.userJson(),
      private: repo.isPrivate,
      description: repo.description,
      fork: false,
      url: api,
      html_url: `${base}/${repo.fullName}`,
      clone_url: `${base}/${repo.fullName}.git`,
      git_url: `git://${req.headers.host ?? 'localhost'}/${repo.fullName}.git`,
      ssh_url: `git@${req.headers.host ?? 'localhost'}:${repo.fullName}.git`,
      default_branch: repo.defaultBranch,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      pushed_at: repo.updatedAt,
      size: 0,
      stargazers_count: 0,
      watchers_count: 0,
      forks_count: 0,
      open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
      has_issues: true,
      has_pull_requests: true,
      visibility: repo.isPrivate ? 'private' : 'public',
    };
  }

  private labelJson(repo: Repo, name: string): Record<string, unknown> | null {
    const label = repo.labels.get(name);
    if (!label) return null;
    return {
      id: label.id,
      name: label.name,
      color: label.color,
      description: label.description,
      default: false,
      url: `${''}/labels/${encodeURIComponent(name)}`,
    };
  }

  issueJson(req: IncomingMessage, repo: Repo, issue: IssueRec): Record<string, unknown> {
    const base = this.base(req);
    const api = `${base}/api/v3/repos/${repo.fullName}`;
    return {
      id: issue.id,
      node_id: `I_${issue.id}`,
      url: `${api}/issues/${issue.number}`,
      repository_url: api,
      labels_url: `${api}/issues/${issue.number}/labels{/name}`,
      comments_url: `${api}/issues/${issue.number}/comments`,
      html_url: `${base}/${repo.fullName}/issues/${issue.number}`,
      number: issue.number,
      state: issue.state,
      title: issue.title,
      body: issue.body,
      user: this.userJson(),
      labels: issue.labels.map((name) => this.labelJson(repo, name)).filter((x) => x !== null),
      assignees: [],
      comments: issue.comments.length,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    };
  }

  pullJson(req: IncomingMessage, repo: Repo, pull: PullRec): Record<string, unknown> {
    const base = this.base(req);
    const api = `${base}/api/v3/repos/${repo.fullName}`;
    const refJson = (ref: string, sha: string): Record<string, unknown> => ({
      label: `${repo.owner}:${ref}`,
      ref,
      sha,
      user: this.userJson(),
      repo: this.repoJson(req, repo),
    });
    return {
      id: pull.id,
      node_id: `PR_${pull.id}`,
      url: `${api}/pulls/${pull.number}`,
      html_url: `${base}/${repo.fullName}/pull/${pull.number}`,
      number: pull.number,
      state: pull.state,
      title: pull.title,
      body: pull.body,
      user: this.userJson(),
      labels: [],
      head: refJson(pull.headRef, pull.headSha),
      base: refJson(pull.baseRef, repo.branchSha(pull.baseRef) ?? ''),
      merged: pull.merged,
      merged_at: pull.merged ? pull.updatedAt : null,
      merge_commit_sha: pull.mergeSha,
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    };
  }

  /** A pull request seen through the issues API, as GitHub serves it. */
  private pullAsIssueJson(req: IncomingMessage, repo: Repo, pull: PullRec): Record<string, unknown> {
    const base = this.base(req);
    const api = `${base}/api/v3/repos/${repo.fullName}`;
    return {
      id: pull.id,
      url: `${api}/issues/${pull.number}`,
      repository_url: api,
      html_url: `${base}/${repo.fullName}/pull/${pull.number}`,
      number: pull.number,
      state: pull.state,
      title: pull.title,
      body: pull.body,
      user: this.userJson(),
      labels: [],
      comments: 0,
      pull_request: {
        url: `${api}/pulls/${pull.number}`,
        html_url: `${base}/${repo.fullName}/pull/${pull.number}`,
        merged_at: pull.merged ? pull.updatedAt : null,
      },
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    };
  }

  private fail(res: ServerResponse, status: number, message: string): void {
    sendJson(res, status, { message });
  }

  /** Handle one /api/v3 request. Returns true when the route matched. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const forge = this.forge;
    res.setHeader('x-github-request-id', forge.requestId());
    const method = req.method ?? 'GET';
    const path = url.pathname;

    // Auth: everything under /api/v3 takes the trial token.
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${this.token}`) {
      this.fail(res, 401, 'Bad credentials');
      return true;
    }

    const raw = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.length > 0 || method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const parsed = parseJsonBody(raw);
      if (parsed === null) {
        this.fail(res, 400, 'Problems parsing JSON');
        return true;
      }
      body = parsed;
    }

    const seg = path.split('/').filter((s) => s !== '');
    // seg[0] = 'api', seg[1] = 'v3'
    const rest = seg.slice(2);

    if (rest.length === 0) {
      if (method !== 'GET') return false;
      sendJson(res, 200, {
        current_user_url: `${this.base(req)}/api/v3/user`,
        user_url: `${this.base(req)}/api/v3/users/{user}`,
        repository_url: `${this.base(req)}/api/v3/repos/{owner}/{repo}`,
        rate_limit_url: `${this.base(req)}/api/v3/rate_limit`,
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }

    if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0-forge', api: ['v3'], authentication: ['token'] });
      return true;
    }

    if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
      sendJson(res, 200, this.userJson());
      return true;
    }

    if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
      if (method === 'GET') {
        const all = forge.viewerRepos().sort((a, b) => a.id - b.id);
        this.paginate(req, res, url, all, (repo) => this.repoJson(req, repo));
        return true;
      }
      if (method === 'POST') {
        const name = str(body.name);
        if (name === '') {
          this.fail(res, 422, 'Repository creation failed: name is required');
          return true;
        }
        if (forge.getRepo(VIEWER.login, name)) {
          sendJson(res, 422, { message: 'Repository creation failed', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] });
          return true;
        }
        const repo = forge.createRepo(
          VIEWER.login,
          name,
          str(body.description),
          body.private === true,
          str(body.default_branch) || 'main',
        );
        sendJson(res, 201, this.repoJson(req, repo));
        return true;
      }
      return false;
    }

    if (rest[0] !== 'repos' || rest.length < 3) return false;
    const owner = decodeURIComponent(rest[1]);
    const repoName = decodeURIComponent(rest[2]);
    const repo = owner === VIEWER.login ? forge.getRepo(owner, repoName) : undefined;
    if (!repo) {
      this.fail(res, 404, 'Not Found');
      return true;
    }
    const tail = rest.slice(3).map((s) => decodeURIComponent(s));

    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, this.repoJson(req, repo));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          forge.repos.delete(repo.fullName);
          (repo as { name: string }).name = body.name;
          forge.repos.set(repo.fullName, repo);
        }
        repo.updatedAt = forge.clock.next().iso;
        sendJson(res, 200, this.repoJson(req, repo));
        return true;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, repoName);
        res.writeHead(204, { 'x-github-request-id': forge.requestId() });
        res.end();
        return true;
      }
      return false;
    }

    return this.handleRepoTail(req, res, url, repo, tail, method, body);
  }

  private paginate<T>(req: IncomingMessage, res: ServerResponse, url: URL, all: T[], map: (item: T) => unknown): void {
    const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page')) || 30));
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    const headers: Record<string, string> = {};
    if (start + perPage < all.length) {
      const next = new URL(url.pathname, this.base(req));
      for (const [k, v] of url.searchParams) next.searchParams.set(k, v);
      next.searchParams.set('page', String(page + 1));
      next.searchParams.set('per_page', String(perPage));
      const last = new URL(url.pathname, this.base(req));
      for (const [k, v] of url.searchParams) last.searchParams.set(k, v);
      last.searchParams.set('page', String(Math.ceil(all.length / perPage)));
      last.searchParams.set('per_page', String(perPage));
      headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
    }
    sendJson(res, 200, slice.map(map), headers);
  }

  private async handleRepoTail(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    repo: Repo,
    tail: string[],
    method: string,
    body: Record<string, unknown>,
  ): Promise<boolean> {
    const forge = this.forge;
    const [head, ...restTail] = tail;

    // ---- git refs and branches -------------------------------------------
    if (head === 'git' && restTail[0] === 'refs') {
      if (method === 'POST' && restTail.length === 1) {
        const ref = str(body.ref);
        const sha = str(body.sha);
        const obj = repo.store.read(sha);
        if (!ref.startsWith('refs/') || !obj || obj.type !== 'commit') {
          this.fail(res, 422, 'Invalid ref or sha');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, {
          ref,
          node_id: `REF_${ref}`,
          url: `${this.base(req)}/api/v3/repos/${repo.fullName}/git/refs/${ref.slice('refs/'.length)}`,
          object: { sha, type: 'commit', url: `${this.base(req)}/api/v3/repos/${repo.fullName}/git/commits/${sha}` },
        });
        return true;
      }
      if (method === 'GET' && restTail.length >= 2) {
        const ref = `refs/${restTail.join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) {
          this.fail(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      return false;
    }

    if (head === 'branches' && restTail.length === 0 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: `${this.base(req)}/api/v3/repos/${repo.fullName}/commits/${sha}` },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      this.paginate(req, res, url, branches, (b) => b);
      return true;
    }

    if (head === 'branches' && restTail.length === 1 && method === 'GET') {
      const sha = repo.branchSha(restTail[0]);
      if (!sha) {
        this.fail(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, {
        name: restTail[0],
        commit: this.commitJson(req, repo, sha),
        protected: false,
      });
      return true;
    }

    // ---- commits ----------------------------------------------------------
    if (head === 'commits' && restTail.length === 0 && method === 'GET') {
      const refParam = url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(refParam.startsWith('refs/') ? refParam : `refs/heads/${refParam}`) ?? (repo.store.has(refParam) ? refParam : undefined);
      if (!tip) {
        sendJson(res, 200, []);
        return true;
      }
      const history = repo.store.history(tip).filter((sha) => repo.store.read(sha)?.type === 'commit');
      this.paginate(req, res, url, history, (sha) => this.commitJson(req, repo, sha));
      return true;
    }

    if (head === 'commits' && restTail.length === 1 && method === 'GET') {
      const sha = restTail[0];
      if (!repo.store.read(sha) || repo.store.read(sha)?.type !== 'commit') {
        this.fail(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, this.commitJson(req, repo, sha));
      return true;
    }

    // ---- contents ---------------------------------------------------------
    if (head === 'contents') {
      const path = restTail.join('/');
      return this.handleContents(req, res, url, repo, path, method, body);
    }

    // ---- labels -----------------------------------------------------------
    if (head === 'labels' && restTail.length === 0) {
      if (method === 'GET') {
        const labels = [...repo.labels.values()].map((l) => ({
          id: l.id, name: l.name, color: l.color, description: l.description, default: false,
        }));
        this.paginate(req, res, url, labels, (l) => l);
        return true;
      }
      if (method === 'POST') {
        const name = str(body.name);
        if (name === '') {
          this.fail(res, 422, 'Validation Failed: name is required');
          return true;
        }
        if (repo.labels.has(name)) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }] });
          return true;
        }
        const label = {
          id: forge.nextLabelId(),
          name,
          color: (str(body.color) || 'ededed').replace(/^#/, ''),
          description: str(body.description),
        };
        repo.labels.set(name, label);
        sendJson(res, 201, { id: label.id, name: label.name, color: label.color, description: label.description, default: false });
        return true;
      }
      return false;
    }

    // ---- issues -----------------------------------------------------------
    if (head === 'issues' && restTail.length === 0) {
      if (method === 'POST') {
        const title = str(body.title);
        const labelNames = Array.isArray(body.labels) ? body.labels.map((x) => str(x)) : [];
        for (const name of labelNames) {
          if (!repo.labels.has(name)) {
            sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `label ${name} does not exist` }] });
            return true;
          }
        }
        const { iso } = forge.clock.next();
        const issue: IssueRec = {
          id: forge.nextIssueId(),
          number: repo.nextNumber,
          title,
          body: str(body.body),
          state: 'open',
          labels: labelNames,
          comments: [],
          createdAt: iso,
          updatedAt: iso,
        };
        repo.nextNumber += 1;
        repo.issues.set(issue.number, issue);
        sendJson(res, 201, this.issueJson(req, repo, issue));
        return true;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const items: Array<Record<string, unknown>> = [];
        for (const issue of repo.issues.values()) {
          if (state === 'all' || issue.state === state) items.push(this.issueJson(req, repo, issue));
        }
        for (const pull of repo.pulls.values()) {
          if (state === 'all' || pull.state === state) items.push(this.pullAsIssueJson(req, repo, pull));
        }
        items.sort((a, b) => Number(b.number) - Number(a.number));
        const sort = url.searchParams.get('sort');
        const direction = url.searchParams.get('direction');
        if (sort === 'created' && direction === 'asc') items.reverse();
        this.paginate(req, res, url, items, (x) => x);
        return true;
      }
      return false;
    }

    if (head === 'issues' && restTail.length >= 1) {
      const number = Number(restTail[0]);
      const issue = repo.issues.get(number);
      const pull = repo.pulls.get(number);
      if (restTail.length === 1) {
        if (!issue && !pull) {
          this.fail(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue ? this.issueJson(req, repo, issue) : this.pullAsIssueJson(req, repo, pull as PullRec));
          return true;
        }
        if (method === 'PATCH' && issue) {
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
          if (Array.isArray(body.labels)) {
            const names = body.labels.map((x) => str(x));
            for (const name of names) {
              if (!repo.labels.has(name)) {
                this.fail(res, 422, `label ${name} does not exist`);
                return true;
              }
            }
            issue.labels = names;
          }
          issue.updatedAt = forge.clock.next().iso;
          sendJson(res, 200, this.issueJson(req, repo, issue));
          return true;
        }
        if (method === 'PATCH' && pull) {
          if (body.state === 'closed' || body.state === 'open') {
            pull.state = body.state;
            pull.updatedAt = forge.clock.next().iso;
          }
          sendJson(res, 200, this.pullAsIssueJson(req, repo, pull));
          return true;
        }
        return false;
      }
      if (restTail[1] === 'comments' && issue) {
        if (method === 'POST' && restTail.length === 2) {
          const { iso } = forge.clock.next();
          const comment = { id: forge.nextCommentId(), body: str(body.body), createdAt: iso, updatedAt: iso };
          issue.comments.push(comment);
          issue.updatedAt = iso;
          sendJson(res, 201, {
            id: comment.id,
            body: comment.body,
            user: this.userJson(),
            created_at: comment.createdAt,
            updated_at: comment.updatedAt,
            url: `${this.base(req)}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
            html_url: `${this.base(req)}/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
            issue_url: `${this.base(req)}/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
          });
          return true;
        }
        if (method === 'GET' && restTail.length === 2) {
          const comments = issue.comments.map((c) => ({
            id: c.id,
            body: c.body,
            user: this.userJson(),
            created_at: c.createdAt,
            updated_at: c.updatedAt,
          }));
          this.paginate(req, res, url, comments, (c) => c);
          return true;
        }
      }
      return false;
    }

    // ---- pull requests ------------------------------------------------------
    if (head === 'pulls' && restTail.length === 0) {
      if (method === 'POST') {
        const headRef = str(body.head).split(':').pop() as string;
        const baseRef = str(body.base) || repo.defaultBranch;
        const headSha = repo.branchSha(headRef);
        if (!headSha) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] });
          return true;
        }
        if (!repo.branchSha(baseRef) && repo.tipTree(baseRef) === undefined && repo.refs.size > 0) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] });
          return true;
        }
        const { iso } = forge.clock.next();
        const pull: PullRec = {
          id: forge.nextIssueId(),
          number: repo.nextNumber,
          title: str(body.title),
          body: str(body.body),
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
        sendJson(res, 201, this.pullJson(req, repo, pull));
        return true;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const pulls = [...repo.pulls.values()]
          .filter((p) => state === 'all' || p.state === state)
          .sort((a, b) => b.number - a.number);
        this.paginate(req, res, url, pulls, (p) => this.pullJson(req, repo, p));
        return true;
      }
      return false;
    }

    if (head === 'pulls' && restTail.length >= 1) {
      const number = Number(restTail[0]);
      const pull = repo.pulls.get(number);
      if (!pull) {
        this.fail(res, 404, 'Not Found');
        return true;
      }
      if (restTail.length === 1) {
        if (method === 'GET') {
          sendJson(res, 200, this.pullJson(req, repo, pull));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof body.title === 'string') pull.title = body.title;
          if (typeof body.body === 'string') pull.body = body.body;
          if (body.state === 'closed' || body.state === 'open') pull.state = body.state;
          pull.updatedAt = forge.clock.next().iso;
          sendJson(res, 200, this.pullJson(req, repo, pull));
          return true;
        }
        return false;
      }
      if (restTail[1] === 'files' && restTail.length === 2 && method === 'GET') {
        const files = this.pullFiles(repo, pull);
        this.paginate(req, res, url, files, (f) => f);
        return true;
      }
      if (restTail[1] === 'merge' && restTail.length === 2 && method === 'PUT') {
        return this.mergePull(req, res, repo, pull, body);
      }
      return false;
    }

    return false;
  }

  private commitJson(req: IncomingMessage, repo: Repo, sha: string): Record<string, unknown> {
    const obj = repo.store.read(sha);
    const commit = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
    const ident = (line: string): Record<string, unknown> => {
      const m = /^(.*) <(.*)> (\d+) /.exec(line);
      return {
        name: m ? m[1] : '',
        email: m ? m[2] : '',
        date: m ? new Date(Number(m[3]) * 1000).toISOString() : '',
      };
    };
    return {
      sha,
      node_id: `C_${sha}`,
      url: `${this.base(req)}/api/v3/repos/${repo.fullName}/commits/${sha}`,
      html_url: `${this.base(req)}/${repo.fullName}/commit/${sha}`,
      commit: {
        message: commit ? commit.message.replace(/\n$/, '') : '',
        tree: { sha: commit?.tree ?? '' },
        author: commit ? ident(commit.author) : {},
        committer: commit ? ident(commit.committer) : {},
        comment_count: 0,
      },
      author: this.userJson(),
      committer: this.userJson(),
      parents: (commit?.parents ?? []).map((p) => ({ sha: p, url: `${this.base(req)}/api/v3/repos/${repo.fullName}/commits/${p}` })),
    };
  }

  /** Diff the pull's base and head trees into the files list shape. */
  pullFiles(repo: Repo, pull: PullRec): Array<Record<string, unknown>> {
    const baseTree = repo.tipTree(pull.baseRef);
    const headObj = repo.store.read(pull.headSha);
    const headTree = headObj && headObj.type === 'commit' ? parseCommit(headObj.data).tree : undefined;
    const baseFiles = baseTree ? flattenTree(repo.store, baseTree) : new Map();
    const headFiles = headTree ? flattenTree(repo.store, headTree) : new Map();
    const names = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<Record<string, unknown>> = [];
    for (const name of [...names].sort()) {
      const b = baseFiles.get(name);
      const h = headFiles.get(name);
      if (b && h && b.sha === h.sha) continue;
      const baseText = b ? (repo.store.read(b.sha)?.data.toString('utf8') ?? '') : '';
      const headText = h ? (repo.store.read(h.sha)?.data.toString('utf8') ?? '') : '';
      const { additions, deletions } = lineDiff(baseText, headText);
      out.push({
        sha: h?.sha ?? b?.sha ?? '',
        filename: name,
        status: !b ? 'added' : !h ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return out;
  }

  private mergePull(req: IncomingMessage, res: ServerResponse, repo: Repo, pull: PullRec, body: Record<string, unknown>): boolean {
    const title = str(body.commit_title) || pull.title;
    const message = `${title}\n\n${str(body.commit_message) || pull.body}`.trimEnd() + '\n';
    const result = squashMerge(this.forge, repo, pull, message);
    if (!result.ok) {
      this.fail(res, 405, result.reason);
      return true;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return true;
  }

  private handleContents(req: IncomingMessage, res: ServerResponse, url: URL, repo: Repo, path: string, method: string, body: Record<string, unknown>): boolean {
    const forge = this.forge;
    const branch = str(body.branch) || url.searchParams.get('ref') || repo.defaultBranch;
    const tipTree = repo.tipTree(branch);

    if (method === 'GET') {
      if (!tipTree) {
        if (path === '') {
          sendJson(res, 200, []);
          return true;
        }
        this.fail(res, 404, 'Not Found');
        return true;
      }
      if (path === '') {
        const entries = treeEntriesAt(repo.store, tipTree, '') ?? [];
        sendJson(res, 200, entries.map((e) => this.contentEntryJson(req, repo, e, e.name)));
        return true;
      }
      const entry = treeLookup(repo.store, tipTree, path);
      if (!entry) {
        this.fail(res, 404, 'Not Found');
        return true;
      }
      if (entry.mode === '40000') {
        const entries = treeEntriesAt(repo.store, tipTree, path) ?? [];
        sendJson(res, 200, entries.map((e) => this.contentEntryJson(req, repo, e, `${path}/${e.name}`)));
        return true;
      }
      const blob = repo.store.read(entry.sha);
      const data = blob?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        name: path.split('/').pop(),
        path,
        sha: entry.sha,
        size: data.length,
        type: 'file',
        encoding: 'base64',
        content: wrapBase64(data),
        url: `${this.base(req)}/api/v3/repos/${repo.fullName}/contents/${path}`,
        html_url: `${this.base(req)}/${repo.fullName}/blob/${branch}/${path}`,
        download_url: `${this.base(req)}/${repo.fullName}/raw/${branch}/${path}`,
      });
      return true;
    }

    if (method === 'PUT') {
      const message = str(body.message) || 'Update file';
      const contentB64 = str(body.content);
      const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      const blobSha = repo.store.write('blob', data);
      const existing = tipTree ? treeLookup(repo.store, tipTree, path) : undefined;
      if (existing && existing.mode !== '40000') {
        const given = str(body.sha);
        if (given !== existing.sha) {
          this.fail(res, 409, 'Conflict: sha does not match');
          return true;
        }
      }
      const changes = new Map<string, string | null>([[path, blobSha]]);
      const commitSha = repo.commitChanges(forge.clock, branch, changes, message);
      repo.updatedAt = forge.clock.next().iso;
      sendJson(res, existing ? 200 : 201, {
        content: {
          name: path.split('/').pop(),
          path,
          sha: blobSha,
          size: data.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commitSha, message },
      });
      return true;
    }

    if (method === 'DELETE') {
      const existing = tipTree ? treeLookup(repo.store, tipTree, path) : undefined;
      if (!existing || existing.mode === '40000') {
        this.fail(res, 404, 'Not Found');
        return true;
      }
      const given = str(body.sha);
      if (given !== '' && given !== existing.sha) {
        this.fail(res, 409, 'Conflict: sha does not match');
        return true;
      }
      const message = str(body.message) || 'Delete file';
      const commitSha = repo.commitChanges(forge.clock, branch, new Map([[path, null]]), message);
      sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
      return true;
    }

    return false;
  }

  private contentEntryJson(req: IncomingMessage, repo: Repo, entry: { mode: string; name: string; sha: string }, path: string): Record<string, unknown> {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : repo.store.read(entry.sha);
    return {
      name: entry.name,
      path,
      sha: entry.sha,
      size: isDir ? 0 : (blob?.data.length ?? 0),
      type: isDir ? 'dir' : 'file',
      url: `${this.base(req)}/api/v3/repos/${repo.fullName}/contents/${path}`,
      html_url: `${this.base(req)}/${repo.fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
      download_url: isDir ? null : `${this.base(req)}/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
    };
  }
}

export type MergeResult = { ok: true; sha: string } | { ok: false; reason: string };

/**
 * Squash-merge a pull request onto its base branch: the head's tree
 * lands as one commit on the base. A conflict — the base moved since
 * the pull diverged and both sides changed the same path differently —
 * refuses. Shared by the REST merge route and the MCP tool.
 */
export function squashMerge(forge: Forge, repo: Repo, pull: PullRec, message: string): MergeResult {
  if (pull.merged || pull.state === 'closed') {
    return { ok: false, reason: 'Pull Request is not mergeable' };
  }
  const baseTip = repo.branchSha(pull.baseRef);
  const headObj = repo.store.read(pull.headSha);
  if (!headObj || headObj.type !== 'commit') {
    return { ok: false, reason: 'Pull Request is not mergeable' };
  }
  const headTree = parseCommit(headObj.data).tree;
  const recordedBase = pullBaseSha(repo, pull);
  if (baseTip && recordedBase && baseTip !== recordedBase) {
    const atRecorded = flattenTree(repo.store, parseCommit(repo.store.read(recordedBase)?.data ?? Buffer.alloc(0)).tree);
    const atBase = flattenTree(repo.store, parseCommit(repo.store.read(baseTip)?.data ?? Buffer.alloc(0)).tree);
    const atHead = flattenTree(repo.store, headTree);
    for (const [path, headFile] of atHead) {
      const rec = atRecorded.get(path);
      const cur = atBase.get(path);
      const headChanged = rec?.sha !== headFile.sha;
      const baseChanged = rec?.sha !== cur?.sha;
      if (headChanged && baseChanged && cur?.sha !== headFile.sha) {
        return { ok: false, reason: 'Pull Request is not mergeable: conflict' };
      }
    }
  }
  const sha = repo.commitTree(forge.clock, pull.baseRef, headTree, message);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeSha = sha;
  pull.updatedAt = forge.clock.next().iso;
  return { ok: true, sha };
}

/** The base commit a pull was opened against: the merge-base of head and base. */
function pullBaseSha(repo: Repo, pull: PullRec): string | undefined {
  const baseTip = repo.branchSha(pull.baseRef);
  if (!baseTip) return undefined;
  const headAncestors = new Set(repo.store.history(pull.headSha));
  for (const sha of repo.store.history(baseTip)) {
    if (headAncestors.has(sha)) return sha;
  }
  return undefined;
}

/** GitHub wraps base64 content at 60 columns with newlines. */
function wrapBase64(data: Buffer): string {
  const b64 = data.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 60) lines.push(b64.slice(i, i + 60));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** Line-level diff counts via a simple longest-common-subsequence walk. */
export function lineDiff(a: string, b: string): { additions: number; deletions: number } {
  if (a === b) return { additions: 0, deletions: 0 };
  const aLines = a === '' ? [] : a.split('\n');
  const bLines = b === '' ? [] : b.split('\n');
  const m = aLines.length;
  const n = bLines.length;
  if (m * n > 4_000_000) {
    return { additions: n, deletions: m };
  }
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = aLines[i] === bLines[j]
        ? dp[(i + 1) * (n + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}
