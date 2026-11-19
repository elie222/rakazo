import { createRunSandbox } from "./../computers/sandbox/host-aware-sandbox.js";
import type { ComputerInitializationConnection } from "./computer-initialization.js";

/** Compose optional user model initialization after the generic computer provider is selected. */
export async function createInitializedRunSandbox(
  kind: string,
  {
    initialization,
    ...options
  }: Parameters<typeof createRunSandbox>[1] & {
    initialization?: ComputerInitializationConnection;
  },
) {
  const sandbox = await createRunSandbox(kind, options);
  if (
    !initialization ||
    !options.prisma ||
    !options.secrets ||
    kind === "desktop" ||
    kind === "fake"
  )
    return sandbox;
  const { withComputerModelInitialization } = await import("./computer-initialization.js");
  return withComputerModelInitialization(sandbox, options.prisma, initialization);
}
