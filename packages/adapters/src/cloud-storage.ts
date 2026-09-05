import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  AdapterContext,
  AgentHomeStore,
  ArtifactPut,
  ArtifactStore,
  PortableFile,
} from "@rakazo/adapter-kit";
import { LocalArtifactStore } from "./artifacts.js";
import { LocalAgentHomeStore } from "./home.js";

export interface CloudObjects {
  get(key: string): Promise<{ bytes: Uint8Array; etag: string } | null>;
  put(
    key: string,
    bytes: Uint8Array,
    condition?: { etag?: string; absent?: boolean },
  ): Promise<void>;
  remove(key: string): Promise<void>;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_HOME_BYTES = 512 * 1024 * 1024;
const MAX_HOME_FILES = 10_000;
const encoder = new TextEncoder();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function segment(value: string): string {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    [...value].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error("Invalid storage identifier");
  return encodeURIComponent(value);
}

export function cloudHomePath(value: string): string {
  if (
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    [...value].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error("Invalid home path");
  if (value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Invalid home path");
  return value;
}

export class R2Objects implements CloudObjects {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}
  async get(key: string) {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body || !response.ETag)
        throw new Error("Object storage returned an incomplete response");
      if ((response.ContentLength ?? 0) > MAX_FILE_BYTES)
        throw new Error("Stored file exceeds size limit");
      const bytes = await response.Body.transformToByteArray();
      if (bytes.length > MAX_FILE_BYTES) throw new Error("Stored file exceeds size limit");
      return { bytes, etag: response.ETag };
    } catch (error) {
      if (error instanceof Error && (error.name === "NoSuchKey" || error.name === "NotFound"))
        return null;
      throw error;
    }
  }
  async put(key: string, bytes: Uint8Array, condition?: { etag?: string; absent?: boolean }) {
    if (bytes.length > MAX_FILE_BYTES) throw new Error("File exceeds size limit");
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: "application/octet-stream",
        ...(condition?.etag ? { IfMatch: condition.etag } : {}),
        ...(condition?.absent ? { IfNoneMatch: "*" } : {}),
      }),
    );
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Uses an R2-bound Worker so API/worker services need no Cloudflare account credentials. */
export class GatewayObjects implements CloudObjects {
  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      token.length < 32
    )
      throw new Error("Invalid storage gateway configuration");
  }
  private async request(
    key: string,
    method: string,
    bytes?: Uint8Array,
    condition?: { etag?: string; absent?: boolean },
  ) {
    const url = new URL("/objects", this.origin);
    url.searchParams.set("key", key);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(bytes ? { "content-length": String(bytes.length) } : {}),
        ...(condition?.etag ? { "if-match": condition.etag } : {}),
        ...(condition?.absent ? { "if-none-match": "*" } : {}),
      },
      ...(bytes ? { body: Buffer.from(bytes) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    if (response.status === 412) {
      const error = new Error("Object changed concurrently");
      error.name = "PreconditionFailed";
      throw error;
    }
    if (response.status !== 404 && !response.ok)
      throw new Error(`Storage gateway failed (${response.status})`);
    return response;
  }
  async get(key: string) {
    const response = await this.request(key, "GET");
    if (response.status === 404) return null;
    if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES)
      throw new Error("Object exceeds size limit");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const etag = response.headers.get("etag");
    if (!etag || bytes.length > MAX_FILE_BYTES) throw new Error("Invalid object response");
    return { bytes, etag };
  }
  async put(key: string, bytes: Uint8Array, condition?: { etag?: string; absent?: boolean }) {
    if (bytes.length > MAX_FILE_BYTES) throw new Error("File exceeds size limit");
    await this.request(key, "PUT", bytes, condition);
  }
  async remove(key: string) {
    await this.request(key, "DELETE");
  }
}

export class CloudArtifactStore implements ArtifactStore {
  constructor(private readonly objects: CloudObjects) {}
  describe() {
    return {
      id: "r2-artifacts",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { stream: false },
    };
  }
  private key(id: string, context: AdapterContext) {
    return `spaces/${segment(context.spaceId)}/artifacts/${segment(id)}`;
  }
  async put(artifact: ArtifactPut, context: AdapterContext) {
    const id = randomUUID();
    await this.objects.put(this.key(id, context), artifact.bytes, { absent: true });
    return { id, hash: digest(artifact.bytes) };
  }
  async get(id: string, context: AdapterContext) {
    const value = await this.objects.get(this.key(id, context));
    if (!value) throw new Error("Artifact not found");
    return value.bytes;
  }
  async remove(id: string, context: AdapterContext) {
    await this.objects.remove(this.key(id, context));
  }
}

type Entry = { hash: string; size: number; executable: boolean };
type Manifest = { version: 1; revision: string; files: Record<string, Entry> };

