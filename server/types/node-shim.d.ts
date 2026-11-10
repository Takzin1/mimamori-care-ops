// Minimal, hand-written declarations for the Node built-ins used by the
// local CareOps server. This keeps runtime and dev dependencies at their
// current minimum (no @types/node). Only the members actually used are
// declared; extend deliberately.

declare module "node:sqlite" {
  export type SQLInputValue = null | number | bigint | string | Uint8Array;
  export type SQLOutputValue = null | number | bigint | string | Uint8Array;

  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export class StatementSync {
    run(...params: SQLInputValue[]): StatementResultingChanges;
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module "node:http" {
  export interface IncomingMessage extends AsyncIterable<Uint8Array> {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    destroy(): void;
  }

  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string | string[]): void;
    end(body?: string | Uint8Array): void;
    headersSent: boolean;
  }

  export interface AddressInfo {
    address: string;
    family: string;
    port: number;
  }

  export interface Server {
    listen(port: number, host: string, callback?: () => void): Server;
    close(callback?: (error?: Error) => void): Server;
    address(): AddressInfo | string | null;
    on(event: "error", listener: (error: Error) => void): Server;
  }

  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Server;
}

declare module "node:fs/promises" {
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function appendFile(path: string, data: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function normalize(path: string): string;
  export function extname(path: string): string;
  export const sep: string;
}

declare module "node:crypto" {
  interface Hmac {
    update(data: string): Hmac;
    digest(encoding: "base64url"): string;
  }
  export function createHmac(algorithm: "sha256", key: string): Hmac;
  export function randomBytes(size: number): { toString(encoding: "base64url" | "hex"): string };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options: { encoding: "utf8"; input?: string; stdio?: readonly ("pipe" | "ignore" | "inherit")[]; maxBuffer?: number; env?: Record<string, string | undefined> },
  ): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  stdout: { write(text: string): boolean };
  stderr: { write(text: string): boolean };
};

interface NodeBufferLike extends Uint8Array {
  toString(encoding?: "base64url" | "utf8" | "hex"): string;
}

declare const Buffer: {
  from(value: string, encoding?: "base64url" | "utf8"): NodeBufferLike;
};
