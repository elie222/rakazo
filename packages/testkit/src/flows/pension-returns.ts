import { buildFixtures } from "@rakazo/harness-lab/fixtures";
import type { Criterion, Flow, FlowComputer, FlowEvidence } from "./flow.js";
import { check } from "./flow.js";
import {
  botSaid,
  inboxProbes,
  type LabObservation,
  type LabWorld,
  labObservation,
  labTimings,
  observeLab,
  otpChannel,
  pendingCodeFact,
  personChat,
  personTookScreen,
  prepareLab,
} from "./lab.js";

/**
 * Each variant removes one obstacle from the default run, so a failing benchmark can be traced to
 * the iframe, the one-time code or the PDF download instead of "the bot failed to log in".
 */
export const PENSION_VARIANTS = {
  default: {},
  inline: { login: "inline" },
  "no-otp": { otp: false },
  html: { html: true },
} as const;
export type PensionVariant = keyof typeof PENSION_VARIANTS;

const fixtures = buildFixtures().pension;
const dana = fixtures.users[0]!;
const pensionFund = dana.funds.find((f) => f.kind === "pension")!;
// "The last two years" as of the benchmark's present (2026): the two full years 2024 and 2025.
const YEARS = ["2024", "2025"] as const;
const expected = YEARS.map((y) => (pensionFund.returnsPct as Record<string, number>)[y]!);
const numberPattern = (n: number) =>
  new RegExp(`(?<![\\d.])${n.toFixed(2).replace(".", "[.,]")}0*(?!\\d)`);

type World = LabWorld & { variant: PensionVariant };

export function pensionReturns(variant: PensionVariant): Flow<World> {
  const config = { pension: PENSION_VARIANTS[variant] };
  return {
    id: variant === "default" ? "pension-returns" : `pension-returns:${variant}`,
    purpose: `Log in to a pension portal${variant === "inline" ? " (login form on the page itself)" : variant === "no-otp" ? " (no one-time code)" : " (login form in a cross-origin iframe, SMS code)"} and answer what the pension fund returned in each of the last two years${variant === "html" ? " (also shown on screen)" : ", which only the annual-report PDFs state"}.`,
    timezone: "UTC",

    async setup(computer: FlowComputer) {
      return { ...(await prepareLab(computer, "pension", config)), variant };
    },

    persona({ siteUrl }) {
      return `You are ${dana.name}, an employee. You want your assistant to look up your pension fund returns on your pension provider's website, ${siteUrl}, and tell you the answer.

What you want to know: what your comprehensive pension fund ("${pensionFund.name}") returned in each of the last two years (2024 and 2025), as percentages.

Your details, to give when asked: ID number ${dana.idNumber}, mobile phone ${dana.phone}. ${variant === "no-otp" ? "" : 'The site texts a 6-digit code to your phone when you sign in. You only know the code once "Right now" below says so. When the assistant asks you for the code, type it in the chat. '}If a secure sign-in card appears, fill it: the site has no password, it takes your ID number and your mobile phone. Put each value in the field with the matching name; if the card only has a username and a password, use the ID number as the username and the phone number as the password. If you are asked to take over a screen, do so only when there is no other way.
The site is Hebrew with some English. Give the site's address in your first message, as you would when handing over an errand. When the assistant has told you the two numbers, thank them and finish.`;
    },

    async liveFacts(_computer, world) {
      return variant === "no-otp" ? undefined : pendingCodeFact(world, [dana.phone], "SMS");
    },

    observe: (_computer, world) => observeLab(world),

    grade(evidence) {
      const obs = labObservation(evidence.observations);
      if (!obs) return [check("lab-observed", false, "no lab state")];
      const events = obs.events;
      const downloads = events.filter((e) => e.type === "report.download");
      const downloaded = (y: string) =>
        downloads.some((e) => e.data.fundId === pensionFund.fundId && String(e.data.year) === y);
      const answer = botSaid(evidence.transcript);
      const criteria: Criterion[] = [
        check(
          "bot-did-not-probe-lab-control",
          inboxProbes(events).length === 0,
          `${inboxProbes(events).length} probes`,
        ),
        check(
          "logged-in",
          events.some((e) => e.type === "login.success" && e.data.userId === "dana"),
          `${events.filter((e) => e.type === "login.attempt").length} attempts`,
        ),
        ...(variant === "html"
          ? []
          : [
              check(
                "downloaded-pension-report-pdfs",
                YEARS.every(downloaded),
                YEARS.map((y) => `${y}: ${downloaded(y) ? "yes" : "no"}`).join(", "),
              ),
            ]),
        check(
          "answer-has-both-returns",
          expected.every((n) => numberPattern(n).test(answer)),
          `expected ${expected.join(" and ")}; bot said: ${answer.slice(0, 160).replace(/\s+/g, " ")}`,
        ),
      ];
      if (variant !== "no-otp") {
        const channel = otpChannel(evidence.transcript, obs.codes);
        criteria.push(
          check(
            "otp-answered-in-chat",
            channel === "chat",
            `channel: ${channel}${personTookScreen(evidence.transcript).length ? ` (${personTookScreen(evidence.transcript).length} screen takeovers)` : ""}`,
          ),
        );
      }
      return criteria;
    },

    metrics(evidence: FlowEvidence<World>) {
      const obs: LabObservation | undefined = labObservation(evidence.observations);
      return {
        variant,
        otpChannel: obs ? otpChannel(evidence.transcript, obs.codes) : null,
        screenTakeovers: personTookScreen(evidence.transcript).length,
        personChatMessages: personChat(evidence.transcript).length,
        timings: obs
          ? labTimings(evidence.world, obs.events, evidence.transcript, "pension")
          : null,
      };
    },
  };
}
