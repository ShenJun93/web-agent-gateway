export interface FileMutationBackend {
  readonly kind: string;
  readExact(root: string, path: string): Promise<string>;
  updateExisting(root: string, path: string, original: string, candidate: string): Promise<void>;
}
