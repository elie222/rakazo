import { GITHUB_URL } from "../site";
import {
  MONTH_HOURS,
  PRICES_NOTE,
  PRICING,
  PROVIDERS_DOC,
  RUNTIME_DOC,
  WORKDAY_HOURS,
  WUYING,
  aboutUsd,
  usd,
  wuyingPayAsYouGo,
  wuyingPlan120,
  wuyingUnlimited,
} from "./shared";
import type { Sandbox } from "./types";

const SIZE = `${WUYING.size.vcpus} vCPU / ${WUYING.size.gb} GiB`;
const About = (amount: number) => `A${aboutUsd(amount).slice(1)}`;
const planBeatsHourly = Math.round(WUYING.plan120 / WUYING.hour);
const unlimitedBeatsPlan = Math.round(120 + (WUYING.unlimited - WUYING.plan120) / WUYING.hour);

const WUYING_DOC = `${GITHUB_URL}/blob/main/docs/wuying-computers.md`;

export const wuying: Sandbox = {
  slug: "wuying",
  name: "Wuying",
  runsOn: "Your Alibaba Cloud Windows desktop",
  keeps: "The desktop's own disk",
  bestFor: "Windows apps, Alibaba Cloud and mainland China",
  title: "Wuying cloud computer for AI agents: pricing and letting Rakazo bots use a Windows desktop on Alibaba Cloud",
  description:
    "Let AI agents work on a Wuying (Elastic Desktop Service) Windows cloud computer on Alibaba Cloud. Wuying pricing by the hour or month, a worked monthly cost, and how Rakazo bots run PowerShell and Windows apps you can watch and take over.",
  h1: "Let your AI agents use a Wuying cloud computer",
  intro: [
    "Wuying (无影) is Alibaba Cloud's cloud computer service, sold outside China as Elastic Desktop Service. It gives you a Windows desktop that runs in Alibaba Cloud and that you open from a browser or the Wuying client.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and each bot gets a computer you can watch and take over. With Wuying, that computer is a Windows desktop you already run on Alibaba Cloud. It is the only way to give Rakazo bots Windows, and it suits teams on Alibaba Cloud or in mainland China, where other sandbox providers can be hard to reach.",
  ],
  scene: {
    bot: "Expense Manager",
    color: "#F2622A",
    where: "Computer on Wuying",
    ask: "reconcile october's card export against the receipts folder",
    reply: "on it. opening the export in excel on the windows desktop. anything that doesn't line up, i ask.",
    computer: {
      task: "Matching charges in Excel.",
      screen: {
        host: "october-card.xlsx",
        title: "Month-end close: October",
        lines: ["38 charges matched", "Harbor hotel: two nights", "2 receipts missing"],
      },
    },
  },
  sections: [
    {
      heading: "What is Wuying?",
      paragraphs: [
        "[Wuying](https://www.aliyun.com/product/ecs/gws) is Alibaba Cloud's line of cloud computers, also sold internationally as [Elastic Desktop Service](https://www.alibabacloud.com/en/product/cloud-desktop). Each cloud computer is a full Windows machine with its own disk, assigned to an end user and billed by Alibaba Cloud.",
        "This is not AgentBay, Alibaba Cloud's separate sandbox service for agents. Rakazo uses one ordinary Wuying desktop that you have already created, and talks to it through the desktop's MCP gateway.",
      ],
      image: true,
    },
    {
      heading: "Wuying pricing",
      paragraphs: [
        "Alibaba Cloud bills a Wuying computer for compute and, separately, for its disks. Compute is either pay-as-you-go by the hour, a monthly plan with 120 hours, or an unlimited monthly plan. Hours beyond a 120-hour plan are charged at the hourly rate, and stop being charged once the month's total reaches the unlimited price. Disks bill every hour they exist, even while the computer is off.",
        "Alibaba Cloud publishes example prices in its billing docs and the exact ones on its purchase page, which depend on size, region, Windows image and promotions. It publishes no example for 2 vCPU / 4 GB; the examples below are for 4 vCPU / 8 GiB, the closest size it publishes and a comfortable one for Windows with Office apps.",
      ],
      table: {
        caption: `Wuying example prices for a ${SIZE} computer, November 2026`,
        columns: ["Billing", "International (USD)", "Mainland China (CNY)"],
        rows: [
          { topic: "Pay-as-you-go", cells: [`$${WUYING.hour} an hour`, `¥${WUYING.cny.hour} an hour`] },
          { topic: "120 hours a month", cells: [`${usd(WUYING.plan120)} a month`, `¥${WUYING.cny.plan120} a month`] },
          { topic: "Unlimited", cells: [`${usd(WUYING.unlimited)} a month`, `¥${WUYING.cny.unlimited} a month`] },
          {
            topic: "Disk",
            cells: [
              `$${WUYING.diskGbHour} per GiB-hour, or $${WUYING.diskGbMonth} per GiB-month`,
              `¥${WUYING.cny.diskGbHour} per GiB-hour, or ¥${WUYING.cny.diskGbMonth} per GiB-month`,
            ],
          },
          { topic: "Bandwidth", cells: ["Basic 5 Mbps shared bandwidth free; faster options extra", "Traffic ¥0.80 per GB"] },
        ],
        note: `${PRICES_NOTE} Alibaba Cloud marks these as examples; your order shows the final price. Sources: [Elastic Desktop Service billing](https://www.alibabacloud.com/help/en/wuying-workspace/product-overview/billing-overview) and [无影 billing](https://help.aliyun.com/zh/wuying-workspace/product-overview/billing-overview).`,
      },
    },
    {
      heading: "What a Wuying computer costs with Rakazo",
      paragraphs: [
        `Rakazo starts the desktop when a bot needs it and powers it off when the last computer on it stops, so on pay-as-you-go you pay for roughly the hours bots work. Monthly costs follow [the method on the comparison page](/sandboxes/#pricing), at ${SIZE} with an ${WUYING.diskGb} GiB system disk because Alibaba Cloud publishes no 2 vCPU / 4 GB example.`,
      ],
      table: {
        caption: `One ${SIZE} Wuying computer a month, international prices`,
        columns: ["Usage", "Pay-as-you-go", "120-hour plan", "Unlimited plan"],
        rows: [
          {
            topic: `4 hours a workday, ${WORKDAY_HOURS} hours`,
            cells: [
              `${About(wuyingPayAsYouGo(WORKDAY_HOURS))} (${usd(WUYING.hour * WORKDAY_HOURS)} compute, the rest disk)`,
              About(wuyingPlan120(WORKDAY_HOURS)),
              About(wuyingUnlimited),
            ],
          },
          {
            topic: `Around the clock, ${MONTH_HOURS} hours`,
            cells: [
              About(wuyingPayAsYouGo(MONTH_HOURS)),
              `${About(wuyingPlan120(MONTH_HOURS))}, capped at the unlimited price`,
              About(wuyingUnlimited),
            ],
          },
        ],
        note: "Computed from Alibaba Cloud's example prices, checked November 2026. Disk at the pay-as-you-go rate for pay-as-you-go, and at the monthly rate for plans. Your model provider bills separately.",
      },
      bullets: [
        `Pay-as-you-go is cheapest below about ${planBeatsHourly} hours a month. Above that, the 120-hour plan wins, and past about ${unlimitedBeatsPlan} hours the unlimited plan does.`,
        "Everyone sharing the desktop shares this bill. Rakazo doesn't add a charge for using it.",
      ],
    },
    {
      heading: "What a bot can do on a Wuying desktop",
      paragraphs: [
        "Bots work on the Windows desktop the same way a person would, and you see the live screen in the computer panel next to the chat in the web and desktop apps.",
      ],
      bullets: [
        "Run PowerShell commands. Output is switched to UTF-8, so Chinese text comes back readable.",
        "Read and write files. Each bot computer gets its own home folder under `%USERPROFILE%\\rakazo`, kept on the desktop's own disk.",
        "Take screenshots and use the mouse and keyboard, so it can work in Windows apps such as Excel, not only in a browser.",
        "Let you watch the screen live and take over when it needs a login or a decision.",
        "Rakazo starts the desktop when a bot needs it and powers it off when the last computer on it stops. Deleting a bot computer removes only its folder, never the desktop.",
      ],
    },
    {
      heading: "When to choose Wuying",
      paragraphs: [
        "Choose Wuying when bots need Windows software, when your team already runs on Alibaba Cloud, or when you are in mainland China. It also lets a single person bring their own Windows desktop to a shared Rakazo without asking an admin.",
        "For Linux computers with a desktop and browser, hosted options such as [Boat](/sandboxes/boat/), [E2B](/sandboxes/e2b/) and [Novita](/sandboxes/novita/) give each bot more isolation, a terminal and several screens at once. [Docker](/sandboxes/docker/) and [Kubernetes](/sandboxes/kubernetes/) keep computers on your own servers. To let a bot use your own Windows PC instead, see [your computer](/sandboxes/your-computer/). The [sandbox comparison](/sandboxes/) covers every option.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "Everyone using the desktop, including Private Computers, shares one Windows account, its files and its signed-in apps. A screen login opened for watching can also control the desktop. Share one desktop only among people who trust each other.",
        "One screen viewer at a time. Opening the screen in a second browser or the Wuying client signs the other one out.",
        "No terminal you can open yourself, and no live screen in the mobile app.",
        "Each call to the desktop is capped at one minute and 16 KiB of output. Longer commands run detached and still stream their output.",
        "Windows-key shortcuts aren't available, and there are no snapshots.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "Any Rakazo account can point its own Team Computers at a Wuying desktop it brings. An admin can also make Wuying the default for everyone on a [self-hosted Rakazo](/self-hosted-ai-agent/). Either way you need these from Alibaba Cloud first.",
      ],
      steps: [
        "Create a Windows Wuying cloud computer and assign it to an end user. Screen logins are issued for that user.",
        "Create a RAM user and an AccessKey allowed only `ecd:DescribeDesktops`, `ecd:StartDesktops`, `ecd:StopDesktops` and `appstream-center:GetAuthCode`.",
        "Get the desktop's MCP gateway URL, which must be public HTTPS, and its bearer token.",
        "If you self-host, fetch the Wuying Web SDK once before building the web app: `node scripts/wuying-web-sdk.mjs`.",
        "Open Settings → Computer and choose Wuying. Admins set it for the deployment under New computers run on, or for themselves under My computers; other accounts see only their own choice. Fill in the desktop ID, end user ID, region (default `cn-hangzhou`), AccessKey ID and secret, MCP gateway URL and token, then Save.",
        "Rakazo checks that the AccessKey can see the desktop and that the gateway answers before saving anything. Your next Team Computer starts on the Wuying desktop.",
      ],
    },
    {
      heading: "Setting it up with environment variables",
      paragraphs: [
        "An admin can instead set `SANDBOX_PROVIDER=wuying` on the API and worker with `WUYING_ACCESS_KEY_ID`, `WUYING_ACCESS_KEY_SECRET`, `WUYING_DESKTOP_ID`, `WUYING_END_USER_ID`, `WUYING_MCP_URL`, `WUYING_MCP_TOKEN` and optionally `WUYING_REGION_ID`. A connection saved in Settings takes precedence.",
        `The [Wuying setup guide](${WUYING_DOC}) and the [computer providers guide](/docs/self-host-sandbox-providers/) have the details and troubleshooting.`,
      ],
    },
  ],
  image: {
    webp: "/graphics/sandboxes/wuying.webp",
    avif: "/graphics/sandboxes/wuying.avif",
    width: 1280,
    height: 800,
    alt: "The Alibaba Cloud Elastic Desktop Service page, headed Empower your workspace with secure, open, and affordable cloud computers.",
    caption: "Alibaba Cloud Elastic Desktop Service homepage, November 4, 2026.",
  },
  faq: [
    {
      question: "Can an AI agent use a Windows cloud computer?",
      answer:
        "Yes. With Rakazo, bots can work on a Wuying Windows desktop: they run PowerShell, use files and Windows apps, and you can watch and take over the screen.",
    },
    {
      question: "Is this Alibaba Cloud AgentBay?",
      answer:
        "No. Rakazo uses a Wuying cloud computer you already have, not the AgentBay sandbox service. AgentBay bills per second for each session, at $0.027 per core-hour and $0.0113 per GB-hour as of November 2026, and Rakazo doesn't support it.",
    },
    {
      question: "Do I need to be an admin to use Wuying with Rakazo?",
      answer:
        "No. Any account can connect its own Wuying desktop in Settings → Computer for its Team Computers. Only an admin can make Wuying the default for the whole deployment.",
    },
    {
      question: "Is a shared Wuying desktop isolated between bots?",
      answer:
        "Only by folder. Each bot computer has its own home folder, but everyone on the desktop shares one Windows account, so they can reach each other's files and logins. Give each person their own desktop if that matters.",
    },
  ],
  sources: [
    {
      label: "Alibaba Cloud Elastic Desktop Service",
      href: "https://www.alibabacloud.com/en/product/cloud-desktop",
    },
    { label: "无影云电脑", href: "https://www.aliyun.com/product/ecs/gws" },
    PRICING.wuying,
    { label: "无影, billing overview", href: "https://help.aliyun.com/zh/wuying-workspace/product-overview/billing-overview" },
    {
      label: "Alibaba Cloud, AgentBay billing",
      href: "https://www.alibabacloud.com/help/en/agentbay/product-overview/agentbay-billing-instructions",
    },
    { label: "Rakazo, Wuying setup", href: WUYING_DOC },
    PROVIDERS_DOC,
    RUNTIME_DOC,
  ],
};
