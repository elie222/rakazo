import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { dirname } from "node:path";
import type { IngressProvider, IngressStatus } from "@rakazo/adapter-kit";
import { z } from "zod";

export type TailscaleIngressOptions = {
  /** The ingress node's own name, never the app's: it lands in public certificate logs. */
  hostname: string;
  /** The tailnet's DNS name, such as `tail1234.ts.net`. */
  tailnet: string;
  /** The serve config file the node's container applies whenever it changes. */
  serveConfigPath: string;
  /** The node's local API socket, read only for its status. */
  socketPath: string;
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TAILNET = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
// biome-ignore lint/suspicious/noTemplateCurlyInString: the node's container fills in its own name.
const CERT_DOMAIN = "${TS_CERT_DOMAIN}";

const statusSchema = z.object({
  BackendState: z.string(),
  Self: z
    .object({
      DNSName: z.string().optional(),
      CapMap: z.record(z.string(), z.unknown()).nullish(),
    })
    .nullish(),
});

/** Publishes the inbound listener through Funnel on a separate node, so the app's own name stays private. */
export class TailscaleIngressProvider implements IngressProvider {
  readonly publicOrigin: string;

  constructor(private readonly options: TailscaleIngressOptions) {
    if (!LABEL.test(options.hostname))
      throw new Error("The ingress node name must be one DNS label");
    if (!TAILNET.test(options.tailnet)) throw new Error("The tailnet DNS name is not valid");
    this.publicOrigin = `https://${options.hostname}.${options.tailnet}`;
  }

  describe() {
    return { id: "tailscale", label: "Tailscale Funnel", canUnpublish: true };
  }

  async publish(upstream: string): Promise<void> {
    const target = URL.parse(upstream);
    if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) {
      throw new Error("The inbound listener address must be an http or https URL");
    }
    const host = `${CERT_DOMAIN}:443`;
    await this.writeServeConfig({
      TCP: { "443": { HTTPS: true } },
      Web: { [host]: { Handlers: { "/": { Proxy: target.origin } } } },
      AllowFunnel: { [host]: true },
    });
  }

  async unpublish(): Promise<void> {
    await this.writeServeConfig({});
  }

  async status(signal: AbortSignal): Promise<IngressStatus> {
    const parsed = statusSchema.safeParse(
      await localApiGet(this.options.socketPath, "/localapi/v0/status", signal),
    );
    if (!parsed.success) return { published: false, reason: "The node's status was unreadable" };
    const { BackendState, Self } = parsed.data;
    if (BackendState !== "Running") {
      return { published: false, reason: `The node is ${BackendState}, not running` };
    }
    const expected = `${this.options.hostname}.${this.options.tailnet}.`;
    if (Self?.DNSName !== expected) {
      return {
        published: false,
        reason: `The node is named ${Self?.DNSName ?? "nothing"}, not ${expected}`,
      };
    }
    if (Self.CapMap && !("funnel" in Self.CapMap)) {
      return { published: false, reason: "The tailnet policy does not allow Funnel on this node" };
    }
    if (!(await this.serving())) {
      return { published: false, reason: "The serve config forwards nothing" };
    }
    return { published: true };
  }

  private async serving(): Promise<boolean> {
    const config: unknown = JSON.parse(await readFile(this.options.serveConfigPath, "utf8"));
    return Boolean(
      config && typeof config === "object" && "AllowFunnel" in config && config.AllowFunnel,
    );
  }

  private async writeServeConfig(config: object) {
    const path = this.options.serveConfigPath;
    await mkdir(dirname(path), { recursive: true });
    // Renamed into place, so the node never applies a half-written file.
    const partial = `${path}.${process.pid}.tmp`;
    await writeFile(partial, `${JSON.stringify(config, null, 2)}\n`);
    await rename(partial, path);
  }
}

function localApiGet(socketPath: string, path: string, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path, signal, headers: { Host: "local-tailscaled.sock" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error(`The node's local API answered ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}
