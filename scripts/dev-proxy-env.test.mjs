import assert from "node:assert/strict";
import test from "node:test";
import { applyProxyEnv } from "./dev-proxy-env.mjs";

test("hands .env proxy settings to the services", () => {
  const env = applyProxyEnv({}, { HTTPS_PROXY: "http://proxy.example.com:3128" });
  assert.equal(env.HTTPS_PROXY, "http://proxy.example.com:3128");
});

test("reads lowercase names too, as outbound-proxy settings arrive either way", () => {
  const env = applyProxyEnv(
    {},
    {
      http_proxy: "http://proxy.example.com:3128",
      https_proxy: "http://proxy.example.com:3128",
      no_proxy: "localhost,127.0.0.1",
      node_use_env_proxy: "1",
    },
  );
  assert.deepEqual(env, {
    HTTP_PROXY: "http://proxy.example.com:3128",
    HTTPS_PROXY: "http://proxy.example.com:3128",
    NO_PROXY: "localhost,127.0.0.1",
    NODE_USE_ENV_PROXY: "1",
  });
});

test("keeps what the shell set", () => {
  const env = applyProxyEnv(
    { HTTPS_PROXY: "http://shell.example.com:8080" },
    { HTTPS_PROXY: "http://proxy.example.com:3128" },
  );
  assert.equal(env.HTTPS_PROXY, "http://shell.example.com:8080");
});

test("an empty .env value leaves the setting unset", () => {
  const env = applyProxyEnv({}, { HTTP_PROXY: "", NODE_USE_ENV_PROXY: "" });
  assert.deepEqual(env, {});
});
