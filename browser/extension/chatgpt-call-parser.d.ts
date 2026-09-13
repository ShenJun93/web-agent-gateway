export const CHATGPT_OBSERVATION_MAX_BYTES: number;

export type ParsedProviderCall =
  | { tool: 'health'; arguments: Record<string, never> }
  | { tool: 'workspace.open'; arguments: { path: string } }
  | { tool: 'file.read'; arguments: { workspace_id: string; path: string } };

export function parseChatGptToolCall(text: string): ParsedProviderCall | undefined;
