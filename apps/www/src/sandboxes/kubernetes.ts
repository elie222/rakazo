import { GITHUB_URL } from "../site";
import { PROVIDERS_DOC, RUNTIME_DOC, homepage } from "./shared";
import type { Sandbox } from "./types";

export const kubernetes: Sandbox = {
  slug: "kubernetes",
  name: "Kubernetes",
  runsOn: "Your own cluster, one pod per computer",
  keeps: "The workspace Rakazo saves, or a volume",
  bestFor: "Teams that already run Kubernetes",
  title: "AI agent sandboxes on Kubernetes: one pod per bot computer",
  description:
    "How Rakazo runs each AI agent's computer as a locked-down pod on your own Kubernetes cluster, with optional gVisor or Kata isolation. What bots can do, limits, RBAC and setup.",
  h1: "AI agent sandboxes on Kubernetes",
  intro: [
    "If your team already runs [Kubernetes](https://kubernetes.io), your AI agents' computers can run there too. Each computer becomes a pod in a namespace you choose, on your own nodes and network, scheduled and limited like any other workload.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each one gets its own computer with a desktop, browser, terminal and files that you can watch and take over. When you [host Rakazo yourself](/self-hosted-ai-agent/) on a cluster, it can create those computers as pods directly through the Kubernetes API, with no Docker socket and no outside sandbox provider.",
  ],
  scene: {
    bot: "Bug Triage",
    color: "#D9508A",
    where: "Computer on Kubernetes",
    ask: "triage last night's sentry reports and try to repro the worst one",
    reply: "on it. six new since midnight. reproducing the auth loop first.",
    task: "Reproducing the auth loop in a terminal.",
    screen: {
      host: "sentry.io",
      title: "Auth loop: P1",
      lines: ["6 new reports", "4 reproduced", "Stale session token"],
    },
  },
  sections: [
    {
      heading: "What is a Kubernetes sandbox?",
      paragraphs: [
        "Kubernetes runs containers across a cluster of machines and keeps them within the limits and rules you set. An AI agent sandbox on Kubernetes is a pod set aside for one agent's computer, kept apart from your other workloads by the cluster's own controls.",
        "Rakazo creates one plain pod per bot computer from its published computer image, the same Linux desktop it uses for Docker. The Rakazo API and worker talk to the Kubernetes API with their own service account, run commands and move files through `pods/exec`, and show the screen through a gateway inside the pod. That is why they normally run in the same cluster.",
      ],
      image: true,
    },
    {
      heading: "What a bot can do on a Kubernetes computer",
      paragraphs: [
        "From the chat it looks the same as any other Rakazo computer. The bot gets a desktop you can watch and take over, and it can:",
      ],
      bullets: [
        "Browse the web, sign in to sites and download files.",
        "Run commands in a terminal, clone repositories and run scripts.",
        "Read and write files in its workspace, which Rakazo saves when the computer stops and puts back when a new pod starts.",
        "Keep its home folder on a persistent volume instead, if you point Rakazo at the volume that holds its data.",
      ],
    },
    {
      heading: "When to choose Kubernetes",
      paragraphs: [
        "Choose Kubernetes when you already run Rakazo or other services on a cluster and want bot computers under the same scheduling, quotas and network policy. It is also the self-hosted way to get a VM-like boundary: set a runtime class such as gVisor or Kata and every computer pod uses it.",
        "If you have one server and no cluster, [Docker](/sandboxes/docker/) is simpler and is Rakazo's default. If you don't want to run the computers at all, a hosted sandbox such as [Boat](/sandboxes/boat/), which Rakazo Cloud uses, or [E2B](/sandboxes/e2b/) does it for you. The [sandbox comparison](/sandboxes/) covers every option.",
      ],
    },
    {
      heading: "Limits and security",
      paragraphs: [
        "Each pod runs as the image's own non-root user, with no service account token mounted, all Linux capabilities dropped, privilege escalation off and the `RuntimeDefault` seccomp profile. Those are the same protections Rakazo gives a Docker computer.",
      ],
      bullets: [
        "Without a runtime class, a pod shares its node's kernel like any container. Set `KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME` to gVisor or Kata for a stronger boundary, if your cluster has one installed.",
        "Rakazo doesn't create a NetworkPolicy. Add one that admits only the Rakazo API, worker and web pods to the computer pods and blocks their egress to private ranges.",
        "CPU and memory limits are unset unless you set them, so add limits or a namespace quota.",
        "Pods are disposable. Anything installed outside the workspace is gone when a pod is replaced, unless the home folder is on a volume.",
        "Rakazo creates plain pods. It does not use the Kubernetes [Agent Sandbox](https://agent-sandbox.sigs.k8s.io) custom resource.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "These steps are for the admin of a [self-hosted Rakazo](/self-hosted-ai-agent/) running on a cluster. Kubernetes is configured through the server's environment, not in the app's Settings. The [computer providers guide](/docs/self-host-sandbox-providers/) has every variable and a sample Role.",
      ],
      steps: [
        "Run the Rakazo API, worker and web app in your cluster from the published app image. Rakazo doesn't ship Kubernetes manifests, so you write your own deployments; the [self-hosting guide](/docs/self-host/) lists the services and the settings each one needs.",
        "Create a namespace for computers. The default name is `rakazo-sandboxes`.",
        "Give the API and worker's service account a Role in that namespace that can create, get and delete `pods` and create and get `pods/exec`, and bind it with a RoleBinding.",
        "Set `SANDBOX_PROVIDER=kubernetes` on the API and worker, plus `KUBERNETES_SANDBOX_NAMESPACE` if you chose another name. Pin `KUBERNETES_SANDBOX_COMPUTER_IMAGE` to a digest for production.",
        "Optionally set `KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME`, `KUBERNETES_SANDBOX_CPU_LIMIT` and `KUBERNETES_SANDBOX_MEMORY_LIMIT`, and add a NetworkPolicy.",
        "Make sure the API, worker and web pods can reach computer pods on port 6080 and the display ports from 6100 up, then open a bot's computer to check that the desktop comes up.",
      ],
    },
  ],
  image: homepage(
    "kubernetes",
    "Kubernetes",
    "The Kubernetes homepage, headed Production-Grade Container Orchestration.",
  ),
  faq: [
    {
      question: "Can I use gVisor or Kata Containers for AI agent sandboxes?",
      answer:
        "Yes, if your cluster has the runtime class installed. Set `KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME` and Rakazo puts it on every computer pod it creates.",
    },
    {
      question: "Does Rakazo use the Kubernetes Agent Sandbox project?",
      answer:
        "No. It creates ordinary pods with the Kubernetes API, so it needs no custom resources or extra controllers in your cluster.",
    },
    {
      question: "Do bots lose their files when a pod is deleted?",
      answer:
        "Not their workspace. Rakazo saves it when a computer stops and restores it into the next pod. Software installed elsewhere on the pod is lost unless you keep the home folder on a persistent volume.",
    },
    {
      question: "Can the Rakazo API run outside the cluster?",
      answer:
        "It can use a kubeconfig, but it also needs to reach each pod's IP for the screen, so in practice the API and worker run inside the cluster.",
    },
  ],
  sources: [
    { label: "Kubernetes", href: "https://kubernetes.io" },
    {
      label: "Kubernetes, runtime classes",
      href: "https://kubernetes.io/docs/concepts/containers/runtime-class/",
    },
    { label: "gVisor", href: "https://gvisor.dev" },
    { label: "Kata Containers", href: "https://katacontainers.io" },
    { label: "Kubernetes Agent Sandbox", href: "https://agent-sandbox.sigs.k8s.io" },
    PROVIDERS_DOC,
    RUNTIME_DOC,
    { label: "Rakazo, self-hosting", href: `${GITHUB_URL}/blob/main/docs/self-host.md` },
  ],
};
