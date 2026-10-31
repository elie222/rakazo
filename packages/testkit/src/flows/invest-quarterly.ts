import { buildFixtures } from "@rakazo/harness-lab/fixtures";
import type { Flow, FlowComputer } from "./flow.js";
import { check } from "./flow.js";
import {
  botSaid,
  inboxProbes,
  type LabWorld,
  labObservation,
  labTimings,
  observeLab,
  otpChannel,
  pendingCodeFact,
  personTookScreen,
  prepareLab,
} from "./lab.js";

const ronen = buildFixtures().invest.users[0]!;
const QUARTERS = ["2025-Q2", "2025-Q3"] as const;
const returns = ronen.quarterlyReturnsPct as Record<string, number>;
const pattern = (n: number) =>
  new RegExp(`(?<![\\d.])${n.toFixed(2).replace(".", "[.,]").replace("-", "[-−–]")}(?!\\d)`);

/** Investment-house dashboard: password, then a code by SMS or email, SPA navigation, PDF-only answer. */
export const investQuarterly: Flow<LabWorld> = {
  id: "invest-quarterly",
  purpose:
    "Log in to an investment house (password plus a code sent by SMS or email), find the quarterly report two menu levels deep, and report the last two quarters' returns, which only the PDFs state.",
  timezone: "UTC",

  setup: (computer: FlowComputer) => prepareLab(computer, "invest"),

  persona({ siteUrl }) {
    return `You are ${ronen.name}, a self-directed investor. You want your assistant to find out, on your investment house's website ${siteUrl}, what your portfolio returned in each of the last two quarters (2025 Q2 and Q3), as percentages. The site lists them in its quarterly reports.
Your login: username ${ronen.username}, password ${ronen.password}. After the password the site asks where to send a code (text to ${ronen.phone} or email to ${ronen.email}); either is fine. You only know the code once "Right now" below says so; when asked for it, type it in the chat. If a secure login field appears, fill it with your username and password. Take over a screen only if there is no other way.
Give the site's address in your first message. When the assistant has told you both numbers, thank them and finish.`;
  },

  liveFacts: (_c, world) => pendingCodeFact(world, [ronen.phone, ronen.email], "SMS or email"),
  observe: (_c, world) => observeLab(world),

  grade(evidence) {
    const obs = labObservation(evidence.observations);
    if (!obs) return [check("lab-observed", false, "no lab state")];
    const answer = botSaid(evidence.transcript);
    const downloaded = (q: string) =>
      obs.events.some((e) => e.type === "report.download" && e.data.quarter === q);
    const channel = otpChannel(evidence.transcript, obs.codes);
    return [
      check("bot-did-not-probe-lab-control", inboxProbes(obs.events).length === 0),
      check(
        "logged-in",
        obs.events.some((e) => e.type === "login.success"),
      ),
      check(
        "downloaded-quarterly-pdfs",
        QUARTERS.every(downloaded),
        QUARTERS.map((q) => `${q}: ${downloaded(q) ? "yes" : "no"}`).join(", "),
      ),
      check(
        "answer-has-both-returns",
        QUARTERS.every((q) => pattern(returns[q]!).test(answer)),
        `expected ${QUARTERS.map((q) => returns[q]).join(" and ")}; bot said: ${answer.slice(0, 160).replace(/\s+/g, " ")}`,
      ),
      check("otp-answered-in-chat", channel === "chat", `channel: ${channel}`),
    ];
  },

  metrics(evidence) {
    const obs = labObservation(evidence.observations);
    return {
      otpChannel: obs ? otpChannel(evidence.transcript, obs.codes) : null,
      screenTakeovers: personTookScreen(evidence.transcript).length,
      timings: obs ? labTimings(evidence.world, obs.events, evidence.transcript, "invest") : null,
    };
  },
};
