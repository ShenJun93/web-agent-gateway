export const CHATGPT_OBSERVATION_MAX_BYTES: number;
export type ParsedProviderCall =
  | { tool: 'health'; arguments: Record<string, never> }
  | { tool: 'workspace.open'; arguments: { path: string } }
  | {
      tool: 'repo.search';
      arguments: {
        workspace_id: string;
        query: string;
        ignore_case?: boolean;
        max_results?: number;
        context_lines?: number;
      };
    }
  | {
      tool: 'repo.snapshot';
      arguments: {
        workspace_id: string;
        max_files?: number;
      };
    }
  | { tool: 'file.read'; arguments: { workspace_id: string; path: string } };

export function parseChatGptToolCall(text: string): ParsedProviderCall | undefined;

export function parseChatGptObservation(value: unknown): ParsedProviderCall | undefined;
