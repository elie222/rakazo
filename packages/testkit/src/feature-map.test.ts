import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadIosScreenshotCatalog, mobileAppRoutes } from "./ios-screenshot-catalog.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MAP = ".agents/skills/verify-app/features.json";
const ROUTE_TABLE = "apps/web/src/App.tsx";
const OVERLAYS = "apps/web/src/pages/shell-overlay.ts";
const MOBILE_APP = "apps/mobile/app";
const IOS_CATALOG = "apps/mobile/e2e/ios-screenshots";
const SPEC_DIRS = ["apps/web/e2e", "apps/desktop/e2e"];

const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const quoted = (source: string) =>
  [...source.matchAll(/"([^"]+)"/g)].flatMap((match) => match[1] ?? []);

const reason = z.string().trim().min(1);
const featureMap = z.strictObject({
  features: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      name: z.string().trim().min(1),
      web: z.array(z.string()).min(1).nullable(),
      mobile: z.array(z.string()).min(1).nullable(),
      desktop: z.string().trim().min(1).nullable(),
      evidence: z.array(z.string()),
      product: z.string().nullable(),
    }),
  ),
  uncovered: z.strictObject({
    web: z.record(z.string(), reason),
    mobile: z.record(z.string(), reason),
    evidence: z.record(z.string(), reason),
  }),
});
const map = featureMap.parse(JSON.parse(read(MAP)));
/** Overlays a `desktop` text names, such as `?settings=updates`: shared UI only the desktop app enables. */
const desktopOnly = map.features.flatMap(
  (feature) => feature.desktop?.match(/(?<!\S)\?[\w=-]+/g) ?? [],
);

/** A path the route table takes from a constant, read from the file that exports it. */
function importedPath(source: string, name: string): string {
  const from = [...source.matchAll(/import \{([^}]+)\} from "(\.[^"]+)"/g)].find((match) =>
    match[1]?.split(",").some((imported) => imported.trim() === name),
  )?.[2];
  const value =
    from &&
    read(path.join(path.dirname(ROUTE_TABLE), `${from}.ts`)).match(
      new RegExp(`export const ${name} = "([^"]+)"`),
    )?.[1];
  if (!value) throw new Error(`${ROUTE_TABLE} routes ${name}, which is not an exported string`);
  return value;
}

/** Every path the web app answers, in the spelling the route table uses. */
function webRoutes(): string[] {
  const source = read(ROUTE_TABLE);
  const literal = [...source.matchAll(/\bpath="([^"]+)"/g)].flatMap((match) => match[1] ?? []);
  const named = [...source.matchAll(/\bpath=\{([A-Z_]+)\}/g)].map((match) =>
    importedPath(source, match[1] ?? ""),
  );
  const lists = [...source.matchAll(/\{\[([^\]]+)\]\.map\(\(path\) =>/g)].map((match) =>
    quoted(match[1] ?? ""),
  );
  const beforeRouter = [
    ...source.matchAll(/window\.location\.pathname === (?:"([^"]+)"|([A-Z_]+))/g),
  ].map((match) => match[1] ?? importedPath(source, match[2] ?? ""));
  const declared = source.match(/\bpath=/g)?.length ?? 0;
  const fromLists = source.match(/\bpath=\{path\}/g)?.length ?? 0;
  if (declared !== literal.length + named.length + lists.length || fromLists !== lists.length) {
    throw new Error(
      `${ROUTE_TABLE} declares a route in a form webRoutes() in packages/testkit/src/feature-map.test.ts cannot read; teach it the new form`,
    );
  }
  return [...new Set([...beforeRouter, ...literal, ...named, ...lists.flat()])];
}

/** Settings sections as `?settings=<section>` and the other shell overlays as `?<kind>`. */
function webOverlays(): string[] {
  const source = read(OVERLAYS);
  const sections = quoted(source.match(/const SETTINGS_SECTIONS = \[([^\]]+)\]/)?.[1] ?? "");
  const kinds = [
    ...(source.match(/export type ShellOverlay =([\s\S]+?)\| null;/)?.[1] ?? "").matchAll(
      /kind: "([^"]+)"/g,
    ),
  ].flatMap((match) => match[1] ?? []);
  if (!sections.length || !kinds.includes("settings") || kinds.length < 2) {
    throw new Error(
      `${OVERLAYS} no longer declares SETTINGS_SECTIONS and ShellOverlay the way webOverlays() in packages/testkit/src/feature-map.test.ts reads them; update it`,
    );
  }
  return [
    ...sections.map((section) => `?settings=${section}`),
    ...kinds.filter((kind) => kind !== "settings").map((kind) => `?${kind}`),
  ];
}

