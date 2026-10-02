import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

describe.skipIf(process.env.RUN_COMPUTER_REPLAY_DOCKER !== "1")(
  "computer image user identity",
  () => {
    it.each(["1000:1000", "23456:23457"])(
      "resolves %s for startup and Docker exec without root",
      (user) => {
        const name = `rakazo-user-test-${randomUUID()}`;
        const [uid, gid] = user.split(":");
        try {
          execFileSync(
            "docker",
            [
              "run",
              "--detach",
              "--name",
              name,
              "--user",
              user,
              "--network",
              "none",
              "--read-only",
              "--cap-drop",
              "ALL",
              "--security-opt",
              "no-new-privileges=true",
              "--tmpfs",
              "/tmp:mode=1777",
              "--tmpfs",
              `/home/rakazo:uid=${uid},gid=${gid},mode=700`,
              process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local",
            ],
            { stdio: "pipe", timeout: 30_000 },
          );
          const result = execFileSync(
            "docker",
            [
              "exec",
              name,
              "bash",
              "-euc",
              "for i in $(seq 1 200); do [ -s /tmp/rakazo/dbus-session ] && xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.05; done; " +
                "test -s /tmp/rakazo/dbus-session; xdpyinfo -display :1 >/dev/null; " +
                'getent passwd "$(id -u)"; getent group "$(id -g)"; ' +
                'eval "$(dbus-launch --sh-syntax)"; test -n "$DBUS_SESSION_BUS_ADDRESS"; ' +
                'kill "$DBUS_SESSION_BUS_PID"',
            ],
            { encoding: "utf8", timeout: 15_000 },
          );
          expect(result).toContain(`:x:${uid}:${gid}:`);
          expect(result).toContain(`:x:${gid}:`);
        } finally {
          execFileSync("docker", ["rm", "--force", name], { stdio: "pipe", timeout: 30_000 });
        }
      },
      60_000,
    );
  },
);
