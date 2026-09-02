import path from "node:path";
import type {
  AdapterContext,
  ComputerFileEntry,
  HostDiskProvider,
  PortableFile,
} from "@rakazo/adapter-kit";
import {
  listInsideHostRoots,
  readFileInsideHostRoots,
  writeFileInsideHostRoots,
} from "./host-disk-path.js";
import {
  type HostDiskSettings,
  hostDiskAccessAllowed,
  loadHostDiskSettings,
} from "./host-disk-settings.js";

export type LocalHostDiskOptions = {
  dataDir: string;
  /** Override settings lookup (tests). */
  loadSettings?: (userId: string) => Promise<HostDiskSettings>;
  /** When true, skip the client heartbeat check (local same-process tests). */
  ignoreClientHeartbeat?: boolean;
};

/**
 * Reads and writes the machine that runs this process, limited to granted roots.
 * Used in tests and when the API/worker share the user's host filesystem.
 * Never invents Documents/Desktop roots; the user must grant folders explicitly.
 */
export class LocalHostDiskProvider implements HostDiskProvider {
  constructor(private readonly options: LocalHostDiskOptions) {}

  describe() {
    return {
      id: "local-host-disk",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { list: true, read: true, write: true },
    };
  }

  async isAvailable(userId: string): Promise<boolean> {
    const settings = await this.settingsFor(userId);
    if (this.options.ignoreClientHeartbeat) {
      return settings.enabled && settings.roots.length > 0;
    }
    return hostDiskAccessAllowed(settings);
  }

  async listFiles(
    userId: string,
    requestPath: string,
    _context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const roots = await this.requireRoots(userId);
    const trimmed = requestPath.trim();
    if (!trimmed) {
      return roots.map((root) => ({
        path: root,
        kind: "dir" as const,
        size: 0,
      }));
    }
    return listInsideHostRoots(trimmed, roots);
  }

  async readFile(
    userId: string,
    requestPath: string,
    _context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const roots = await this.requireRoots(userId);
    return readFileInsideHostRoots(requestPath, roots, options);
  }

  async writeFile(userId: string, file: PortableFile, _context: AdapterContext): Promise<void> {
    const roots = await this.requireRoots(userId);
    await writeFileInsideHostRoots(file.path, roots, file.content);
  }

  private async settingsFor(userId: string) {
    if (this.options.loadSettings) return this.options.loadSettings(userId);
    return loadHostDiskSettings(this.options.dataDir, userId);
  }

  private async requireRoots(userId: string) {
    const settings = await this.settingsFor(userId);
    const allowed = this.options.ignoreClientHeartbeat
      ? settings.enabled && settings.roots.length > 0
      : hostDiskAccessAllowed(settings);
    if (!allowed) {
      throw new Error(
        "Host disk access is off. Opt in from the Mac or phone app and grant a folder.",
      );
    }
    return settings.roots.map((root) => path.resolve(root));
  }
}
