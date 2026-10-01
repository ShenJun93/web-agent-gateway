export interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
}

export interface CdpSuccess {
  readonly id: number;
  readonly result: unknown;
  readonly sessionId?: string;
}

export interface CdpFailure {
  readonly id: number;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
  readonly sessionId?: string;
}

export type CdpResponse = CdpSuccess | CdpFailure;

export interface CdpTransport {
  send(command: CdpCommand): Promise<CdpResponse>;
  close(): Promise<void>;
}

export class CdpProtocolClient {
  readonly #transport: CdpTransport;
  readonly #sessionId?: string;
  #nextId = 1;

  constructor(transport: CdpTransport, sessionId?: string) {
    this.#transport = transport;
    this.#sessionId = sessionId;
  }

  async call(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown> {
    const response = await this.#transport.send({
      id: this.#nextId++,
      method,
      ...(params === undefined ? {} : { params }),
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
    });
    if ('error' in response) {
      throw new Error(`CDP ${method} failed (${response.error.code}): ${response.error.message}`);
    }
    return response.result;
  }

  async close(): Promise<void> {
    await this.#transport.close();
  }
}