/** Every spec file and iOS screenshot section, in the spelling `evidence` uses. */
async function evidenceSources(): Promise<string[]> {
  return [
    ...SPEC_DIRS.flatMap((dir) =>
      readdirSync(path.join(root, dir), { encoding: "utf8", recursive: true })
        .filter((file) => file.endsWith(".spec.ts"))
        .map((file) => `${dir}/${file.split(path.sep).join("/")}`),
    ),
    ...(await loadIosScreenshotCatalog(path.join(root, IOS_CATALOG))).map(
      (section) => `ios:${section.id}`,
    ),
  ];
}

function gaps(
  list: "web" | "mobile" | "evidence",
  actual: string[],
  source: string,
  desktop?: string[],
): string[] {
  const claimed = [...map.features.flatMap((feature) => feature[list] ?? []), ...(desktop ?? [])];
  const uncovered = Object.keys(map.uncovered[list]);
  return [
    ...actual
      .filter((entry) => !claimed.includes(entry) && !uncovered.includes(entry))
      .map(
        (entry) =>
          `"${entry}" is in ${source} but not in ${MAP}: add it to the "${list}" list of the feature it belongs to (or add a feature for it), ${desktop ? `or name it in that feature's "desktop" text if only the desktop app enables it, ` : ""}or to "uncovered.${list}" with a one-line reason`,
      ),
    ...[...claimed, ...uncovered]
      .filter((entry) => !actual.includes(entry))
      .map(
        (entry) =>
          `${MAP} lists "${entry}" under ${desktop?.includes(entry) ? "desktop" : list}, but ${source} has nothing by that name: rename or remove it`,
      ),
    ...uncovered
      .filter((entry) => claimed.includes(entry))
      .map(
        (entry) =>
          `"${entry}" is in a feature's "${list}" list and in "uncovered.${list}" in ${MAP}: remove it from uncovered`,
      ),
  ];
}

describe("feature map", () => {
  it("gives every feature its own id", () => {
    const ids = map.features.map((feature) => feature.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it("claims every web route, settings section, and overlay, or says why not", () => {
    expect(
      gaps("web", [...webRoutes(), ...webOverlays()], `${ROUTE_TABLE} or ${OVERLAYS}`, desktopOnly),
    ).toEqual([]);
  });

  it("claims every mobile screen or says why not", async () => {
    expect(gaps("mobile", await mobileAppRoutes(path.join(root, MOBILE_APP)), MOBILE_APP)).toEqual(
      [],
    );
  });

  it("maps every spec and iOS screenshot section to a feature or says why not", async () => {
    expect(
      gaps(
        "evidence",
        await evidenceSources(),
        `${SPEC_DIRS.join(", ")} or ${IOS_CATALOG}/catalog.json`,
      ),
    ).toEqual([]);
  });

  it("names iOS sections that capture the feature's screens", async () => {
    const sections = await loadIosScreenshotCatalog(path.join(root, IOS_CATALOG));
    expect(
      map.features.flatMap((feature) =>
        sections
          .filter(
            (section) =>
              feature.evidence.includes(`ios:${section.id}`) &&
              !section.screens.some((screen) => feature.mobile?.includes(screen)),
          )
          .map(
            (section) =>
              `${feature.id}: section "${section.id}" captures none of this feature's "mobile" screens; name a section that does or remove it`,
          ),
      ),
    ).toEqual([]);
  });

  it("links PRODUCT.md sections that exist", () => {
    const anchors = [...read("PRODUCT.md").matchAll(/^#+ (.+)$/gm)].map(
      (match) =>
        `PRODUCT.md#${(match[1] ?? "")
          .toLowerCase()
          .replace(/[^\w -]/g, "")
          .replace(/ /g, "-")}`,
    );
    expect(
      map.features
        .filter((feature) => feature.product && !anchors.includes(feature.product))
        .map(
          (feature) =>
            `${feature.id}: "${feature.product}" is not a heading in PRODUCT.md; use one of ${anchors.join(", ")} or null`,
        ),
    ).toEqual([]);
  });
});
