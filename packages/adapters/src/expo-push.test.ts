import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deletePushToken,
  ExpoPushProvider,
  expoPushErrorMessage,
  loadPushToken,
  savePushToken,
} from "./expo-push.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const notifyContext = {
  operationId: "n",
  traceId: "n",
  spaceId: "w",
  userId: "user-1",
  signal: new AbortController().signal,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("expo push tickets", () => {
  it("reads a single Expo ticket and a ticket array", () => {
    expect(expoPushErrorMessage({ data: { status: "ok", id: "1" } }, 200)).toBeUndefined();
    expect(expoPushErrorMessage({ data: { status: "error", message: "bad token" } }, 200)).toBe(
      "bad token",
    );
    expect(expoPushErrorMessage({ errors: [{ message: "rate limited" }] }, 429)).toBe(
      "rate limited",
    );
    expect(expoPushErrorMessage(undefined, 502)).toBe("expo push failed (502)");
    expect(
      expoPushErrorMessage(
        { data: { status: "error", details: { error: "DeviceNotRegistered" } } },
        200,
      ),
    ).toBe("DeviceNotRegistered");
  });
});

describe("expo push", () => {
  it("removes a registered token", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    await deletePushToken(dataDir, "user-1");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBeUndefined();
  });

  it("does not call Expo when the user has no token", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir);
    await push.send(
      { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
      {
        operationId: "n",
        traceId: "n",
        spaceId: "w",
        userId: "missing",
        signal: new AbortController().signal,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to Expo when a token is registered", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { status: "ok", id: "ticket" } }));
    vi.stubGlobal("fetch", fetchMock);
    const push = new ExpoPushProvider(dataDir);
    await push.send(
      { kind: "takeover", title: "Need you", body: "on screen", botId: "bot-1", threadId: "th-1" },
      notifyContext,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://exp.host/--/api/v2/push/send");
    const body = JSON.parse(String(init.body)) as {
      to: string;
      title: string;
      collapseId: string;
      tag: string;
      data: { kind: string };
    };
    expect(body.to).toBe("ExponentPushToken[test]");
    expect(body.title).toBe("Need you");
    expect(body.collapseId).toBe("th-1");
    expect(body.tag).toBe("th-1");
    expect(body.data.kind).toBe("takeover");
  });

  it("throws when Expo rejects the request", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "boom" }] }, 500)),
    );
    const push = new ExpoPushProvider(dataDir);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("boom");
  });

  it("throws when the Expo request never reaches the network", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[test]");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const push = new ExpoPushProvider(dataDir);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("offline");
  });

  it("reports DeviceNotRegistered without deleting a stored or replacement token", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-push-"));
    dirs.push(dataDir);
    await savePushToken(dataDir, "user-1", "ExponentPushToken[old]");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await savePushToken(dataDir, "user-1", "ExponentPushToken[new]");
        return jsonResponse({
          data: { status: "error", details: { error: "DeviceNotRegistered" } },
        });
      }),
    );
    const push = new ExpoPushProvider(dataDir);
    await expect(
      push.send(
        { kind: "completion", title: "done", body: "ok", botId: "b", threadId: "t" },
        notifyContext,
      ),
    ).rejects.toThrow("DeviceNotRegistered");
    await expect(loadPushToken(dataDir, "user-1")).resolves.toBe("ExponentPushToken[new]");
  });
});
