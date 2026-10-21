import { afterEach, describe, expect, it } from "vitest";
import {
  assertAllowedOpenAiCompatibleRequestUrl,
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatAllowPublicHosts,
} from "./openai-compatible-url.js";

const savedAllowPublic = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
const savedPrivateHosts = process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS;

afterEach(() => {
  if (savedAllowPublic === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
  else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = savedAllowPublic;
  if (savedPrivateHosts === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS;
  else process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS = savedPrivateHosts;
});

describe("openai-compatible URL policy", () => {
  it("normalizes missing /v1 suffix without doubling it", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:8000")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:8000/v1")).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:8000/v1/")).toBe(
      "http://127.0.0.1:8000/v1",
    );
  });

  it("treats any /vN versioned API root as complete (no /v1 append)", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:8000/v4")).toBe(
      "http://127.0.0.1:8000/v4",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:8000/v2")).toBe(
      "http://127.0.0.1:8000/v2",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:8000/v3")).toBe(
      "http://127.0.0.1:8000/v3",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:8000/v10")).toBe(
      "http://127.0.0.1:8000/v10",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("https://open.bigmodel.cn/api/paas/v4")).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("https://open.bigmodel.cn/api/paas/v4/")).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
    expect(normalizeOpenAiCompatibleBaseUrl("http://127.0.0.1:8000/api")).toBe(
      "http://127.0.0.1:8000/api/v1",
    );
  });

  it("allows public bigmodel host when ALLOW_PUBLIC=1 without rewriting /v4", () => {
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    expect(assertAllowedOpenAiCompatibleUrl("https://open.bigmodel.cn/api/paas/v4").href).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
  });

  it("validates request URLs without changing their path", () => {
    expect(
      assertAllowedOpenAiCompatibleRequestUrl("http://127.0.0.1:8000/v1/chat/completions").href,
    ).toBe("http://127.0.0.1:8000/v1/chat/completions");
  });

  it("rejects non-http(s) and credential-bearing URLs", () => {
    expect(() => normalizeOpenAiCompatibleBaseUrl("file:///tmp/sock")).toThrow(/http or https/);
    expect(() => normalizeOpenAiCompatibleBaseUrl("http://user:pass@127.0.0.1:8000/v1")).toThrow(
      /credentials/,
    );
  });

  it("allows loopback and RFC1918 hosts by default", () => {
    expect(assertAllowedOpenAiCompatibleUrl("http://127.0.0.1:8000/v1").href).toBe(
      "http://127.0.0.1:8000/v1",
    );
    expect(assertAllowedOpenAiCompatibleUrl("http://localhost:11434/v1").href).toBe(
      "http://localhost:11434/v1",
    );
    expect(assertAllowedOpenAiCompatibleUrl("http://192.168.1.20:8080/v1").href).toBe(
      "http://192.168.1.20:8080/v1",
    );
    expect(assertAllowedOpenAiCompatibleUrl("http://host.docker.internal:8000/v1").href).toBe(
      "http://host.docker.internal:8000/v1",
    );
    expect(() => assertAllowedOpenAiCompatibleUrl("http://ollama.local:11434/v1")).toThrow(
      /Public model endpoints are blocked/,
    );
  });

  it("blocks metadata and link-local endpoints", () => {
    expect(() =>
      assertAllowedOpenAiCompatibleUrl("http://169.254.169.254/latest/meta-data/"),
    ).toThrow(/blocked metadata or link-local host/);
    expect(() => assertAllowedOpenAiCompatibleUrl("http://169.254.1.1/v1")).toThrow(
      /blocked metadata or link-local host/,
    );
    expect(() => assertAllowedOpenAiCompatibleUrl("http://[fe80::1]/v1")).toThrow(
      /blocked metadata or link-local host/,
    );
    expect(() => assertAllowedOpenAiCompatibleUrl("http://[::ffff:169.254.1.1]/v1")).toThrow(
      /blocked metadata or link-local host/,
    );
    expect(() => assertAllowedOpenAiCompatibleUrl("http://[::169.254.1.1]/v1")).toThrow(
      /blocked metadata or link-local host/,
    );
    expect(() => assertAllowedOpenAiCompatibleUrl("http://metadata.google.internal/")).toThrow(
      /blocked metadata or link-local host/,
    );
    expect(() =>
      assertAllowedOpenAiCompatibleUrl("http://100.100.100.200/latest/meta-data/"),
    ).toThrow(/blocked metadata or link-local host/);
    expect(() =>
      assertAllowedOpenAiCompatibleUrl("http://[::ffff:100.100.100.200]/latest/meta-data/"),
    ).toThrow(/blocked metadata or link-local host/);
    expect(() =>
      assertAllowedOpenAiCompatibleUrl("http://[fd00:ec2::254]/latest/meta-data/"),
    ).toThrow(/blocked metadata or link-local host/);
    expect(() =>
      assertAllowedOpenAiCompatibleUrl(
        "http://[fd00:0ec2:0000:0000:0000:0000:0000:0254]/latest/meta-data/",
      ),
    ).toThrow(/blocked metadata or link-local host/);
  });

  it("allows only exact configured private hostnames without opening the public gate", () => {
    delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS =
      " Models.Example.Test. , other.example.test, , *.wild.example.test";
    for (const hostname of ["models.example.test", "MODELS.EXAMPLE.TEST.", "other.example.test"]) {
      expect(assertAllowedOpenAiCompatibleUrl(`https://${hostname}/v1`).hostname).toBe(
        hostname.toLowerCase(),
      );
    }
    for (const hostname of [
      "sub.models.example.test",
      "models.example.test.evil.test",
      "example.test",
      "sub.wild.example.test",
    ]) {
      expect(() => assertAllowedOpenAiCompatibleUrl(`https://${hostname}/v1`)).toThrow(
        /Public model endpoints are blocked/,
      );
    }
  });

  it("does not let the private hostname allowlist override blocked destinations", () => {
    process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS =
      "metadata.google.internal, metadata.goog, 169.254.169.254, 169.254.1.1";
    for (const hostname of [
      "metadata.google.internal",
      "metadata.goog",
      "169.254.169.254",
      "169.254.1.1",
    ]) {
      expect(() => assertAllowedOpenAiCompatibleUrl(`http://${hostname}/v1`)).toThrow(
        /blocked metadata or link-local host/,
      );
    }
  });

  it("rejects public hosts unless explicitly allowed", () => {
    delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    expect(openAiCompatAllowPublicHosts()).toBe(false);
    expect(() => assertAllowedOpenAiCompatibleUrl("https://api.example.com/v1")).toThrow(
      /Public model endpoints are blocked.*private reverse proxy.*RFC1918/s,
    );

    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    expect(assertAllowedOpenAiCompatibleUrl("https://api.example.com/v1").href).toBe(
      "https://api.example.com/v1",
    );
  });
});

