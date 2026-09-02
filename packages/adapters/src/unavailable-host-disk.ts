import type {
  AdapterContext,
  ComputerFileEntry,
  HostDiskProvider,
  PortableFile,
} from "@rakazo/adapter-kit";

const UNAVAILABLE = "Host disk access is unavailable.";

/** Default provider: core runs without host-disk access. */
export class UnavailableHostDiskProvider implements HostDiskProvider {
  describe() {
    return {
      id: "unavailable-host-disk",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { list: false, read: false, write: false },
    };
  }

  async isAvailable(_userId: string): Promise<boolean> {
    return false;
  }

  async listFiles(
    _userId: string,
    _path: string,
    _context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    throw new Error(UNAVAILABLE);
  }

  async readFile(
    _userId: string,
    _path: string,
    _context: AdapterContext,
    _options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    throw new Error(UNAVAILABLE);
  }

  async writeFile(_userId: string, _file: PortableFile, _context: AdapterContext): Promise<void> {
    throw new Error(UNAVAILABLE);
  }
}
