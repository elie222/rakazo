import { afterEach, describe, expect, it } from "vitest";
import {
  assertAllowedOpenAiCompatibleRequestUrl,
  assertAllowedOpenAiCompatibleUrl,
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatAllowPublicHosts,
} from "./openai-compatible-url.js";

const savedAllowPublic = process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;

afterEach(() => {
  if (savedAllowPublic === undefined) delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
  else process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = savedAllowPublic;
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
  });

  it("rejects public hosts unless explicitly allowed", () => {
    delete process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC;
    expect(openAiCompatAllowPublicHosts()).toBe(false);
    expect(() => assertAllowedOpenAiCompatibleUrl("https://api.example.com/v1")).toThrow(
      /Public model endpoints are blocked/,
    );

    process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC = "1";
    expect(assertAllowedOpenAiCompatibleUrl("https://api.example.com/v1").href).toBe(
      "https://api.example.com/v1",
    );
  });
});
