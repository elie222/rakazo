import type { AdapterContext, CloudAgentProvider } from "@rakazo/adapter-kit";

function parseImages(raw: unknown) {
  if (!Array.isArray(raw)) return undefined;
  const images = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.url === "string" && record.url.trim()) {
      try {
        if (new URL(record.url.trim()).protocol === "https:") {
          images.push({ url: record.url.trim() });
        }
      } catch {
        // ignore non-https / invalid image urls
      }
      continue;
    }
    if (typeof record.data === "string" && typeof record.mimeType === "string") {
      images.push({ data: record.data, mimeType: record.mimeType });
    }
  }
  return images.length > 0 ? images : undefined;
}

function parseEnvironment(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") environment[key] = value;
  }
  return Object.keys(environment).length > 0 ? environment : undefined;
}

export async function cloudAgentLaunchFromTool(
  provider: CloudAgentProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) return { error: "prompt is required" };
  try {
    const result = await provider.launch(
      {
        prompt,
        repository:
          typeof args.repository === "string" && args.repository.trim()
            ? args.repository.trim()
            : undefined,
        images: parseImages(args.images),
        environment: parseEnvironment(args.environment),
        openPr: args.openPr === undefined ? undefined : Boolean(args.openPr),
        signal: context.signal,
      },
      context,
    );
    return result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function cloudAgentStatusFromTool(
  provider: CloudAgentProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const id = String(args.id ?? "").trim();
  if (!id) return { error: "id is required" };
  try {
    return await provider.get(id, context);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function cloudAgentReplyFromTool(
  provider: CloudAgentProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const id = String(args.id ?? "").trim();
  const prompt = String(args.prompt ?? "").trim();
  if (!id) return { error: "id is required" };
  if (!prompt) return { error: "prompt is required" };
  try {
    return await provider.reply(
      id,
      {
        prompt,
        images: parseImages(args.images),
        signal: context.signal,
      },
      context,
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function cloudAgentCancelFromTool(
  provider: CloudAgentProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const id = String(args.id ?? "").trim();
  if (!id) return { error: "id is required" };
  try {
    return await provider.cancel(id, context);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
