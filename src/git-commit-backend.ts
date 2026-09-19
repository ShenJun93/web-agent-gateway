/** One entry of the resulting tree delta. v1 accepts additions and modifications only. */
export interface GitCommitChange {
  status: 'A' | 'M';
  path: string;
}

/** The repository facts a commit proposal is bound to, as observed at preview time. */
export interface GitCommitPlan {
  branch: string;
  ref: string;
  head: string;
  tree: string;
  changes: GitCommitChange[];
  /**
   * `Name <email>`, as git itself would stamp it. Taken from the repository's own configuration,
   * which is untrusted input, so it is bound into the record and shown to the operator rather
   * than assumed.
   */
  author: string;
}

export interface GitCommitRequest {
  paths: readonly string[];
  message: string;
  expectedBranch: string;
  expectedOldHead: string;
  expectedTree: string;
  expectedAuthor: string;
}

export interface GitCommitResult {
  branch: string;
  commit: string;
  tree: string;
  previousHead: string;
  changes: GitCommitChange[];
}

export interface GitCommitBackend {
  readonly kind: string;
  /**
   * Observes branch/HEAD and computes the resulting tree without writing anything.
   *
   * The message is passed even though planning does not use it, because the executor accepts one
   * bounded command string: planning is where an input too large to ever execute must be refused,
   * not after a human has already approved it.
   */
  plan(root: string, paths: readonly string[], message: string): Promise<GitCommitPlan>;
  /** Re-observes, refuses on any drift, then creates one commit and moves the branch by CAS. */
  commit(root: string, request: GitCommitRequest): Promise<GitCommitResult>;
}
