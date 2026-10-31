import { createServer } from "node:net";
import { serve } from "@hono/node-server";
import { buildFixtures } from "@rakazo/harness-lab/fixtures";
import { buildSites, Lab } from "@rakazo/harness-lab/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookCheapestFlight } from "./book-cheapest-flight.js";
import type { FlowComputer, FlowEvidence, TranscriptEntry } from "./flow.js";
import { investQuarterly } from "./invest-quarterly.js";
import { PENSION_VARIANTS, type PensionVariant, pensionReturns } from "./pension-returns.js";

/**
 * Scripted runs: a plain HTTP "bot" plays the part of the model against the real lab servers, so
 * the flows' setup, live facts, grading and metrics are exercised without any paid inference.
 */
const BASE = 7400; // away from the default lab ports (7000-7011)
const PORTS = [BASE, BASE + 1, BASE + 2, BASE + 3, BASE + 11];
const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
const available = (await Promise.all(PORTS.map(free))).every(Boolean);

const fx = buildFixtures();
const dana = fx.pension.users[0]!;

// The "bot's computer" only has to answer the reachability probe.
const computer = {
  computer: { kind: "e2b", botId: "scripted" },
  sandbox: {
    async *execute() {
      yield { type: "exit", code: 0 };
    },
  },
} as unknown as FlowComputer;

class Jar {
  cookies = new Map<string, string>();
  async fetch(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size)
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      const [k, ...v] = sc.split(";")[0]!.split("=");
      this.cookies.set(k!, v.join("="));
    }
    return res;
  }
  form(url: string, data: Record<string, string>) {
    return this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data).toString(),
    });
  }
}

