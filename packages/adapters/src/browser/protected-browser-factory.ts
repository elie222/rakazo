import type { ProtectedBrowserLauncher } from "./protected-browser.js";

export async function configuredProtectedBrowser(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProtectedBrowserLauncher | undefined> {
  const image = env.PROTECTED_BROWSER_IMAGE?.trim();
  const seccompProfile = env.PROTECTED_BROWSER_SECCOMP_PROFILE?.trim();
  if (!image || !seccompProfile) return undefined;

  const { createProtectedBrowserLauncher } = await import(
    "../providers/browser/docker/docker-protected-browser.js"
  );
  return createProtectedBrowserLauncher({ image, seccompProfile });
}
