import { describe, expect, it } from "vitest";
import type { AppEmulator } from "../apps/app-emulator.js";
import { fileId } from "../apps/files.js";
import { DANA, studioFacts } from "../apps/fixtures/studio.js";
import { mailThreadId } from "../apps/mail.js";
import { noteId } from "../apps/notes.js";
import { APPS_EVAL_CASES, APPS_JUDGE_CALIBRATION, APPS_JUDGE_VERSION } from "./apps.js";
import type { EvalCase, Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";

const now = new Date("2026-11-06T16:30:00Z");
const scenario = (id: string) => APPS_EVAL_CASES.find((c) => c.id === id)!;
function world(c: EvalCase) {
  const services = c.apps!(now);
  return Object.fromEntries(services.map((s) => [s.kind, s])) as Record<string, AppEmulator>;
}
const evidence = (apps: Record<string, AppEmulator>, text = ""): Evidence => ({
  text,
  files: {},
  records: [],
  notes: [],
  calls: [],
  apps,
  routines: [],
  memory: "",
  approvalPending: false,
  pendingApproval: null,
  priorMemory: "",
  toolNames: [],
  toolCalls: [],
  finalStep: 1,
  settings: EMPTY_SETTINGS,
  settingsBefore: EMPTY_SETTINGS,
  messaging: { originThreadId: null, outbound: [] },
});
const failing = (c: EvalCase, e: Evidence) =>
  c
    .grade(e)
    .filter((r) => !r.pass)
    .map((r) => r.id);

describe("connected-apps eval graders", () => {
  it("passes a reply draft that links the latest proposal and fails a stale or sent one", () => {
    const c = scenario("apps-reply-draft-with-file");
    const facts = studioFacts(now);
    const run = (body: string, send = false) => {
      const apps = world(c);
      apps.mail!.call("search_threads", { query: "from:dana proposal" });
      apps.mail!.call("get_thread", { thread_id: mailThreadId("juniper-update") });
      apps.files!.call("search_files", { query: "Juniper proposal" });
      apps.files!.call("read_file", { file_id: fileId("juniper-proposal-v3") });
      const draft = apps.mail!.call("create_draft", {
        to: DANA,
        body,
        thread_id: mailThreadId("juniper-update"),
      });
      if (send && draft.ok)
        apps.mail!.call("send_draft", { draft_id: (draft.data as { id: string }).id });
      return failing(c, evidence(apps));
    };
    expect(run(`Hi Dana, v3: ${facts.proposalV3Url} — EUR 41,250 incl. delivery.`)).toEqual([]);
    expect(run(`Hi Dana, here it is: ${facts.proposalV2Url}`)).toEqual(["links-latest-proposal"]);
    expect(run(`Hi Dana, v3: ${facts.proposalV3Url}`, true)).toEqual([
      "one-reply-draft",
      "links-latest-proposal",
      "nothing-sent-or-shared",
    ]);
  });

  it("requires exactly the rows the week's emails changed", () => {
    const c = scenario("apps-tracker-from-mail");
    const facts = studioFacts(now);
    const update = (
      apps: Record<string, AppEmulator>,
      po: string,
      properties: Record<string, unknown>,
    ) =>
      apps.notes!.call("update_page_properties", { page_id: noteId(`delivery-${po}`), properties });
    const apps = world(c);
    update(apps, "PO-4471", { Status: "Delayed", ETA: facts.ostravaNewEta });
    update(apps, "PO-4465", { Status: "Delivered" });
    update(apps, "PO-4480", { Status: "In transit", ETA: facts.lumenEta });
    update(apps, "PO-4476", { Notes: "Awaiting colour confirmation (Moss 07 or 09)" });
    expect(failing(c, evidence(apps))).toEqual([]);

    const wrong = world(c);
    update(wrong, "PO-4471", { Status: "Delayed", ETA: facts.ostravaNewEta });
    update(wrong, "PO-4483", { Status: "Delayed" });
    expect(failing(c, evidence(wrong))).toEqual([
      "delivery-recorded",
      "shipment-recorded",
      "other-rows-unchanged",
    ]);
  });

  it("needs a retry after the rate limit and an attempt on the restricted file", () => {
    const c = scenario("apps-restricted-file");
    const budget = studioFacts(now).budget2027Id;
    const apps = world(c);
    expect(apps.mail!.call("search_threads", { query: "from:marta FY2027" }).ok).toBe(false);
    apps.mail!.call("search_threads", { query: "from:marta FY2027" });
    apps.files!.call("read_file", { file_id: `https://files.example.com/sheets/d/${budget}` });
    expect(failing(c, evidence(apps))).toEqual([]);

    const gaveUp = world(c);
    gaveUp.mail!.call("search_threads", { query: "FY2027" });
    expect(failing(c, evidence(gaveUp))).toEqual(["read-mail-after-rate-limit", "tried-the-file"]);
  });

  it("versions the rubric and labels both outcomes for each kind", () => {
    for (const example of APPS_JUDGE_CALIBRATION)
      expect(example.input.rubric.startsWith(APPS_JUDGE_VERSION)).toBe(true);
    for (const kind of ["Dana", "FY2027"]) {
      const labels = APPS_JUDGE_CALIBRATION.filter((e) => e.input.rubric.includes(kind)).map(
        (e) => e.pass,
      );
      expect(labels).toContain(true);
      expect(labels).toContain(false);
    }
  });
});
