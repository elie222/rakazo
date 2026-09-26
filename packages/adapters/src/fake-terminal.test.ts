import { encodeTerminalInput, encodeTerminalResize } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FakeTerminalGateway } from "./fake-terminal.js";

const gateways: FakeTerminalGateway[] = [];
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.close();
});

async function connect(cwd = "/home/rakazo/bots/bot-1") {
  const gateway = new FakeTerminalGateway();
  gateways.push(gateway);
  const page = new URL(await gateway.open(cwd));
  const target = new URL(page.searchParams.get("path")!, page);
  target.protocol = "ws:";
  const socket = new WebSocket(target, ["binary"]);
  socket.binaryType = "arraybuffer";
  let output = "";
  socket.addEventListener("message", (event) => {
    output += new TextDecoder().decode(event.data as ArrayBuffer);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const waitFor = async (pattern: RegExp) => {
    for (let i = 0; i < 250; i += 1) {
      if (pattern.test(output)) return output;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`fake terminal output did not match ${pattern}: ${JSON.stringify(output)}`);
  };
  return { socket, waitFor };
}

describe("fake terminal gateway", () => {
  it("speaks the terminal frame protocol over a websocket", async () => {
    const { socket, waitFor } = await connect();
    await waitFor(/^\$ $/);
    socket.send(encodeTerminalResize(132, 40));
    // Split input across frames the way keystrokes arrive from xterm.
    for (const key of ["echo hel", "lo\r", "stty size\r", "pwd\r", "ls\r"]) {
      socket.send(encodeTerminalInput(key));
    }
    const output = await waitFor(/command not found\r\n\$ $/);
    expect(output).toContain("$ echo hello\r\nhello\r\n");
    expect(output).toContain("$ stty size\r\n40 132\r\n");
    expect(output).toContain("$ pwd\r\n/home/rakazo/bots/bot-1\r\n");
    expect(output).toContain("fake-shell: ls: command not found");
  });

  it("rejects unknown tokens", async () => {
    const gateway = new FakeTerminalGateway();
    gateways.push(gateway);
    const page = new URL(await gateway.open("/home/rakazo"));
    const socket = new WebSocket(`ws://${page.host}/websockify?token=guess`);
    await expect(
      new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("refused")), { once: true });
      }),
    ).rejects.toThrow("refused");
  });
});
