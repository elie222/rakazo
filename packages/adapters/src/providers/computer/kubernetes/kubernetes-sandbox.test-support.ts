import type { Exec, V1Pod } from "@kubernetes/client-node";
import { vi } from "vitest";
import { execComputerShell } from "../../../computers/sandbox/exec-computer.test-support.js";
import type { KubernetesSandboxSdk } from "./kubernetes-sandbox.js";
import { KubernetesSandboxProvider } from "./kubernetes-sandbox.js";

export const readyPod: V1Pod = {
  metadata: { name: "pod", labels: { "rakazo-bot-id": "bot-a" } },
  status: {
    phase: "Running",
    podIP: "10.0.0.8",
    conditions: [{ type: "Ready", status: "True" }],
  },
};

export function providerFor(
  core: Partial<KubernetesSandboxSdk["core"]> = {},
  exec: KubernetesSandboxSdk["exec"]["exec"] = vi.fn(),
  options: ConstructorParameters<typeof KubernetesSandboxProvider>[0] = {},
) {
  return new KubernetesSandboxProvider(options, {
    core: {
      readNamespacedPod: vi.fn().mockResolvedValue(readyPod),
      createNamespacedPod: vi.fn().mockResolvedValue(readyPod),
      deleteNamespacedPod: vi.fn().mockResolvedValue({ status: "Success" }),
      ...core,
    },
    exec: { exec },
  } as unknown as KubernetesSandboxSdk);
}

/** The real Kubernetes adapter over a ready pod, running commands in the shared exec shell. */
export function emulatedKubernetes() {
  const shell = execComputerShell();
  const exec = vi.fn(async (...args: Parameters<Exec["exec"]>) => {
    const command = args[3];
    if (!Array.isArray(command)) throw new Error("expected argv");
    const [, , , , stdout, stderr, stdin] = args;
    const answer = (input?: Buffer) => {
      const { stdout: out, stderr: err, code = 0 } = shell.run(command, input);
      if (out?.length) stdout?.write(out);
      if (err?.length) stderr?.write(err);
      args[8]?.({
        status: code === 0 ? "Success" : "Failure",
        details: { causes: [{ reason: "ExitCode", message: String(code) }] },
      });
    };
    if (stdin) {
      const chunks: Buffer[] = [];
      stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stdin.on("end", () => answer(Buffer.concat(chunks)));
    } else queueMicrotask(() => answer());
    return { close: vi.fn(), onclose: null, onerror: null } as unknown as Awaited<
      ReturnType<Exec["exec"]>
    >;
  });
  const pods = new Map<string, V1Pod>();
  const missing = () => Object.assign(new Error("pod not found"), { code: 404 });
  const core = {
    readNamespacedPod: vi.fn(async ({ name }: { name: string }) => {
      const pod = pods.get(name);
      if (!pod) throw missing();
      return pod;
    }),
    createNamespacedPod: vi.fn(async ({ body }: { body: V1Pod }) => {
      const pod = { ...readyPod, metadata: body.metadata };
      pods.set(body.metadata!.name!, pod);
      return pod;
    }),
    deleteNamespacedPod: vi.fn(async ({ name }: { name: string }) => {
      const pod = pods.get(name);
      if (!pod) throw missing();
      pods.delete(name);
      return pod;
    }),
  };
  return { pods, provider: providerFor(core, exec) };
}
