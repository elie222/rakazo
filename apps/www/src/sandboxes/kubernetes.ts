import { GITHUB_URL } from "../site";
import {
  E2B_PRO_FEE,
  KUBERNETES_NODE_FITS,
  MONTH_HOURS,
  PRICES_NOTE,
  PRICING,
  PROVIDERS_DOC,
  RATES,
  RUNTIME_DOC,
  SERVERS,
  WORKDAY_HOURS,
  aboutUsd,
  euro,
  homepage,
  monthly,
} from "./shared";
import type { Sandbox } from "./types";

const FITS_WORD = ["no", "one", "two", "three", "four", "five"][KUBERNETES_NODE_FITS] ?? String(KUBERNETES_NODE_FITS);
const CONTROL_PLANE = `about $${Math.round(SERVERS.controlPlane)}`;

export const kubernetes: Sandbox = {
  slug: "kubernetes",
  name: "Kubernetes",
  runsOn: "Your own cluster, one pod per computer",
  keeps: "The workspace Rakazo saves, or a volume",
  bestFor: "Teams that already run Kubernetes",
  title: "Kubernetes agent sandbox: run AI agents' computers as pods on your own cluster",
  description:
    "How Rakazo runs each AI agent's computer as a locked-down pod on your own Kubernetes cluster, with optional gVisor or Kata isolation. Cluster cost per month, how it relates to the Kubernetes Agent Sandbox project, limits, RBAC and setup.",
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
    computer: {
      task: "Reproducing the auth loop in a terminal.",
      screen: {
        host: "sentry.io",
        title: "Auth loop: P1",
        lines: ["6 new reports", "4 reproduced", "Stale session token"],
      },
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
      heading: "What Kubernetes computers cost",
      paragraphs: [
        "Rakazo and Kubernetes are free, so you pay for the nodes the pods run on and, on some clouds, a fee for the cluster's control plane. Like a server, a node costs the same whether bots are busy or not.",
        `Rakazo sets no CPU or memory limits unless you do. For a desktop and Chromium, 2 CPU and 4Gi per pod is a sensible start. Rakazo sets only limits, and Kubernetes then reserves the full limit for every pod, so an 8 vCPU / 16 GB node fits about ${FITS_WORD} computers once the node's own system pods have their share.`,
      ],
      table: {
        caption: "A small cluster for bot computers, per month",
        columns: ["Where", "Control plane", "One 8 vCPU node", "Notes"],
        rows: [
          { topic: "DigitalOcean Kubernetes", cells: ["Free, or $40 for high availability", `$${SERVERS.digitalOcean16} for 16 GB`, "Simplest managed option at this size"] },
          { topic: "Google Kubernetes Engine", cells: [`$0.10 an hour, ${CONTROL_PLANE}. A monthly free credit covers one zonal cluster`, "Varies by machine type", "GKE Sandbox gives you gVisor with no extra fee"] },
          { topic: "Amazon EKS", cells: [`$0.10 an hour, ${CONTROL_PLANE}. $0.60 an hour on extended support`, `About $${SERVERS.awsM7i2xlarge} for an m7i.2xlarge with 32 GB`, "m7i and similar types support nested virtualization, so Kata works"] },
          { topic: "Azure AKS", cells: ["Free tier without an SLA, or a paid tier", "Varies by VM size", "Microsoft suggests the free tier only up to 10 nodes"] },
          { topic: "k3s on Hetzner", cells: ["Free, you run it", `${euro(SERVERS.hetznerCx43)} for a CX43 with 16 GB`, "Kata needs nested virtualization, which Hetzner doesn't offer on cloud VMs; its dedicated servers work"] },
        ],
        note: `${PRICES_NOTE} Hetzner prices exclude VAT. AWS price for us-east-1 on demand.`,
      },
      bullets: [
        `${FITS_WORD.charAt(0).toUpperCase() + FITS_WORD.slice(1)} always-available computers on one DigitalOcean node cost $${SERVERS.digitalOcean16} a month. The same ${FITS_WORD} on [E2B](/sandboxes/e2b/) for 4 hours a workday would be ${aboutUsd(KUBERNETES_NODE_FITS * monthly(RATES.e2b, WORKDAY_HOURS))}, and around the clock ${aboutUsd(KUBERNETES_NODE_FITS * monthly(RATES.e2b, MONTH_HOURS) + E2B_PRO_FEE)} with the Pro plan. Kubernetes pays off when computers are busy most of the day or you already have spare capacity.`,
        "Kata adds about 250m CPU and 160Mi of memory per pod for its VM. gVisor costs nothing extra but slows system calls, which a browser makes many of.",
        "Rakazo, the API and the worker need their own pods in the same cluster, plus a Postgres database.",
      ],
    },
    {
      heading: "Kubernetes Agent Sandbox and Rakazo",
      paragraphs: [
        "[Agent Sandbox](https://agent-sandbox.sigs.k8s.io) is a Kubernetes SIG project that adds a `Sandbox` resource for agents: one stateful pod with a stable identity, optional storage and pause and resume, plus templates, claims and warm pools of ready sandboxes. Its API is beta (`agents.x-k8s.io/v1beta1`) and it ships weekly releases. Like Rakazo's pods, its isolation comes from the runtime class you choose, gVisor or Kata.",
        "Rakazo doesn't use it. It creates plain pods through the Kubernetes API, so it needs no custom resources or controllers, and it handles persistence itself by saving each bot's workspace. If you already run Agent Sandbox for other agents, the two can share a cluster.",
      ],
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
    { label: "Agent Sandbox on GitHub", href: "https://github.com/kubernetes-sigs/agent-sandbox" },
    { label: "GKE Sandbox", href: "https://docs.cloud.google.com/kubernetes-engine/docs/concepts/sandbox-pods" },
    { label: "GKE pricing", href: "https://cloud.google.com/kubernetes-engine/pricing" },
    { label: "Amazon EKS pricing", href: "https://aws.amazon.com/eks/pricing/" },
    { label: "Azure AKS pricing", href: "https://azure.microsoft.com/en-us/pricing/details/kubernetes-service/" },
    { label: "DigitalOcean Kubernetes pricing", href: "https://www.digitalocean.com/pricing/kubernetes" },
    { label: "AWS, nested virtualization", href: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html" },
    PRICING.digitalocean,
    PRICING.hetzner,
    PRICING.e2b,
    PROVIDERS_DOC,
    RUNTIME_DOC,
    { label: "Rakazo, self-hosting", href: `${GITHUB_URL}/blob/main/docs/self-host.md` },
  ],
};
