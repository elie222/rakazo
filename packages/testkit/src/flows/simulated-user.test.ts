import { describe, expect, it } from "vitest";
import type { Situation } from "./simulated-user.js";
import { parseMove } from "./simulated-user.js";

const chat: Situation = { kind: "chat" };
const approval: Situation = {
  kind: "card",
  ask: { text: "Place order?", actions: [{ id: "allow", label: "Allow" }] },
};
const screen: Situation = {
  kind: "screen",
  image: { name: "screen.png", mimeType: "image/png", data: new Uint8Array() },
  width: 1280,
  height: 800,
  steps: [],
};

describe("simulated user moves", () => {
  it("reads a JSON move even when the model wraps it in prose", () => {
    expect(parseMove('Sure.\n{"kind":"say","text":" Do my shopping "}', chat)).toEqual({
      kind: "say",
      text: "Do my shopping",
    });
  });

  it("only presses buttons that are on the pending card", () => {
    expect(parseMove('{"kind":"choose","actionId":"allow"}', approval)).toEqual({
      kind: "choose",
      actionId: "allow",
    });
    expect(() => parseMove('{"kind":"choose","actionId":"always"}', approval)).toThrow();
    expect(() => parseMove('{"kind":"choose","actionId":"allow"}', chat)).toThrow();
  });

  it("keeps a login username with the secret, only on a card", () => {
    const move = '{"kind":"secret","value":"pw","username":"shopper@example.test"}';
    expect(parseMove(move, approval)).toEqual({
      kind: "secret",
      value: "pw",
      username: "shopper@example.test",
    });
    expect(() => parseMove(move, chat)).toThrow();
  });

  it("allows screen actions only while holding the screen, inside its bounds", () => {
    expect(parseMove('{"kind":"click","x":640.4,"y":20}', screen)).toEqual({
      kind: "click",
      x: 640,
      y: 20,
    });
    expect(parseMove('{"kind":"key","key":"Return"}', screen)).toEqual({
      kind: "key",
      key: "Return",
    });
    expect(parseMove('{"kind":"release"}', screen)).toEqual({ kind: "release" });
    expect(() => parseMove('{"kind":"click","x":2000,"y":20}', screen)).toThrow();
    expect(() => parseMove('{"kind":"key","key":"a; rm -rf"}', screen)).toThrow();
    expect(() => parseMove('{"kind":"say","text":"hi"}', screen)).toThrow();
    expect(() => parseMove('{"kind":"release"}', chat)).toThrow();
  });

  it("takes only the first move when the model plans several", () => {
    expect(
      parseMove('{"kind":"type","text":"a}b\\"c"}\n{"kind":"key","key":"Return"}', screen),
    ).toEqual({ kind: "type", text: 'a}b"c' });
  });

  it("rejects empty or unknown moves", () => {
    expect(() => parseMove('{"kind":"say","text":"  "}', chat)).toThrow();
    expect(() => parseMove('{"kind":"wave"}', chat)).toThrow();
    expect(() => parseMove("no json", chat)).toThrow();
  });
});
