export const CHATGPT_OBSERVATION_MAX_BYTES = 128 * 1024;

const decoder = new TextEncoder();
const TOOL_BLOCK = /```wag-tool\r?\n([\s\S]*?)\r?\n```/g;

export function parseChatGptToolCall(text) {
  if (typeof text !== 'string' || decoder.encode(text).byteLength > CHATGPT_OBSERVATION_MAX_BYTES) return undefined;
  const matches = [...text.matchAll(TOOL_BLOCK)];
  if (matches.length !== 1) return undefined;
  const raw = matches[0][1]?.trim();
  if (!raw) return undefined;

  let value;
  try { value = JSON.parse(raw); }
  catch { return undefined; }
  if (!plainObject(value)) return undefined;
  if (compactJson(raw) !== JSON.stringify(value)) return undefined;
  if (!exactKeys(value, ['tool', 'arguments']) || !plainObject(value.arguments)) return undefined;

  if (value.tool === 'health') {
    if (!exactKeys(value.arguments, [])) return undefined;
    return { tool: 'health', arguments: {} };
  }
  if (value.tool === 'workspace.open') {
    if (!exactKeys(value.arguments, ['path']) || !boundedString(value.arguments.path, 1, 4096)) return undefined;
    return { tool: 'workspace.open', arguments: { path: value.arguments.path } };
  }
  if (value.tool === 'file.read') {
    if (!exactKeys(value.arguments, ['workspace_id', 'path'])) return undefined;
    if (!boundedString(value.arguments.workspace_id, 1, 256) || !boundedString(value.arguments.path, 1, 4096)) return undefined;
    return { tool: 'file.read', arguments: { workspace_id: value.arguments.workspace_id, path: value.arguments.path } };
  }
  return undefined;
}
function compactJson(value) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (!/\s/.test(char)) {
      result += char;
    }
  }
  return result;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedString(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}
