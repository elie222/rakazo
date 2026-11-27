// Internal, persisted runtime code. The router treats it as an opaque id.
export const nativeTextRuntime = {
  id: "claude-agent",
  provider: "anthropic",
  load: () => import("./runtime.js"),
};
