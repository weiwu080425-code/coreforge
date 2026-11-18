// The forge's state: users, repositories, issues, pull requests.
//
// One process holds everything in memory for the length of a trial.
// Nothing here reads the wall clock or a random source: timestamps come
// from a deterministic clock seeded by MAKEFUN_TRIAL_NOW and advanced
// by a counter, and every id comes from a counter, so two runs that
// receive the same requests produce byte-identical answers.

import { ObjectStore, buildCommit, flattenTree, parseCommit, writeTreeFromFlat } from './git.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

/**
 * The suite's viewer: the login the trial's bearer token names. The
 * suite's scenario is fixed by its published seed (the kit's wire.ts
 * SCENARIO_SEED), so these are constants of the contest, like its
 * label names: the viewer is user 1000, adaiversen.
 */
export const VIEWER: User = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** Deterministic clock: a base instant plus a tick counter. */
export class Clock {
  private baseEpochSec: number;
  private ticks = 0;

  constructor(nowIso: string | undefined) {
    const parsed = nowIso ? Date.parse(nowIso) : NaN;
    this.baseEpochSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1_700_000_000;
  }

  /** The next timestamp: strictly increasing, one second per call. */
  next(): { epoch: number; iso: string } {
    this.ticks += 1;
    const epoch = this.baseEpochSec + this.ticks;
    return { epoch, iso: new Date(epoch * 1000).toISOString() };
  }

  /** A git ident line for the viewer at the next tick. */
  ident(): string {
    const { epoch } = this.next();
    return `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
  }
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  merged: boolean;
  mergeSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string;
}

export class Repo {
  readonly store = new ObjectStore();
  /** Full ref name (refs/heads/main) -> commit sha. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelRec>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  nextNumber = 1;

  readonly id: number;
  readonly owner: string;
  name: string;
  description: string;
  readonly isPrivate: boolean;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;

  constructor(
    id: number,
    owner: string,
    name: string,
    description: string,
    isPrivate: boolean,
    defaultBranch: string,
    createdAt: string,
    updatedAt: string,
  ) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  branchSha(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** The tree sha at a branch tip, or undefined for an unborn branch. */
  tipTree(branch: string): string | undefined {
    const sha = this.branchSha(branch);
    if (!sha) return undefined;
    const obj = this.store.read(sha);
    if (!obj || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data).tree;
  }

  /**
   * Apply file changes on a branch and commit them: `changes` maps a
   * path to a blob sha, or to null to delete it. Returns the commit sha.
   * An unborn branch starts from the empty tree with no parent.
   */
  commitChanges(clock: Clock, branch: string, changes: Map<string, string | null>, message: string): string {
    const parent = this.branchSha(branch);
    const files = new Map<string, { mode: string; sha: string }>();
    const baseTree = this.tipTree(branch);
    if (baseTree) for (const [k, v] of flattenTree(this.store, baseTree)) files.set(k, v);
    for (const [path, sha] of changes) {
      if (sha === null) files.delete(path);
      else files.set(path, { mode: files.get(path)?.mode ?? '100644', sha });
    }
    const tree = writeTreeFromFlat(this.store, files);
    return this.commitTree(clock, branch, tree, message);
  }

  /** Commit an exact tree on a branch (a squash merge's shape). */
  commitTree(clock: Clock, branch: string, tree: string, message: string): string {
    const parent = this.branchSha(branch);
    const ident = clock.ident();
    const commit = buildCommit({
      tree,
      parents: parent ? [parent] : [],
      author: ident,
      committer: ident,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const sha = this.store.write('commit', commit);
    this.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }
}

export class Forge {
  readonly clock: Clock;
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private labelSeq = 0;
  private requestSeq = 0;

  constructor(nowIso: string | undefined) {
    this.clock = new Clock(nowIso);
  }

  /** A deterministic, non-empty request id for the GitHub header. */
  requestId(): string {
    this.requestSeq += 1;
    return `forge-${this.requestSeq.toString(16).padStart(8, '0')}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo {
    this.repoSeq += 1;
    const { iso } = this.clock.next();
    const repo = new Repo(this.repoSeq, owner, name, description, isPrivate, defaultBranch, iso, iso);
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER.login);
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  nextLabelId(): number {
    this.labelSeq += 1;
    return this.labelSeq;
  }
}
