import { isDeepStrictEqual } from "node:util";
import type { PageState } from "@rakazo/contracts";
import {
  PAGE_STATE_KEY,
  PAGE_STATE_MAX_BYTES,
  PAGE_STATE_MAX_KEYS,
  PageStateSchema,
  pageStateBytes,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import * as z from "zod";
import { readJsonColumn } from "../database/json-column.js";
import type { Prisma } from "../generated/prisma/client.js";

type Db = Prisma.TransactionClient;

export class PageStateLimitError extends ClientError {
  constructor(message: string) {
    super("BAD_REQUEST", message, "PAGE_STATE_LIMIT");
    this.name = "PageStateLimitError";
  }
}

const column = (id: string) => ({ table: "page_reader_states", column: "values", id });

const StoredPageState = z
  .array(z.tuple([z.string().regex(PAGE_STATE_KEY), z.unknown()]))
  .transform((entries) => Object.fromEntries(entries))
  .pipe(PageStateSchema);

export async function readPageState(db: Db, pageId: string, userId: string): Promise<PageState> {
  const row = await db.pageReaderState.findUnique({
    where: { pageId_userId: { pageId, userId } },
    select: { id: true, values: true },
  });
  return row ? readJsonColumn(StoredPageState, row.values, column(row.id), { fallback: {} }) : {};
}

export function fitPageState(saved: PageState, values: PageState): PageState {
  const changed = Object.keys(values);
  let kept = [...Object.keys(saved).filter((key) => !Object.hasOwn(values, key)), ...changed];
  const pick = (keys: string[]) =>
    Object.fromEntries(
      keys.map((key) => [key, Object.hasOwn(values, key) ? values[key] : saved[key]]),
    );
  while (
    kept.length > changed.length &&
    (kept.length > PAGE_STATE_MAX_KEYS || pageStateBytes(pick(kept)) > PAGE_STATE_MAX_BYTES)
  ) {
    kept = kept.slice(1);
  }
  return pick(kept);
}

export async function savePageState(
  db: Db,
  page: { id: string; spaceId: string },
  userId: string,
  values: PageState,
): Promise<boolean> {
  const row = await db.pageReaderState.findUnique({
    where: { pageId_userId: { pageId: page.id, userId } },
    select: { id: true, values: true },
  });
  const saved = row ? readJsonColumn(StoredPageState, row.values, column(row.id), "reject") : {};
  const merged = fitPageState(saved, values);
  if (row && isDeepStrictEqual(merged, saved)) return false;
  const checked = PageStateSchema.safeParse(merged);
  if (!checked.success) {
    throw new PageStateLimitError(checked.error.issues[0]?.message ?? "Too much to save");
  }
  if (row) {
    await db.pageReaderState.update({
      where: { id: row.id },
      data: { values: Object.entries(merged) as Prisma.InputJsonArray },
    });
  } else {
    await db.pageReaderState.create({
      data: {
        pageId: page.id,
        userId,
        spaceId: page.spaceId,
        values: Object.entries(merged) as Prisma.InputJsonArray,
      },
    });
  }
  return true;
}