/** Immutable content and revision manifests; a conditional pointer publishes each snapshot atomically. */
export class CloudAgentHomeStore implements AgentHomeStore {
  constructor(private readonly objects: CloudObjects) {}
  describe() {
    return {
      id: "r2-homes",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { revisions: true },
    };
  }
  private prefix(botId: string, context: AdapterContext) {
    return `spaces/${segment(context.spaceId)}/homes/${segment(botId)}`;
  }
  private parse(bytes: Uint8Array): Manifest {
    const m = JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
    if (
      !m ||
      typeof m !== "object" ||
      m.version !== 1 ||
      typeof m.revision !== "string" ||
      !m.files ||
      Object.keys(m.files).length > MAX_HOME_FILES
    )
      throw new Error("Invalid home manifest");
    let total = 0;
    for (const [name, entry] of Object.entries(m.files)) {
      cloudHomePath(name);
      if (
        !entry ||
        typeof entry.executable !== "boolean" ||
        !/^[a-f0-9]{64}$/.test(entry.hash) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > MAX_FILE_BYTES
      )
        throw new Error("Invalid home entry");
      total += entry.size;
    }
    if (total > MAX_HOME_BYTES) throw new Error("Home exceeds size limit");
    return m;
  }
  private async current(prefix: string) {
    const value = await this.objects.get(`${prefix}/current.json`);
    return {
      manifest: value
        ? this.parse(value.bytes)
        : { version: 1 as const, revision: "empty", files: {} as Record<string, Entry> },
      etag: value?.etag,
    };
  }
  private async publish(prefix: string, files: Record<string, Entry>, etag?: string) {
    const manifest: Manifest = { version: 1, revision: randomUUID(), files };
    const bytes = encoder.encode(JSON.stringify(manifest));
    this.parse(bytes);
    await this.objects.put(`${prefix}/revisions/${manifest.revision}.json`, bytes, {
      absent: true,
    });
    await this.objects.put(`${prefix}/current.json`, bytes, etag ? { etag } : { absent: true });
    return manifest.revision;
  }
  private async content(prefix: string, entry: Entry) {
    const value = await this.objects.get(`${prefix}/blobs/${entry.hash}`);
    if (!value || value.bytes.length !== entry.size || digest(value.bytes) !== entry.hash)
      throw new Error("Home content integrity check failed");
    return value.bytes;
  }
  async checkout(botId: string, dest: string, context: AdapterContext) {
    const prefix = this.prefix(botId, context);
    const { manifest } = await this.current(prefix);
    await this.materialize(prefix, manifest, dest);
    return manifest.revision;
  }
  private async materialize(prefix: string, manifest: Manifest, dest: string) {
    await mkdir(dest, { recursive: true });
    const root = await realpath(dest);
    for (const [name, entry] of Object.entries(manifest.files)) {
      const parts = cloudHomePath(name).split("/");
      let directory = root;
      for (const part of parts.slice(0, -1)) {
        const next = path.join(directory, part);
        await mkdir(next, { recursive: true });
        directory = await realpath(next);
        if (directory !== root && !directory.startsWith(`${root}${path.sep}`))
          throw new Error("Home path escapes checkout");
      }
      const handle = await open(
        path.join(directory, parts.at(-1)!),
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        entry.executable ? 0o700 : 0o600,
      );
      try {
        await handle.writeFile(await this.content(prefix, entry));
        await handle.chmod(entry.executable ? 0o700 : 0o600);
      } finally {
        await handle.close();
      }
    }
  }

