export interface FileMutationBackend {
  readonly kind: string;
  readExact(root: string, path: string): Promise<string>;
  /**
   * Returns the file's exact content, or `undefined` when it does not exist.
   *
   * Absence has to be distinguishable from every other read failure, because a creation that
   * misreads a permission error as "absent" would turn into an overwrite.
   */
  readExactIfPresent(root: string, path: string): Promise<string | undefined>;
  updateExisting(root: string, path: string, original: string, candidate: string): Promise<void>;
  /** Creates a file that must not already exist; the backend proves it created rather than replaced. */
  createNew(root: string, path: string, candidate: string): Promise<void>;
}
