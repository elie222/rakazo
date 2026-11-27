import { generateKeyPairSync, randomBytes } from "node:crypto";
import { parse } from "shell-quote";
import { describe, expect, it } from "vitest";
import { ExeSdkClient, parseKey, userAgent } from "./exe-client.js";

/** An unencrypted OpenSSH ed25519 private key, as ssh-keygen writes one. */
function opensshKey(): string {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const pub = Buffer.from(jwk.x!, "base64url");
  const priv = Buffer.from(jwk.d!, "base64url");
  const string = (data: string | Buffer) => {
    const bytes = Buffer.from(data);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const uint32 = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };
  const publicBlob = Buffer.concat([string("ssh-ed25519"), string(pub)]);
  let section = Buffer.concat([
    uint32(7),
    uint32(7),
    string("ssh-ed25519"),
    string(pub),
    string(Buffer.concat([priv, pub])),
    string("test"),
  ]);
  for (let pad = 1; section.length % 8; pad++)
    section = Buffer.concat([section, Buffer.from([pad])]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    string("none"),
    string("none"),
    string(""),
    uint32(1),
    string(publicBlob),
    string(section),
  ]).toString("base64");
  const lines = body.match(/.{1,70}/g)!.join("\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

interface Request {
  token: string;
  agent: string;
  argv: string[];
}

/** exe.dev's /exec endpoint, answering each command as the real one does. */
function fakeApi(answer: (argv: string[]) => unknown = () => ({})) {
  const requests: Request[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const argv = parse(String(init?.body)).map(String);
    requests.push({
      token: headers.get("Authorization")!.replace(/^Bearer /, ""),
      agent: headers.get("User-Agent") ?? "",
      argv,
    });
    const answered = answer(argv);
    if (argv[0] === "ssh") {
      const frames = Array.isArray(answered) ? answered : [{ exit_code: 0 }];
      return new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""), {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    return Response.json(answered);
  };
  return { requests, fetch: fetch as typeof globalThis.fetch };
}

function payload(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
}

const signal = new AbortController().signal;
const listed = {
  vm_name: "rakazo-box",
  ssh_dest: "rakazo-box.exe.xyz",
  https_url: "https://rakazo-box.exe.xyz",
  status: "running",
  comment: "rakazo computer for bot bot-a",
  tags: ["rakazo"],
};

describe("parseKey", () => {
  const key = opensshKey();

  it("takes an API token", () => {
    expect(parseKey(" exe1.AbC_d-9 \n")).toEqual({ token: "exe1.AbC_d-9" });
    expect(parseKey("exe0.e30.c2ln")).toEqual({ token: "exe0.e30.c2ln" });
  });

  it.each([
    ["with its line breaks", key],
    ["with \\n escapes", key.replaceAll("\n", "\\n")],
    ["on one line", key.replaceAll("\n", "")],
  ])("takes a private key %s", (_case, value) => {
    expect(parseKey(value)).toEqual({ privateKey: key });
  });

  it("refuses anything else", () => {
    expect(() => parseKey("ssh-ed25519 AAAA public")).toThrow("EXE_SANDBOX_KEY");
  });
});

describe("userAgent", () => {
  it("names Rakazo and the commit it was built from", () => {
    expect(userAgent("5f66c817a1b2c3d4e5f6")).toBe("rakazo/5f66c817a1b2");
    expect(userAgent("unknown")).toBe("rakazo");
    expect(userAgent("")).toBe("rakazo");
  });
});

describe("ExeSdkClient", () => {
  it("sends an API token as it is", async () => {
    const api = fakeApi(() => ({ vms: [listed] }));
    const client = await ExeSdkClient.create("exe1.token", api.fetch);
    expect(await client.list(signal)).toEqual([
      {
        name: "rakazo-box",
        host: "rakazo-box.exe.xyz",
        status: "running",
        comment: "rakazo computer for bot bot-a",
        tags: ["rakazo"],
      },
    ]);
    expect(api.requests).toEqual([
      {
        token: "exe1.token",
        agent: expect.stringMatching(/^rakazo(\/\w+)? exedev-js\//),
        argv: ["ls"],
      },
    ]);
  });

  it("signs short-lived API tokens for only its commands with an SSH key", async () => {
    const api = fakeApi(() => ({ vms: [] }));
    const client = await ExeSdkClient.create(opensshKey().replaceAll("\n", "\\n"), api.fetch);
    expect(await client.get("rakazo-box", signal)).toBeUndefined();
    const token = api.requests[0]!.token;
    expect(token).toMatch(/^exe0\./);
    const { exp, cmds } = payload(token);
    expect(cmds).toEqual(["new", "ls", "ssh", "rm"]);
    expect(exp * 1000).toBeGreaterThan(Date.now());
    expect(exp * 1000).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
  });

  it("creates a standalone VM that it waits for itself", async () => {
    const api = fakeApi(() => ({ ...listed, ssh_port: 22, proxy_port: 6080 }));
    const client = await ExeSdkClient.create("exe1.token", api.fetch);
    const created = await client.create(
      {
        name: "rakazo-box",
        image: "ghcr.io/elie222/rakazo/computer:v1",
        comment: "rakazo computer for bot bot-a",
        cpus: 4,
      },
      signal,
    );
    expect(created.host).toBe("rakazo-box.exe.xyz");
    const argv = api.requests[0]!.argv;
    expect(argv[0]).toBe("new");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--name=rakazo-box",
        "--image=ghcr.io/elie222/rakazo/computer:v1",
        "--sandbox",
        "--no-email",
        "--comment=rakazo computer for bot bot-a",
        "--cpu=4",
      ]),
    );
    expect(argv.some((arg) => arg.startsWith("--tag"))).toBe(false);
  });

  it("counts a VM that is already gone as deleted", async () => {
    const api = fakeApi(() => ({ deleted: [], failed: ["rakazo-box"], not_found: ["rakazo-box"] }));
    const client = await ExeSdkClient.create("exe1.token", api.fetch);
    await expect(client.remove("rakazo-box", signal)).resolves.toBeUndefined();
  });

  it("reports a VM it could not delete", async () => {
    const api = fakeApi(() => ({
      deleted: [],
      failed: ["rakazo-box"],
      errors: { "rakazo-box": "busy" },
    }));
    const client = await ExeSdkClient.create("exe1.token", api.fetch);
    await expect(client.remove("rakazo-box", signal)).rejects.toThrow("busy");
  });

  it("streams a script's output and returns its exit status", async () => {
    const api = fakeApi(() => [
      { stdout: Buffer.from("out").toString("base64") },
      { stderr: Buffer.from("err").toString("base64") },
      { exit_code: 3 },
    ]);
    const client = await ExeSdkClient.create("exe1.token", api.fetch);
    const output: string[] = [];
    const code = await client.run("rakazo-box", "echo hi", {
      signal,
      stdout: (data) => output.push(`out:${data}`),
      stderr: (data) => output.push(`err:${data}`),
    });
    expect(code).toBe(3);
    expect(output).toEqual(["out:out", "err:err"]);
    expect(api.requests[0]!.argv).toEqual(["ssh", "rakazo-box", "echo hi"]);
  });

  it("hands input to a script through files on disk that the script removes", async () => {
    const api = fakeApi();
    const client = await ExeSdkClient.create("exe1.token", api.fetch);
    await client.run("rakazo-box", "cat >/tmp/x", {
      stdin: [Buffer.from("hel"), Buffer.from("lo")],
      signal,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    const scripts = api.requests.map((request) => request.argv[2]!);
    const run = scripts.at(-1)!;
    const input = /^cat (\/var\/tmp\/rakazo-input-[0-9a-f]{16})\.\* \|/.exec(run)?.[1];
    expect(input).toBeDefined();
    expect(run).toBe(`cat ${input}.* | (cat >/tmp/x); status=$?; rm -f ${input}.*; exit $status`);
    // The SDK writes the one part before the script runs, and nothing runs after it.
    expect(scripts.slice(0, -1).every((script) => script.includes(`${input}.000000`))).toBe(true);
  });

  it("uploads large input one bounded part at a time", async () => {
    const api = fakeApi();
    const client = await ExeSdkClient.create("exe1.token", api.fetch);
    const mib = Buffer.from(randomBytes(1024 * 1024));
    await client.run("rakazo-box", "cat >/tmp/x", {
      stdin: Array.from({ length: 6 }, () => mib),
      signal,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    const scripts = api.requests.map((request) => request.argv[2]!).join("\n");
    expect(scripts).toContain(".000000");
    expect(scripts).toContain(".000001");
    expect(scripts).not.toContain(".000002");
  });

  it("runs a script with empty input without uploading anything", async () => {
    const api = fakeApi();
    const client = await ExeSdkClient.create("exe1.token", api.fetch);
    await client.run("rakazo-box", "cat", {
      stdin: [],
      signal,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(api.requests.map((request) => request.argv[2])).toEqual(["(cat) </dev/null"]);
  });

  it("removes the input when the script cannot run", async () => {
    const api = fakeApi((argv) => {
      if (argv[2]?.startsWith("cat ")) throw new Error("connection reset");
      return {};
    });
    const client = await ExeSdkClient.create("exe1.token", api.fetch);
    await expect(
      client.run("rakazo-box", "cat >/tmp/x", {
        stdin: [Buffer.from("hello")],
        signal,
        stdout: () => undefined,
        stderr: () => undefined,
      }),
    ).rejects.toThrow();
    const last = api.requests.at(-1)!.argv;
    expect(last.slice(0, 2)).toEqual(["ssh", "rakazo-box"]);
    expect(last[2]).toMatch(/^rm -f \/var\/tmp\/rakazo-input-[0-9a-f]{16}\.\*$/);
  });

  it("signs a VM token locally with an SSH key", async () => {
    const api = fakeApi();
    const client = await ExeSdkClient.create(opensshKey(), api.fetch);
    const token = await client.vmToken("rakazo-box", 1_900_000_000, signal);
    expect(token).toMatch(/^exe0\./);
    expect(payload(token)).toEqual({ exp: 1_900_000_000 });
    expect(api.requests).toEqual([]);
  });

  it("asks exe.dev for a VM token with an API token", async () => {
    const api = fakeApi(() => ({ token: "exe1.vm" }));
    const client = await ExeSdkClient.create("exe1.token", api.fetch);
    const expiresAt = Math.floor(Date.now() / 1000) + 2 * 3600;
    expect(await client.vmToken("rakazo-box", expiresAt, signal)).toBe("exe1.vm");
    expect(api.requests[0]!.argv).toEqual([
      "ssh-key",
      "generate-api-key",
      "--vm=rakazo-box",
      "--label=rakazo-screen-rakazo-box",
      "--exp=24h",
    ]);
    // Each one adds a key to the account, so one serves the VM's screens while it lasts.
    expect(await client.vmToken("rakazo-box", expiresAt + 3600, signal)).toBe("exe1.vm");
    expect(api.requests).toHaveLength(1);
    await client.vmToken("rakazo-box", expiresAt + 30 * 3600, signal);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]!.argv.at(-1)).toBe("--exp=32h");
  });

  it("refuses a key it cannot use", async () => {
    await expect(ExeSdkClient.create("not a key")).rejects.toThrow("EXE_SANDBOX_KEY");
    const broken = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    await expect(ExeSdkClient.create(broken)).rejects.toThrow();
  });
});
