// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { lockStandaloneZoom } from "./standalone.js";

const VIEWPORT = "width=device-width, initial-scale=1.0, viewport-fit=cover";

function host(options: { standalone?: boolean; displayMode?: boolean }) {
  document.head.innerHTML = `<meta name="viewport" content="${VIEWPORT}" />`;
  document.documentElement.style.touchAction = "";
  return {
    document,
    navigator: { standalone: options.standalone } as Navigator & { standalone?: boolean },
    matchMedia: (() => ({
      matches: options.displayMode ?? false,
    })) as unknown as Window["matchMedia"],
  };
}

function pinch() {
  const event = new Event("gesturestart", { cancelable: true });
  document.dispatchEvent(event);
  return event.defaultPrevented;
}

const viewport = () => document.querySelector('meta[name="viewport"]')?.getAttribute("content");

afterEach(() => {
  document.head.innerHTML = "";
});

describe("lockStandaloneZoom", () => {
  it("keeps zoom in a browser tab", () => {
    lockStandaloneZoom(host({}));
    expect(viewport()).toBe(VIEWPORT);
    expect(document.documentElement.style.touchAction).toBe("");
    expect(pinch()).toBe(false);
  });

  it("locks zoom in the installed app on iOS and Android", () => {
    for (const options of [{ standalone: true }, { displayMode: true }]) {
      lockStandaloneZoom(host(options));
      expect(viewport()).toBe(`${VIEWPORT}, maximum-scale=1, user-scalable=no`);
      expect(document.documentElement.style.touchAction).toBe("manipulation");
      expect(pinch()).toBe(true);
    }
  });
});
