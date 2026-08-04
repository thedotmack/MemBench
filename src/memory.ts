import { deepFreeze, type JsonValue } from "./canonical";
import { requireSafeIdentifier } from "./identifiers";
import { jsonData, RUNTIME_LIMITS, unicodeLength } from "./runtime-validation";

export interface MemoryRecord {
  readonly id: string;
  readonly text: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface MemoryBackend {
  create(record: MemoryRecord): Promise<MemoryRecord>;
  createBatch(records: readonly MemoryRecord[]): Promise<readonly MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | null>;
  list(): Promise<readonly MemoryRecord[]>;
  update(id: string, replacement: MemoryRecord): Promise<MemoryRecord>;
  delete(id: string): Promise<boolean>;
}

function schemaText(value: unknown, label: string, maximumCodePoints: number): string {
  if (typeof value !== "string" || unicodeLength(value) < 1 || unicodeLength(value) > maximumCodePoints ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) || !/[\p{L}\p{N}]/u.test(value)) {
    throw new TypeError(`${label} does not match the observation schema`);
  }
  return value;
}

function schemaMemoryId(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new TypeError("memory id does not match the observation schema");
  }
  return value;
}

function requireIJsonString(value: string, label: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} is not valid I-JSON text`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError(`${label} is not valid I-JSON text`);
  }
  return value;
}

/** Structural validator kept semantically equivalent to observation.schema.json. */
export function validateMemoryRecordSchema(value: unknown): MemoryRecord {
  const parsed = jsonData(value, "memory record");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("memory record must be an object");
  const source = parsed as Readonly<Record<string, JsonValue>>;
  if (Object.keys(source).length !== 3 || !Object.hasOwn(source, "id") || !Object.hasOwn(source, "text") || !Object.hasOwn(source, "metadata")) {
    throw new TypeError("memory record has invalid fields");
  }
  const id = schemaMemoryId(source.id);
  const text = schemaText(source.text, "memory text", 250_000);
  const metadataValue = source.metadata;
  if (metadataValue === null || typeof metadataValue !== "object" || Array.isArray(metadataValue)) throw new TypeError("memory metadata must be an object");
  if (Object.keys(metadataValue).length > 64) throw new RangeError("memory metadata has too many fields");
  const metadata = Object.fromEntries(Object.entries(metadataValue).map(([key, nested]) => {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || typeof nested !== "string") throw new TypeError("memory metadata is invalid");
    return [key, schemaText(nested, `memory metadata ${key}`, 2_000)];
  }));
  return deepFreeze({ id, text, metadata });
}

/** Runtime semantic layer: JSON Schema cannot express I-JSON scalar validity. */
export function validateMemoryRecord(value: unknown): MemoryRecord {
  const record = validateMemoryRecordSchema(value);
  requireIJsonString(record.text, "memory text");
  for (const [key, nested] of Object.entries(record.metadata)) requireIJsonString(nested, `memory metadata ${key}`);
  return record;
}

export function validateMemoryBatch(records: readonly MemoryRecord[]): readonly MemoryRecord[] {
  if (!Array.isArray(records) || records.length > 100 || records.length > RUNTIME_LIMITS.maximumMemoryRecords) {
    throw new RangeError("memory batch exceeds its bounded allocation");
  }
  const validated = records.map(validateMemoryRecord);
  if (new Set(validated.map((record) => record.id)).size !== validated.length) throw new Error("memory batch ids must be unique");
  return deepFreeze(validated);
}

export class InMemoryBackend implements MemoryBackend {
  readonly #records = new Map<string, MemoryRecord>();

  async create(record: MemoryRecord): Promise<MemoryRecord> {
    return (await this.createBatch([record]))[0] as MemoryRecord;
  }

  async createBatch(records: readonly MemoryRecord[]): Promise<readonly MemoryRecord[]> {
    const batch = validateMemoryBatch(records);
    if (batch.some((record) => this.#records.has(record.id))) throw new Error("memory record already exists");
    if (this.#records.size + batch.length > RUNTIME_LIMITS.maximumMemoryRecords) throw new RangeError("memory backend is full");
    for (const record of batch) this.#records.set(record.id, record);
    return batch;
  }

  async get(id: string): Promise<MemoryRecord | null> { return this.#records.get(requireSafeIdentifier(id, "memory id")) ?? null; }
  async list(): Promise<readonly MemoryRecord[]> { return deepFreeze([...this.#records.values()].sort((a, b) => a.id.localeCompare(b.id, "en-US"))); }

  async update(id: string, replacement: MemoryRecord): Promise<MemoryRecord> {
    const safeId = requireSafeIdentifier(id, "memory id");
    const record = validateMemoryRecord(replacement);
    if (record.id !== safeId) throw new Error("memory replacement id must match path id");
    if (!this.#records.has(safeId)) throw new Error("memory record does not exist");
    this.#records.set(safeId, record);
    return record;
  }

  async delete(id: string): Promise<boolean> { return this.#records.delete(requireSafeIdentifier(id, "memory id")); }
}

export type FetchTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpMemoryBackendOptions {
  readonly baseUrl: string;
  readonly fetch: FetchTransport;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly allowLoopbackHttp?: boolean;
}

function ipv4Parts(host: string): number[] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return null;
  const values = host.split(".").map(Number);
  return values.every((value) => value >= 0 && value <= 255) ? values : null;
}

function mappedIpv4Parts(host: string): number[] | null {
  const normalized = host.replace(/^\[|\]$/gu, "").toLowerCase();
  const match = normalized.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (!match) return null;
  const high = Number.parseInt(match[1] as string, 16);
  const low = Number.parseInt(match[2] as string, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
}

function isLoopback(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/gu, "").toLowerCase();
  const parts = ipv4Parts(normalized);
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1" || (parts?.[0] === 127);
}

function isForbiddenNetworkLiteral(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/gu, "").toLowerCase();
  if (normalized === "metadata.google.internal" || normalized.endsWith(".local")) return true;
  const parts = ipv4Parts(normalized) ?? mappedIpv4Parts(normalized);
  if (parts) {
    const [a, b] = parts as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }
  return normalized === "::" || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("fc") || normalized.startsWith("fd");
}

function validateBaseUrl(value: string, allowLoopbackHttp: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new TypeError("memory backend URL cannot contain credentials, query, or fragment");
  const loopback = isLoopback(url.hostname);
  if (isForbiddenNetworkLiteral(url.hostname) && !(loopback && allowLoopbackHttp)) throw new TypeError("memory backend URL targets a forbidden network range");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && allowLoopbackHttp)) {
    throw new TypeError("memory backend URL requires HTTPS; loopback HTTP requires explicit opt-in");
  }
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/`;
  return url;
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > RUNTIME_LIMITS.maximumResponseBytes)) {
    throw new RangeError("memory HTTP response length is invalid or too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const aborted = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("memory HTTP operation timed out")), { once: true }));
  while (true) {
    const result = await Promise.race([reader.read(), aborted]).catch(async (error) => { await reader.cancel(); throw error; });
    if (result.done) break;
    total += result.value.byteLength;
    if (total > RUNTIME_LIMITS.maximumResponseBytes) { await reader.cancel(); throw new RangeError("memory HTTP response is too large"); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (length !== null && Number(length) !== total) throw new Error("memory HTTP response length does not match its body");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("memory HTTP response is not valid UTF-8"); }
}

export class HttpMemoryBackend implements MemoryBackend {
  readonly #baseUrl: URL;
  readonly #fetch: FetchTransport;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;

  constructor(options: HttpMemoryBackendOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl, options.allowLoopbackHttp === true);
    this.#fetch = options.fetch;
    this.#headers = deepFreeze({ ...options.headers });
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 60_000) throw new TypeError("memory HTTP timeout is invalid");
  }

  async #request(method: string, path: string, statuses: readonly number[], body?: JsonValue): Promise<{ readonly status: number; readonly value: unknown }> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded !== undefined && Buffer.byteLength(encoded) > RUNTIME_LIMITS.maximumResponseBytes) throw new RangeError("memory HTTP request is too large");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("memory HTTP operation timed out")), { once: true });
      });
      response = await Promise.race([this.#fetch(new URL(path, this.#baseUrl), {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json", ...(encoded === undefined ? {} : { "content-type": "application/json" }), ...this.#headers },
        ...(encoded === undefined ? {} : { body: encoded }),
      }), aborted]);
    } catch {
      clearTimeout(timer);
      throw new Error(controller.signal.aborted ? "memory HTTP operation timed out" : "memory HTTP transport failed");
    }
    if (!statuses.includes(response.status)) { clearTimeout(timer); throw new Error(`memory HTTP operation failed with status ${response.status}`); }
    let text: string;
    try { text = await boundedResponseText(response, controller.signal); } finally { clearTimeout(timer); }
    if (text === "") return { status: response.status, value: null };
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new Error("memory HTTP response content type is invalid");
    try { return { status: response.status, value: JSON.parse(text) as unknown }; } catch { throw new Error("memory HTTP response is not valid JSON"); }
  }

  async create(record: MemoryRecord): Promise<MemoryRecord> {
    const validated = validateMemoryRecord(record);
    return validateMemoryRecord((await this.#request("POST", "records", [200, 201], validated as unknown as JsonValue)).value);
  }

  async createBatch(records: readonly MemoryRecord[]): Promise<readonly MemoryRecord[]> {
    const batch = validateMemoryBatch(records);
    const value = (await this.#request("POST", "records/batch", [200, 201], { records: batch } as unknown as JsonValue)).value;
    if (!Array.isArray(value) || value.length !== batch.length) throw new TypeError("memory batch response is invalid");
    const returned = validateMemoryBatch(value as MemoryRecord[]);
    if (returned.some((record, index) => record.id !== batch[index]?.id)) throw new Error("memory batch response changed record identity");
    return returned;
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const safeId = requireSafeIdentifier(id, "memory id");
    const response = await this.#request("GET", `records/${encodeURIComponent(safeId)}`, [200, 404]);
    return response.status === 404 ? null : validateMemoryRecord(response.value);
  }

  async list(): Promise<readonly MemoryRecord[]> {
    const value = (await this.#request("GET", "records", [200])).value;
    if (!Array.isArray(value) || value.length > RUNTIME_LIMITS.maximumMemoryRecords) throw new TypeError("memory list response is invalid");
    const records = value.map(validateMemoryRecord);
    if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error("memory list contains duplicate ids");
    return deepFreeze(records.sort((a, b) => a.id.localeCompare(b.id, "en-US")));
  }

  async update(id: string, replacement: MemoryRecord): Promise<MemoryRecord> {
    const safeId = requireSafeIdentifier(id, "memory id");
    const record = validateMemoryRecord(replacement);
    if (record.id !== safeId) throw new Error("memory replacement id must match path id");
    return validateMemoryRecord((await this.#request("PUT", `records/${encodeURIComponent(safeId)}`, [200], record as unknown as JsonValue)).value);
  }

  async delete(id: string): Promise<boolean> {
    const value = (await this.#request("DELETE", `records/${encodeURIComponent(requireSafeIdentifier(id, "memory id"))}`, [200, 204])).value;
    if (value === null) return true;
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || (value as Record<string, unknown>).deleted !== true) {
      throw new TypeError("memory delete response is invalid");
    }
    return true;
  }
}
