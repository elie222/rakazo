import { DEFAULT_COMPUTER_SCREEN } from "@rakazo/core";
import type { ComputerProviderDefinition } from "../../../computer-provider-descriptor.js";
import { optional, positiveInteger, stringMap } from "../../../computer-provider-descriptor.js";

export const kubernetesComputer: ComputerProviderDefinition = {
  capabilities: {
    terminal: true,
    inPlaceUpdate: true,
    nativeShell: false,
    runsOnUserMachine: false,
    screen: DEFAULT_COMPUTER_SCREEN,
    serverHomeMount: "optional",
    serverOwnsStoredTeamHome: true,
    storedHomeIsBackup: false,
  },
  env: {
    kubernetesNamespace: { name: "KUBERNETES_SANDBOX_NAMESPACE" },
    kubernetesRuntimeClassName: { name: "KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME" },
    kubernetesComputerImage: { name: "KUBERNETES_SANDBOX_COMPUTER_IMAGE" },
    kubernetesCpuLimit: { name: "KUBERNETES_SANDBOX_CPU_LIMIT" },
    kubernetesMemoryLimit: { name: "KUBERNETES_SANDBOX_MEMORY_LIMIT" },
    kubernetesPodAnnotations: stringMap("KUBERNETES_SANDBOX_POD_ANNOTATIONS"),
    kubernetesPodLabels: stringMap("KUBERNETES_SANDBOX_POD_LABELS"),
    kubernetesReadyTimeoutMs: positiveInteger("KUBERNETES_SANDBOX_READY_TIMEOUT_MS"),
    kubernetesHomeClaim: {
      name: "KUBERNETES_SANDBOX_HOME_CLAIM",
      read: (value, source) =>
        optional(source.OBJECT_STORAGE_BUCKET) ? undefined : optional(value),
    },
    kubernetesHomeColocateNamespace: { name: "KUBERNETES_SANDBOX_HOME_COLOCATE_NAMESPACE" },
    kubernetesHomeColocateLabels: stringMap("KUBERNETES_SANDBOX_HOME_COLOCATE_LABELS"),
  },
  async create(opts) {
    const { KubernetesSandboxProvider } = await import("./kubernetes-sandbox.js");
    return new KubernetesSandboxProvider({
      namespace: opts.kubernetesNamespace,
      runtimeClassName: opts.kubernetesRuntimeClassName,
      computerImage: opts.kubernetesComputerImage,
      cpuLimit: opts.kubernetesCpuLimit,
      memoryLimit: opts.kubernetesMemoryLimit,
      podAnnotations: opts.kubernetesPodAnnotations,
      podLabels: opts.kubernetesPodLabels,
      readyTimeoutMs: opts.kubernetesReadyTimeoutMs,
      homeClaim: opts.kubernetesHomeClaim,
      homeColocateNamespace: opts.kubernetesHomeColocateNamespace,
      homeColocateLabels: opts.kubernetesHomeColocateLabels,
    });
  },
};
