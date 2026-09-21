export const CHATGPT_OPERATOR_OBSERVATION_MAX_BYTES = 128 * 1024;

const decoder = new TextEncoder();
const TOOL_BLOCK = /\`\`\`wag-tool\r?\n([\s\S]*?)\r?\n\`\`\`/g;
const PROFILE = /^[A-Za-z0-9._:-]{1,128}$/;
const VERIFY_REQUEST = /^verifyreq_[A-Za-z0-9-]{1,246}$/;
const MUTATION_ID = /^mut_[A-Za-z0-9-]{1,246}$/;
const COMMIT_ID = /^cmt_[A-Za-z0-9-]{1,246}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CONTENT_BYTES = 32 * 1024;
const MAX_MESSAGE_BYTES = 8 * 1024;

export function parseChatGptOperatorToolCall(text) {
  if (typeof text !== 'string' || decoder.encode(text).byteLength > CHATGPT_OPERATOR_OBSERVATION_MAX_BYTES) return undefined;
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
  if (value.tool === 'repo.search') {
    if (!allowedKeys(value.arguments, ['workspace_id', 'query'], ['ignore_case', 'max_results', 'context_lines'])) return undefined;
    const { workspace_id, query, ignore_case, max_results, context_lines } = value.arguments;
    if (!boundedString(workspace_id, 1, 256)) return undefined;
    if (typeof query !== 'string' || query.length < 1 || /[\0\r\n]/.test(query) || decoder.encode(query).byteLength > 256) return undefined;
    const args = { workspace_id, query };
    if (ignore_case !== undefined) {
      if (typeof ignore_case !== 'boolean') return undefined;
      args.ignore_case = ignore_case;
    }
    if (max_results !== undefined) {
      if (!Number.isInteger(max_results) || max_results < 1 || max_results > 50) return undefined;
      args.max_results = max_results;
    }
    if (context_lines !== undefined) {
      if (!Number.isInteger(context_lines) || context_lines < 0 || context_lines > 2) return undefined;
      args.context_lines = context_lines;
    }
    return { tool: 'repo.search', arguments: args };
  }
  if (value.tool === 'repo.snapshot') {
    if (!allowedKeys(value.arguments, ['workspace_id'], ['max_files'])) return undefined;
    const { workspace_id, max_files } = value.arguments;
    if (!boundedString(workspace_id, 1, 256)) return undefined;
    const args = { workspace_id };
    if (max_files !== undefined) {
      if (!Number.isInteger(max_files) || max_files < 1 || max_files > 200) return undefined;
      args.max_files = max_files;
    }
    return { tool: 'repo.snapshot', arguments: args };
  }
  if (value.tool === 'file.read') {
    if (!exactKeys(value.arguments, ['workspace_id', 'path'])) return undefined;
    if (!boundedString(value.arguments.workspace_id, 1, 256) || !boundedString(value.arguments.path, 1, 4096)) return undefined;
    return { tool: 'file.read', arguments: { workspace_id: value.arguments.workspace_id, path: value.arguments.path } };
  }
  if (value.tool === 'verify.preview') {
    if (!exactKeys(value.arguments, ['workspace_id', 'profile'])) return undefined;
    if (!boundedString(value.arguments.workspace_id, 1, 256) || typeof value.arguments.profile !== 'string' || !PROFILE.test(value.arguments.profile)) return undefined;
    return { tool: 'verify.preview', arguments: { workspace_id: value.arguments.workspace_id, profile: value.arguments.profile } };
  }
  if (value.tool === 'verify.result') {
    if (!exactKeys(value.arguments, ['request_id'])) return undefined;
    if (typeof value.arguments.request_id !== 'string' || !VERIFY_REQUEST.test(value.arguments.request_id)) return undefined;
    return { tool: 'verify.result', arguments: { request_id: value.arguments.request_id } };
  }
  if (value.tool === 'mutation.preview') {
    if (!exactKeys(value.arguments, ['workspace_id', 'path', 'base_sha256', 'before', 'after'])) return undefined;
    const { workspace_id, path, base_sha256, before, after } = value.arguments;
    if (!boundedString(workspace_id, 1, 256) || !boundedString(path, 1, 4096)) return undefined;
    if (typeof base_sha256 !== 'string' || !SHA256.test(base_sha256)) return undefined;
    if (typeof before !== 'string' || before.length < 1 || decoder.encode(before).byteLength > MAX_CONTENT_BYTES) return undefined;
    if (typeof after !== 'string' || decoder.encode(after).byteLength > MAX_CONTENT_BYTES) return undefined;
    return { tool: 'mutation.preview', arguments: { workspace_id, path, base_sha256, before, after } };
  }
  if (value.tool === 'file.create') {
    if (!exactKeys(value.arguments, ['workspace_id', 'path', 'content'])) return undefined;
    const { workspace_id, path, content } = value.arguments;
    if (!boundedString(workspace_id, 1, 256) || !boundedString(path, 1, 4096)) return undefined;
    if (typeof content !== 'string' || decoder.encode(content).byteLength > MAX_CONTENT_BYTES) return undefined;
    return { tool: 'file.create', arguments: { workspace_id, path, content } };
  }
  if (value.tool === 'mutation.result') {
    if (!exactKeys(value.arguments, ['mutation_id'])) return undefined;
    if (typeof value.arguments.mutation_id !== 'string' || !MUTATION_ID.test(value.arguments.mutation_id)) return undefined;
    return { tool: 'mutation.result', arguments: { mutation_id: value.arguments.mutation_id } };
  }
  if (value.tool === 'git.commit') {
    if (!exactKeys(value.arguments, ['workspace_id', 'paths', 'message'])) return undefined;
    const { workspace_id, paths, message } = value.arguments;
    if (!boundedString(workspace_id, 1, 256)) return undefined;
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 64) return undefined;
    if (!paths.every((entry) => boundedString(entry, 1, 1024))) return undefined;
    if (typeof message !== 'string' || message.length < 1 || decoder.encode(message).byteLength > MAX_MESSAGE_BYTES) return undefined;
    return { tool: 'git.commit', arguments: { workspace_id, paths: [...paths], message } };
  }
  if (value.tool === 'git.commit.result') {
    if (!exactKeys(value.arguments, ['commit_id'])) return undefined;
    if (typeof value.arguments.commit_id !== 'string' || !COMMIT_ID.test(value.arguments.commit_id)) return undefined;
    return { tool: 'git.commit.result', arguments: { commit_id: value.arguments.commit_id } };
  }
  return undefined;
}

export function parseChatGptOperatorObservation(value) {
  if (!plainObject(value) || typeof value.text !== 'string') return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, 'codeBlocks')) return parseChatGptOperatorToolCall(value.text);
  if (!exactKeys(value, ['text', 'codeBlocks'])) return undefined;
  if (!Array.isArray(value.codeBlocks) || value.codeBlocks.length !== 1) return undefined;
  const block = value.codeBlocks[0];
  if (!plainObject(block) || !exactKeys(block, ['language', 'text'])) return undefined;
  // Measured on chatgpt.com, 2026-09-20: the current renderer puts code blocks in a CodeMirror
  // viewer and drops the fence info string from the DOM entirely, so a `wag-tool` fence arrives
  // with no language at all. An untagged block is therefore accepted; any *other* language is
  // still refused, so a ```json block is never a proposal.
  //
  // The tag was only ever a selector. Authority does not rest on it: the payload must still be
  // exactly one compact JSON object with exactly the keys {tool, arguments} and a tool from the
  // twelve-name set, and the result is a proposal that a human approves twice.
  if (block.language !== 'wag-tool' && block.language !== '') return undefined;
  if (typeof block.text !== 'string') return undefined;
  if (block.text.includes('~~~') || block.text.includes('```')) return undefined;
  return parseChatGptOperatorToolCall('```wag-tool\n' + block.text.trim() + '\n```');
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

function allowedKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (!required.every((key) => keys.includes(key))) return false;
  return keys.every((key) => allowed.has(key));
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedString(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}