  async commit(botId: string, src: string, context: AdapterContext) {
    const prefix = this.prefix(botId, context);
    const { etag, manifest } = await this.current(prefix);
    const known = new Set(Object.values(manifest.files).map((entry) => entry.hash));
    let batch: Array<{ hash: string; content: Buffer }> = [];
    let batchBytes = 0;
    const flush = async () => {
      const results = await Promise.allSettled(
        batch.map((item) => this.objects.put(`${prefix}/blobs/${item.hash}`, item.content)),
      );
      batch = [];
      batchBytes = 0;
      for (const result of results) if (result.status === "rejected") throw result.reason;
    };
    const files: Record<string, Entry> = Object.create(null);
    let bytes = 0;
    const walk = async (dir: string, relative = "") => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue;
        const name = cloudHomePath(relative ? `${relative}/${item.name}` : item.name);
        if (item.isDirectory()) await walk(path.join(dir, item.name), name);
        else if (item.isFile()) {
          const handle = await open(
            path.join(dir, item.name),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          let content: Buffer;
          let executable: boolean;
          try {
            const info = await handle.stat();
            if (info.size > MAX_FILE_BYTES) throw new Error("Home file exceeds size limit");
            executable = Boolean(info.mode & 0o100);
            content = await handle.readFile();
          } finally {
            await handle.close();
          }
          bytes += content.length;
          if (
            content.length > MAX_FILE_BYTES ||
            bytes > MAX_HOME_BYTES ||
            Object.keys(files).length >= MAX_HOME_FILES
          )
            throw new Error("Home exceeds storage limits");
          const hash = digest(content);
          if (!known.has(hash)) {
            if (batch.length && batchBytes + content.length > 8 * 1024 * 1024) await flush();
            batch.push({ hash, content });
            batchBytes += content.length;
            known.add(hash);
            if (batch.length >= 8 || batchBytes >= 8 * 1024 * 1024) await flush();
          }
          files[name] = { hash, size: content.length, executable };
        }
      }
    };
    await walk(src);
    await flush();
    return this.publish(prefix, files, etag);
  }
  async restore(botId: string, revision: string, dest: string, context: AdapterContext) {
    const prefix = this.prefix(botId, context);
    const value = await this.objects.get(`${prefix}/revisions/${segment(revision)}.json`);
    if (!value) throw new Error("Home revision not found");
    await this.materialize(prefix, this.parse(value.bytes), dest);
  }
  async *exportHome(botId: string, context: AdapterContext): AsyncIterable<PortableFile> {
    const prefix = this.prefix(botId, context);
    const { manifest } = await this.current(prefix);
    for (const [name, entry] of Object.entries(manifest.files))
      yield {
        path: name,
        content: await this.content(prefix, entry),
        executable: entry.executable,
      };
  }
  async readFile(
    botId: string,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const prefix = this.prefix(botId, context);
    const { manifest } = await this.current(prefix);
    const entry = manifest.files[cloudHomePath(filePath)];
    if (!entry) throw new Error("Home file not found");
    if (entry.size > (options?.maxBytes ?? MAX_FILE_BYTES))
      throw new Error("Home file exceeds size limit");
    return new TextDecoder().decode(await this.content(prefix, entry));
  }
  async writeFile(botId: string, filePath: string, content: string, context: AdapterContext) {
    const prefix = this.prefix(botId, context);
    const name = cloudHomePath(filePath);
    const bytes = encoder.encode(content);
    if (bytes.length > MAX_FILE_BYTES) throw new Error("Home file exceeds size limit");
    const hash = digest(bytes);
    await this.objects.put(`${prefix}/blobs/${hash}`, bytes);
    for (let attempt = 0; attempt < 4; attempt++) {
      const { manifest, etag } = await this.current(prefix);
      try {
        await this.publish(
          prefix,
          { ...manifest.files, [name]: { hash, size: bytes.length, executable: false } },
          etag,
        );
        return;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "PreconditionFailed" || attempt === 3)
          throw error;
      }
    }
  }
  async list(botId: string, directory: string, context: AdapterContext) {
    const dir =
      directory === "" || directory === "."
        ? ""
        : `${cloudHomePath(directory.replace(/\/$/, ""))}/`;
    const { manifest } = await this.current(this.prefix(botId, context));
    const rows = new Map<string, { path: string; kind: "file" | "dir"; size: number }>();
    for (const [name, entry] of Object.entries(manifest.files)) {
      if (!name.startsWith(dir)) continue;
      const rest = name.slice(dir.length);
      const child = rest.split("/")[0]!;
      rows.set(`${dir}${child}`, {
        path: `${dir}${child}`,
        kind: rest.includes("/") ? "dir" : "file",
        size: rest.includes("/") ? 0 : entry.size,
      });
    }
    return [...rows.values()];
  }
}

export function createDurableStorage(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.STORAGE_PROVIDER === "r2-gateway") {
    const objects = new GatewayObjects(env.R2_GATEWAY_URL ?? "", env.STORAGE_GATEWAY_TOKEN ?? "");
    return { home: new CloudAgentHomeStore(objects), artifacts: new CloudArtifactStore(objects) };
  }
  if (env.STORAGE_PROVIDER !== "r2")
    return { home: new LocalAgentHomeStore(dataDir), artifacts: new LocalArtifactStore(dataDir) };
  for (const name of [
    "R2_ENDPOINT",
    "R2_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ] as const)
    if (!env[name]?.trim()) throw new Error(`${name} is required for cloud storage`);
  const endpoint = new URL(env.R2_ENDPOINT!);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw new Error("R2_ENDPOINT must be HTTPS without credentials");
  const objects = new R2Objects(
    new S3Client({
      region: "auto",
      endpoint: endpoint.href,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
    env.R2_BUCKET!,
  );
  return { home: new CloudAgentHomeStore(objects), artifacts: new CloudArtifactStore(objects) };
}
