import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { GatewayAuthority } from '../caller-context.js';
import type { BrowserPort } from './browser-port.js';

export interface SemanticNode {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly disabled: boolean;
  readonly editable: boolean;
  readonly focusable: boolean;
}

export interface SemanticSnapshot {
  readonly snapshotId: string;
  readonly browserSessionId: string;
  readonly url: string;
  readonly title: string;
  readonly nodes: readonly SemanticNode[];
}

export interface SemanticBrowser {
  snapshot(owner: GatewayAuthority, browserSessionId: string): Promise<SemanticSnapshot>;
  navigate(owner: GatewayAuthority, browserSessionId: string, url: string): Promise<void>;
  click(owner: GatewayAuthority, browserSessionId: string, ref: string): Promise<void>;
  fill(owner: GatewayAuthority, browserSessionId: string, ref: string, text: string): Promise<void>;
  setFiles(owner: GatewayAuthority, browserSessionId: string, ref: string, internalPaths: readonly string[]): Promise<void>;
  press(owner: GatewayAuthority, browserSessionId: string, key: string): Promise<void>;
}

interface AxValue {
  value?: unknown;
}

interface AxProperty {
  name?: unknown;
  value?: AxValue;
}

interface AxNode {
  ignored?: unknown;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: AxProperty[];
  backendDOMNodeId?: unknown;
}

interface SnapshotBinding {
  snapshotId: string;
  refs: Map<string, { backendDOMNodeId: number; node: SemanticNode }>;
}

const REF = /^node_[0-9a-f-]{36}_[0-9]+$/;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_UPLOAD_FILES = 20;
const MAX_INTERNAL_PATH_BYTES = 4096;
const PRESS_KEYS = new Map<string, { key: string; code: string }>([
  ['Enter', { key: 'Enter', code: 'Enter' }],
  ['Tab', { key: 'Tab', code: 'Tab' }],
  ['Escape', { key: 'Escape', code: 'Escape' }],
  ['Backspace', { key: 'Backspace', code: 'Backspace' }],
  ['Delete', { key: 'Delete', code: 'Delete' }],
  ['ArrowUp', { key: 'ArrowUp', code: 'ArrowUp' }],
  ['ArrowDown', { key: 'ArrowDown', code: 'ArrowDown' }],
  ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft' }],
  ['ArrowRight', { key: 'ArrowRight', code: 'ArrowRight' }],
]);

function value(input: AxValue | undefined): string {
  return typeof input?.value === 'string' ? input.value : '';
}

function flag(properties: AxProperty[] | undefined, name: string): boolean {
  const property = properties?.find((item) => item.name === name);
  return property?.value?.value === true;
}

function parseAxNodes(result: unknown, snapshotId: string): SnapshotBinding & { nodes: SemanticNode[] } {
  const source = typeof result === 'object' && result !== null
    ? (result as { nodes?: unknown }).nodes
    : undefined;
  if (!Array.isArray(source)) throw new Error('Browser semantic snapshot returned no AX nodes');

  const refs = new Map<string, { backendDOMNodeId: number; node: SemanticNode }>();
  const nodes: SemanticNode[] = [];
  let index = 0;
  for (const raw of source) {
    if (typeof raw !== 'object' || raw === null) continue;
    const ax = raw as AxNode;
    if (ax.ignored === true || !Number.isInteger(ax.backendDOMNodeId)) continue;
    const role = value(ax.role);
    const name = value(ax.name);
    if (!role && !name) continue;
    const ref = `node_${snapshotId}_${index++}`;
    const rawValue = value(ax.value);
    const node: SemanticNode = Object.freeze({
      ref,
      role,
      name,
      ...(rawValue === '' ? {} : { value: rawValue }),
      disabled: flag(ax.properties, 'disabled'),
      editable: flag(ax.properties, 'editable') || ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(role),
      focusable: flag(ax.properties, 'focusable'),
    });
    refs.set(ref, { backendDOMNodeId: ax.backendDOMNodeId as number, node });
    nodes.push(node);
  }
  return { snapshotId, refs, nodes };
}

