/**
 * Minimal ambient types for the `ws` package (v8).
 *
 * The project deliberately relies on the transitive `ws` already installed
 * (Next's dev server uses it) and adds it as an explicit dependency, but does
 * not pull in `@types/ws`. This declaration covers exactly the surface the
 * custom server and lib/dictation-live use; extend it if more is needed.
 */
declare module "ws" {
  import type { Server as HttpServer } from "node:http";
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";
  import type { EventEmitter } from "node:events";

  type RawData = Buffer | ArrayBuffer | Buffer[];
  // ws converts any TypedArray input at runtime; include Uint8Array so the
  // engine's `send(data: string | Uint8Array)` stays structurally assignable.
  type Data = string | Buffer | ArrayBuffer | Uint8Array | Buffer[];

  export class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;

    constructor(url: string | URL, protocols?: string | string[]);

    readonly readyState: number;
    readonly bufferedAmount: number;
    readonly protocol: string;
    readonly url: string;
    binaryType: "nodebuffer" | "arraybuffer" | "fragments";

    send(data: Data, callback?: (error?: Error) => void): void;
    send(
      data: Data,
      options: { binary?: boolean; compress?: boolean; mask?: boolean; fin?: boolean },
      callback?: (error?: Error) => void,
    ): void;
    close(code?: number, reason?: string | Buffer): void;
    ping(data?: Data, mask?: boolean, callback?: (error?: Error) => void): void;
    pong(data?: Data, mask?: boolean, callback?: (error?: Error) => void): void;
    terminate(): void;

    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer, wasClean: boolean) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "ping" | "pong", listener: (data: Buffer) => void): this;
    on(event: "unexpected-response", listener: (request: IncomingMessage, response: unknown) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }

  export interface WebSocketServerOptions {
    host?: string;
    port?: number;
    backlog?: number;
    server?: HttpServer;
    clientTracking?: boolean;
    noServer?: boolean;
    maxPayload?: number;
    perMessageDeflate?: boolean | Record<string, unknown>;
    skipUTF8Validation?: boolean;
    WebSocket?: typeof WebSocket;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options?: WebSocketServerOptions, callback?: () => void);
    readonly clients: Set<WebSocket>;
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      upgradeHead: Buffer,
      callback: (client: WebSocket, request: IncomingMessage) => void,
    ): void;
    close(callback?: (error?: Error) => void): void;

    on(event: "connection", listener: (client: WebSocket, request: IncomingMessage) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "listening", listener: () => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  }
}