import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Generate an offline TLS identity per suite; never store private keys in source. */
export function createTestTlsIdentity(): { key: string; cert: string } {
  const directory = mkdtempSync(join(tmpdir(), "rakazo-proxy-test-"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  const config = join(directory, "openssl.cnf");
  try {
    writeFileSync(
      config,
      `[req]
prompt = no
distinguished_name = subject
x509_extensions = extensions
[subject]
CN = proxy.example.test
[extensions]
basicConstraints = critical,CA:TRUE
subjectAltName = DNS:proxy.example.test,DNS:private.example.test
`,
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        key,
        "-out",
        cert,
        "-config",
        config,
      ],
      { stdio: "pipe" },
    );
    return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