function boxCenter(result: unknown): { x: number; y: number } {
  const model = typeof result === 'object' && result !== null
    ? (result as { model?: { border?: unknown; content?: unknown } }).model
    : undefined;
  const quad = Array.isArray(model?.border) ? model.border
    : Array.isArray(model?.content) ? model.content
    : undefined;
  if (!quad || quad.length < 8 || quad.some((item) => typeof item !== 'number')) {
    throw new Error('Browser semantic target has no usable box model');
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  return {
    x: xs.reduce((sum, item) => sum + item, 0) / xs.length,
    y: ys.reduce((sum, item) => sum + item, 0) / ys.length,
  };
}

function validateNavigationUrl(input: string): string {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser navigation scheme is denied');
  return url.toString();
}

export function createSemanticBrowser(options: {
  port: BrowserPort;
  randomUUID?: () => string;
}): SemanticBrowser {
  const uuid = options.randomUUID ?? randomUUID;
  const bindings = new Map<string, SnapshotBinding>();

  function binding(browserSessionId: string, ref: string) {
    if (!REF.test(ref)) throw new Error('Browser semantic ref is invalid');
    const current = bindings.get(browserSessionId);
    const resolved = current?.refs.get(ref);
    if (!current || !resolved) throw new Error('Browser semantic ref is stale or unknown');
    return resolved;
  }

  return {
    async snapshot(owner, browserSessionId) {
      const metadata = await options.port.snapshot(owner, browserSessionId);
      const snapshotId = uuid();
      const parsed = parseAxNodes(
        await options.port.exec(owner, browserSessionId, { method: 'Accessibility.getFullAXTree' }),
        snapshotId,
      );
      bindings.set(browserSessionId, parsed);
      return Object.freeze({
        snapshotId,
        browserSessionId,
        url: metadata.url,
        title: metadata.title,
        nodes: Object.freeze([...parsed.nodes]),
      });
    },

    async navigate(owner, browserSessionId, url) {
      bindings.delete(browserSessionId);
      await options.port.exec(owner, browserSessionId, {
        method: 'Page.navigate',
        params: { url: validateNavigationUrl(url) },
      });
    },

    async click(owner, browserSessionId, ref) {
      const target = binding(browserSessionId, ref);
      if (target.node.disabled) throw new Error('Browser semantic target is disabled');
      await options.port.exec(owner, browserSessionId, {
        method: 'DOM.scrollIntoViewIfNeeded',
        params: { backendNodeId: target.backendDOMNodeId },
      });
      const center = boxCenter(await options.port.exec(owner, browserSessionId, {
        method: 'DOM.getBoxModel',
        params: { backendNodeId: target.backendDOMNodeId },
      }));
      await options.port.exec(owner, browserSessionId, {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseMoved', x: center.x, y: center.y },
      });
      await options.port.exec(owner, browserSessionId, {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: center.x, y: center.y, button: 'left', clickCount: 1 },
      });
      await options.port.exec(owner, browserSessionId, {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: center.x, y: center.y, button: 'left', clickCount: 1 },
      });
    },

    async fill(owner, browserSessionId, ref, text) {
      const target = binding(browserSessionId, ref);
      if (target.node.disabled) throw new Error('Browser semantic target is disabled');
      if (!target.node.editable) throw new Error('Browser semantic target is not editable');
      if (typeof text !== 'string' || text.includes('\0') || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
        throw new Error('Browser fill text is invalid');
      }
      await options.port.exec(owner, browserSessionId, {
        method: 'DOM.focus',
        params: { backendNodeId: target.backendDOMNodeId },
      });
      await options.port.exec(owner, browserSessionId, {
        method: 'Input.dispatchKeyEvent',
        params: { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2 },
      });
      await options.port.exec(owner, browserSessionId, {
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 },
      });
      await options.port.exec(owner, browserSessionId, {
        method: 'Input.insertText',
        params: { text },
      });
    },

    async setFiles(owner, browserSessionId, ref, internalPaths) {
      const target = binding(browserSessionId, ref);
      if (target.node.disabled) throw new Error('Browser semantic target is disabled');
      if (!Array.isArray(internalPaths) || internalPaths.length < 1 || internalPaths.length > MAX_UPLOAD_FILES) {
        throw new Error('Browser upload path set is invalid');
      }
      const files = internalPaths.map((path) => {
        if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')
            || Buffer.byteLength(path, 'utf8') > MAX_INTERNAL_PATH_BYTES) {
          throw new Error('Browser upload internal path is invalid');
        }
        return path;
      });
      await options.port.exec(owner, browserSessionId, {
        method: 'DOM.setFileInputFiles',
        params: { files, backendNodeId: target.backendDOMNodeId },
      });
    },

    async press(owner, browserSessionId, key) {
      const value = PRESS_KEYS.get(key);
      if (!value) throw new Error('Browser key is not supported');
      await options.port.exec(owner, browserSessionId, {
        method: 'Input.dispatchKeyEvent',
        params: { type: 'rawKeyDown', key: value.key, code: value.code },
      });
      await options.port.exec(owner, browserSessionId, {
        method: 'Input.dispatchKeyEvent',
        params: { type: 'keyUp', key: value.key, code: value.code },
      });
    },
  };
}
