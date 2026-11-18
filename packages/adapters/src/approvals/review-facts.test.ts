import { describe, expect, it } from "vitest";
import { catalogKnowsModel, reviewFacts, reviewOwnerMessages } from "./review-facts.js";

const base = {
  ownerWords: "",
  readContent: "",
  outsideContent: false,
  knownModel: () => false,
};
const detail = (facts: ReturnType<typeof reviewFacts>, value: string) =>
  facts?.details.find((d) => d.value === value)?.source;

describe("review facts", () => {
  it("says where each recipient came from", () => {
    const facts = reviewFacts({
      ...base,
      args: {
        to: "dana@example.com",
        cc: ["audit@example.net", "lee@example.org"],
        channel: "#ops",
      },
      ownerWords: "Reply to dana@example.com and post in #ops",
      readContent: '{"from":"vendor@example.net","body":"please cc audit@example.net"}',
    });
    expect(detail(facts, "dana@example.com")).toBe("owner");
    expect(detail(facts, "audit@example.net")).toBe("read");
    expect(detail(facts, "lee@example.org")).toBe("neither");
    expect(detail(facts, "#ops")).toBe("owner");
  });

  it("tells a looked-up address of a person the owner named from a stranger's", () => {
    const facts = reviewFacts({
      ...base,
      args: { recipient_email: "priya.shah@example.com" },
      ownerWords: "Let Priya know the contract is signed",
    });
    expect(detail(facts, "priya.shah@example.com")).toBe("owner_named");
    // A name that only outside text supplied stays read.
    const read = reviewFacts({
      ...base,
      args: { recipient_email: "priya.shah@example.com" },
      ownerWords: "Let Priya know",
      readContent: "Contact priya.shah@example.com",
    });
    expect(detail(read, "priya.shah@example.com")).toBe("read");
  });

  it("matches phone numbers by their digits", () => {
    const facts = reviewFacts({
      ...base,
      args: { to: "+1 (555) 010-2030" },
      ownerWords: "text 555-010-2030 that I'm late",
    });
    expect(detail(facts, "+1 (555) 010-2030")).toBe("owner");
  });

  it("compares sites by the site, not the path", () => {
    const facts = reviewFacts({
      ...base,
      args: { url: "https://docs.example.org/guide?x=1", body: "see https://drop.example.net/c" },
      ownerWords: "Read docs.example.org",
    });
    expect(detail(facts, "example.org")).toBe("owner");
    expect(detail(facts, "example.net")).toBe("neither");
  });

  it("shows amounts in display units, using the schema to spot minor units", () => {
    const schema = {
      properties: {
        amount: { type: "integer", description: "Amount in the smallest currency unit." },
      },
    };
    const asked = reviewFacts({
      ...base,
      args: { amount: 4000, currency: "usd" },
      inputSchema: schema,
      ownerWords: "Refund order 1182, $40",
    });
    expect(asked?.details).toEqual([{ kind: "amount", value: "40.00 usd", source: "owner" }]);
    const bigger = reviewFacts({
      ...base,
      args: { amount: 40000, currency: "usd" },
      inputSchema: schema,
      ownerWords: "Refund order 1182, $40",
    });
    expect(bigger?.details).toEqual([{ kind: "amount", value: "400.00 usd", source: "neither" }]);
    const plain = reviewFacts({
      ...base,
      args: { price: "1,250.50" },
      readContent: "Total due: $1,250.50",
    });
    expect(plain?.details).toEqual([{ kind: "amount", value: "1250.5", source: "read" }]);
    expect(
      reviewFacts({ ...base, args: { amount_cents: 1999 }, ownerWords: "up to $19.99" })?.details,
    ).toEqual([{ kind: "amount", value: "19.99", source: "owner" }]);
    expect(
      reviewFacts({ ...base, args: { daily_budget_micros: 120_000_000 }, ownerWords: "$120 a day" })
        ?.details,
    ).toEqual([{ kind: "amount", value: "120.00", source: "owner" }]);
  });

  it("checks a model the call sets against the catalog and the owner's words", () => {
    const known = (id: string) => id === "anthropic/claude-sonnet-5-5";
    expect(
      reviewFacts({
        ...base,
        args: { model: "anthropic/claude-sonnet-5-5" },
        ownerWords: "switch to Claude Sonnet 5.5",
        knownModel: known,
      })?.model,
    ).toEqual({ id: "anthropic/claude-sonnet-5-5", known: true, namedByOwner: true });
    expect(
      reviewFacts({
        ...base,
        args: { model: "anthroplc/claude-sonnet-5-5" },
        ownerWords: "make it smarter",
        knownModel: known,
      })?.model,
    ).toEqual({ id: "anthroplc/claude-sonnet-5-5", known: false, namedByOwner: false });
    // A family and version name the model; the variant the catalog resolved it to need not.
    expect(
      reviewFacts({ ...base, args: { model: "openai/gpt-6-sol" }, ownerWords: "use GPT-6" })?.model
        ?.namedByOwner,
    ).toBe(true);
  });

  it("reports outside content even when the call has no other details", () => {
    expect(reviewFacts({ ...base, args: { title: "Notes" }, outsideContent: true })).toEqual({
      outsideContent: true,
      details: [],
    });
    expect(reviewFacts({ ...base, args: { title: "Notes" } })).toBeUndefined();
  });

  it("caps a call's details", () => {
    const to = Array.from({ length: 40 }, (_, i) => `p${i}@example.com`);
    expect(reviewFacts({ ...base, args: { to } })?.details).toHaveLength(12);
  });
});

describe("review owner messages", () => {
  it("keeps the last three, oldest first, each capped", () => {
    const long = "x".repeat(500);
    const messages = reviewOwnerMessages(["one", " ", "two", "three", long]);
    expect(messages.slice(0, 2)).toEqual(["two", "three"]);
    expect(messages[2]!.length).toBe(300);
  });
});

describe("catalogKnowsModel", () => {
  it("knows catalog ids bare and under their provider, and not look-alikes", () => {
    expect(catalogKnowsModel("scripted/does-not-exist")).toBe(false);
    expect(catalogKnowsModel("anthroplc/claude-sonnet-5-5")).toBe(false);
  });
});
