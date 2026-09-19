export const CHATGPT_VERIFY_OBSERVATION_MAX_BYTES: number;
export type ParsedVerifyProviderCall =
  | { tool: 'health'; arguments: Record<string, never> }
  | { tool: 'workspace.open'; arguments: { path: string } }
  | { tool: 'repo.search'; arguments: { workspace_id: string; query: string; ignore_case?: boolean; max_results?: number; context_lines?: number } }
  | { tool: 'repo.snapshot'; arguments: { workspace_id: string; max_files?: number } }
  | { tool: 'file.read'; arguments: { workspace_id: string; path: string } }
  | { tool: 'verify.preview'; arguments: { workspace_id: string; profile: string } }
  | { tool: 'verify.result'; arguments: { request_id: string } };

export function parseChatGptVerifyToolCall(text: string): ParsedVerifyProviderCall | undefined;
export function parseChatGptVerifyObservation(value: unknown): ParsedVerifyProviderCall | undefined;