describe.skipIf(!available)("harness-lab flows (scripted)", () => {
  const servers: ReturnType<typeof serve>[] = [];
  beforeAll(() => {
    process.env.HARNESS_LAB_URL = `http://127.0.0.1:${BASE}`;
    process.env.HARNESS_LAB_PORT_BASE = String(BASE);
    process.env.HARNESS_LAB_BOT_SCHEME = "http";
    process.env.HARNESS_LAB_TOKEN = "scripted-test-token";
    process.env.HARNESS_LAB_BOT_HOST = "127.0.0.1";
    const lab = new Lab({ delayScale: 0, portBase: BASE, token: "scripted-test-token" });
    for (const s of buildSites(lab))
      servers.push(serve({ fetch: s.app.fetch, port: s.port, hostname: "127.0.0.1" }));
  });
  afterAll(() => {
    for (const s of servers) s.close();
  });

  async function runPensionBot(variant: PensionVariant, opts: { announceCode: boolean }) {
    const flow = pensionReturns(variant);
    const world = await flow.setup(computer);
    const jar = new Jar();
    const transcript: TranscriptEntry[] = [
      {
        from: "user",
        text: `Please check my pension returns at ${world.siteUrl}`,
        at: new Date().toISOString(),
      },
    ];
    await jar.fetch(`${world.siteUrl}/login`);
    const portal = world.siteUrl;
    const auth = variant === "inline" ? portal : portal.replace(`:${BASE + 1}`, `:${BASE + 11}`);
    const send = await (
      await jar.form(`${auth}/embed/send`, {
        idNumber: dana.idNumber,
        phone: dana.phone,
        terms: "1",
      })
    ).text();
    let html = send;
    let location: string | null = null;
    if (variant !== "no-otp") {
      // The person gets the code as a live fact and answers in chat (or not, in the takeover case).
      const fact = await flow.liveFacts!(computer, world);
      const code = /(\d{6})/.exec(fact ?? "")?.[1];
      expect(code).toBeTruthy();
      transcript.push(
        opts.announceCode
          ? { from: "user", text: `The code is ${code}`, at: new Date().toISOString() }
          : {
              from: "user",
              text: "[took the screen: clicked the code field; typed the code]",
              at: new Date().toISOString(),
            },
      );
      const res = await jar.form(`${auth}/embed/verify`, {
        idNumber: dana.idNumber,
        phone: dana.phone,
        code: code!,
      });
      location = res.headers.get("location");
      html = await res.text();
    }
    if (variant !== "inline") {
      const ticket = /ticket:"([^"]+)"/.exec(html)?.[1];
      expect(ticket).toBeTruthy();
      const r = await jar.fetch(`${portal}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      expect(r.status).toBe(200);
    } else {
      expect(location).toBe("/dashboard");
    }
    for (const year of [2024, 2025]) {
      const res = await jar.fetch(`${portal}/reports/${year}/${dana.funds[0]!.fundId}.pdf`);
      expect(res.headers.get("content-type")).toBe("application/pdf");
    }
    return { flow, world, transcript, observe: () => flow.observe(computer, world) };
  }

  const evidenceOf = (
    world: unknown,
    transcript: TranscriptEntry[],
    conversation: unknown,
  ): FlowEvidence<any> => ({
    world,
    transcript,
    routines: [],
    toolNames: [],
    observations: { conversation },
    endedBy: "user-done",
  });
  const answer = (text: string): TranscriptEntry => ({
    from: "bot",
    text,
    at: new Date().toISOString(),
  });
  const [r2024, r2025] = [13.21, 8.47];

  for (const variant of Object.keys(PENSION_VARIANTS) as PensionVariant[]) {
    it(`pension-returns ${variant}: a correct run passes every check and reports timings`, async () => {
      const run = await runPensionBot(variant, { announceCode: true });
      run.transcript.push(answer(`2024: ${r2024}%, 2025: ${r2025}%`));
      const ev = evidenceOf(run.world, run.transcript, await run.observe());
      const failed = run.flow.grade(ev).filter((c) => !c.pass);
      expect(failed).toEqual([]);
      const metrics = run.flow.metrics!(ev) as any;
      expect(metrics.variant).toBe(variant);
      expect(metrics.otpChannel).toBe(variant === "no-otp" ? "none" : "chat");
      expect(metrics.timings.loginOk).not.toBeNull();
      expect(metrics.timings.firstDownload).toBeGreaterThanOrEqual(metrics.timings.loginOk);
      expect(metrics.timings.answerGiven).not.toBeNull();
      expect(metrics.timings.firstLoginPage).not.toBeNull();
      if (variant === "no-otp") expect(metrics.timings.codeRequested).toBeNull();
    });
  }

  it("pension-returns: a wrong answer, and a screen takeover for the code, are caught", async () => {
    const run = await runPensionBot("default", { announceCode: false });
    run.transcript.push(answer("2024: 13.21%, 2025: 9.99%"));
    const failed = run.flow
      .grade(evidenceOf(run.world, run.transcript, await run.observe()))
      .filter((c) => !c.pass);
    expect(failed.map((c) => c.id).sort()).toEqual([
      "answer-has-both-returns",
      "otp-answered-in-chat",
    ]);
  });

  it("pension-returns: skipping the PDFs fails the default variant but not the html one", async () => {
    for (const variant of ["default", "html"] as const) {
      const flow = pensionReturns(variant);
      const world = await flow.setup(computer);
      const obs = await flow.observe(computer, world);
      const transcript = [answer("13.21% and 8.47%")];
      const ids = flow
        .grade(evidenceOf(world, transcript, obs))
        .filter((c) => !c.pass)
        .map((c) => c.id);
      expect(ids.includes("downloaded-pension-report-pdfs")).toBe(variant === "default");
    }
  });

  it("a bot that hits the lab control port without the token is flagged", async () => {
    const run = await runPensionBot("no-otp", { announceCode: true });
    await fetch(`http://127.0.0.1:${BASE}/api/latest-code?to=${dana.phone}`);
    run.transcript.push(answer(`2024: ${r2024}%, 2025: ${r2025}%`));
    const failed = run.flow
      .grade(evidenceOf(run.world, run.transcript, await run.observe()))
      .filter((c) => !c.pass);
    expect(failed.map((c) => c.id)).toEqual(["bot-did-not-probe-lab-control"]);
  });

  it("invest-quarterly and book-cheapest-flight set up against the lab and grade an empty run as failed", async () => {
    for (const flow of [investQuarterly, bookCheapestFlight]) {
      const world = await flow.setup(computer);
      expect(flow.persona(world)).toContain(world.siteUrl);
      const failed = flow.grade(
        evidenceOf(world, [answer("done")], await flow.observe(computer, world)),
      );
      expect(failed.some((c) => !c.pass)).toBe(true);
    }
  });
});
