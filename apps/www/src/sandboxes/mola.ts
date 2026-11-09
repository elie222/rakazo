// Added Mola sandbox provider information for marketing site
import { homepage } from "./shared.js";
import type { Sandbox } from "./types.js";

export const mola: Sandbox = {
  name: "Mola",
  slug: "mola",
  runsOn: "Ubuntu VM (KVM)",
  keeps: "Workspace only",
  bestFor: "Open source, self-hosted",
  title: "Mola AI agent sandbox: open source instant Linux computers",
  description:
    "Mola provides instant Linux computers for AI agents. Open source and self-hostable with QEMU/KVM, or use the managed service. Each bot gets a clean Ubuntu 24.04 machine with Chrome.",
  h1: "Mola for AI agents: instant Linux computers you can run anywhere",
  intro: [
    "[Mola](https://mola.sh) creates Ubuntu 24.04 XFCE desktops in about one second, each in its own VM. Open source at [GitHub](https://github.com/obaid/mola-core), so you can self-host on your own hardware with QEMU/KVM, or use the managed service at cloud.mola.sh. Each bot gets a clean machine with Chrome pre-installed.",
  ],
  image: homepage("mola", "Mola", "Screenshot of the Mola homepage showing instant Linux computers"),
  scene: {
    bot: "Research Agent",
    color: "#6A6BF5",
    where: "Computer on Mola",
    ask: "research the top 10 AI startups from Y Combinator",
    reply: "on it. spinning up a fresh Ubuntu machine. chrome is ready.",
    computer: {
      task: "Browsing YC company list.",
      screen: {
        host: "ycombinator.com",
        title: "YC Companies - AI Startups",
        lines: ["10 companies found", "Gathering data", "Writing summaries"],
      },
    },
  },
  sections: [],
  faq: [],
  sources: [
    { label: "Mola", href: "https://mola.sh" },
    { label: "Mola on GitHub", href: "https://github.com/obaid/mola-core" },
    { label: "Mola API documentation", href: "https://github.com/obaid/mola-core/blob/main/docs/api.md" },
  ],
};
