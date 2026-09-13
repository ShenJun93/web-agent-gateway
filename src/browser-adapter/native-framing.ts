import { BROWSER_ADAPTER_MAX_BYTES } from './protocol.js';

const PREFIX_BYTES = 4;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function encodeNativeMessage(value: unknown): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Native message is not JSON serializable');
  const body = Buffer.from(json, 'utf8');
  if (body.length < 1) throw new Error('Native message length cannot be zero');
  if (body.length > BROWSER_ADAPTER_MAX_BYTES) {
    throw new Error('Native message exceeds size limit');
  }
  const frame = Buffer.allocUnsafe(PREFIX_BYTES + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, PREFIX_BYTES);
  return frame;
}

export class NativeMessageDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength > 0) {
      this.#buffer = this.#buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.#buffer, chunk]);
    }
    return this.#drain();
  }

  #drain(): unknown[] {
    const values: unknown[] = [];
    while (this.#buffer.length >= PREFIX_BYTES) {
      const bodyLength = this.#buffer.readUInt32LE(0);
      if (bodyLength === 0) throw new Error('Native message length cannot be zero');
      if (bodyLength > BROWSER_ADAPTER_MAX_BYTES) {
        throw new Error('Native message length exceeds size limit');
      }
      const frameLength = PREFIX_BYTES + bodyLength;
      if (this.#buffer.length < frameLength) break;
      const body = this.#buffer.subarray(PREFIX_BYTES, frameLength);
      this.#buffer = this.#buffer.subarray(frameLength);
      values.push(parseBody(body));
    }
    return values;
  }
}

function parseBody(body: Uint8Array): unknown {
  let text: string;
  try {
    text = utf8Decoder.decode(body);
  } catch (error) {
    throw new Error('Native message UTF-8 decode failed', { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error('Native message JSON parse failed', { cause: error });
  }
}
