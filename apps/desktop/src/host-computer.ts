import { randomBytes } from "node:crypto";
import path from "node:path";
import { startHostComputerServer } from "@rakazo/adapters/host-computer-server";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

/** App-private credentials and consent, never sent to a renderer or a connected remote server. */
export async function prepareHostComputer(userDataDir: string) {
  const configFile = path.join(userDataDir, "host-computer.json");
  const consentFile = path.join(userDataDir, "host-computer-consent");
  const raw = await readPrivateFile(configFile, 1024);
  let token = randomBytes(32).toString("hex");
  let port = 0;
  try {
    const saved = JSON.parse(raw ?? "null");
    if (/^[a-f0-9]{64}$/.test(saved?.token)) token = saved.token;
    if (Number.isInteger(saved?.port) && saved.port >= 1024 && saved.port <= 65535)
      port = saved.port;
  } catch {
    /* Invalid local configuration is replaced. */
  }
  let server: Awaited<ReturnType<typeof startHostComputerServer>>;
  const options = { root: path.join(userDataDir, "computers"), token };
  try {
    server = await startHostComputerServer({ ...options, port });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
    // A listener on the old port may have received the old credential from a still-running backend.
    token = randomBytes(32).toString("hex");
    server = await startHostComputerServer({ ...options, token });
  }
  try {
    await writePrivateFile(configFile, JSON.stringify({ token, port: server.port }));
  } catch (error) {
    await server.close();
    throw error;
  }
  let allowed = (await readPrivateFile(consentFile, 128)) === token;
  let active = false;
  let consentIntent = 0;
  let consentWrites: Promise<void> = Promise.resolve();
  function persistConsent(value: string) {
    const write = consentWrites.then(() => writePrivateFile(consentFile, value));
    consentWrites = write.catch(() => undefined);
    return write;
  }
  return {
    connection: { url: `http://host.docker.internal:${server.port}`, token },
    isEnabled: server.isEnabled,
    activate(value: boolean) {
      active = value;
      server.setEnabled(active && allowed);
    },
    async grant() {
      const intent = ++consentIntent;
      await persistConsent(token);
      if (intent === consentIntent) {
        allowed = true;
        server.setEnabled(active);
      }
    },
    async revoke() {
      // Revoke first, even if persisting the choice fails.
      ++consentIntent;
      allowed = false;
      server.setEnabled(false);
      await persistConsent("");
    },
    close: server.close,
  };
}