describe("assertHttpsForKeyedOpenAiCompatibleUrl", () => {
  it("rejects public http when an API key is set", () => {
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    const url = assertAllowedOpenAiCompatibleUrl("http://api.example.com/v1");
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, "secret-key")).toThrow(
      /must use HTTPS/,
    );
  });

  it("allows public https when an API key is set", () => {
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    const url = assertAllowedOpenAiCompatibleUrl("https://api.example.com/v1");
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, "secret-key")).not.toThrow();
  });

  it("allows private http when an API key is set", () => {
    const url = assertAllowedOpenAiCompatibleUrl("http://127.0.0.1:8000/v1");
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, "local-secret")).not.toThrow();
    const lan = assertAllowedOpenAiCompatibleUrl("http://192.168.1.20:8080/v1");
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(lan, "local-secret")).not.toThrow();
  });

  it("treats explicitly trusted private hostnames like private IP endpoints", () => {
    process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS = "models.example.test";
    const url = assertAllowedOpenAiCompatibleUrl("http://models.example.test/v1");
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, "fake-local-key")).not.toThrow();
  });

  it("skips the HTTPS check when no API key is set", () => {
    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    const url = assertAllowedOpenAiCompatibleUrl("http://api.example.com/v1");
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, undefined)).not.toThrow();
    expect(() => assertHttpsForKeyedOpenAiCompatibleUrl(url, "  ")).not.toThrow();
  });
});
