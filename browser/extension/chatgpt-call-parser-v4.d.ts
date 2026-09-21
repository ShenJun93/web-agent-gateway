export const CHATGPT_OPERATOR_OBSERVATION_MAX_BYTES: number;
export type ParsedOperatorProviderCall =
  | { tool: 'health'; arguments: Record<string, never> }
  | { tool: 'workspace.open'; arguments: { path: string } }
  | { tool: 'repo.search'; arguments: { workspace_id: string; query: string; ignore_case?: boolean; max_results?: number; context_lines?: number } }
  | { tool: 'repo.snapshot'; arguments: { workspace_id: string; max_files?: number } }
  | { tool: 'file.read'; arguments: { workspace_id: string; path: string } }
  | { tool: 'verify.preview'; arguments: { workspace_id: string; profile: string } }
  | { tool: 'verify.result'; arguments: { request_id: string } }
  | { tool: 'mutation.preview'; arguments: { workspace_id: string; path: string; base_sha256: string; before: string; after: string } }
  | { tool: 'file.create'; arguments: { workspace_id: string; path: string; content: string } }
  | { tool: 'mutation.result'; arguments: { mutation_id: string } }
  | { tool: 'git.commit'; arguments: { workspace_id: string; paths: string[]; message: string } }
  | { tool: 'git.commit.result'; arguments: { commit_id: string } };

export function parseChatGptOperatorToolCall(text: string): ParsedOperatorProviderCall | undefined;
export function parseChatGptOperatorObservation(value: unknown): ParsedOperatorProviderCall | undefined;
