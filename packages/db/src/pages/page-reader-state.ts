import { isDeepStrictEqual } from "node:util";
import type { PageState } from "@rakazo/contracts";
import { PageStateSchema } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
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

export async function readPageState(db: Db, pageId: string, userId: string): Promise<PageState> {
  const row = await db.pageReaderState.findUnique({
    where: { pageId_userId: { pageId, userId } },
    select: { id: true, values: true },
  });
  return row ? readJsonColumn(PageStateSchema, row.values, column(row.id), { fallback: {} }) : {};
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
  const saved = row ? readJsonColumn(PageStateSchema, row.values, column(row.id), "reject") : {};
  const merged = { ...saved, ...values };
  if (row && isDeepStrictEqual(merged, saved)) return false;
  const checked = PageStateSchema.safeParse(merged);
  if (!checked.success) {
    throw new PageStateLimitError(checked.error.issues[0]?.message ?? "Too much to save");
  }
  if (row) {
    await db.pageReaderState.update({
      where: { id: row.id },
      data: { values: merged as Prisma.InputJsonObject },
    });
  } else {
    await db.pageReaderState.create({
      data: {
        pageId: page.id,
        userId,
        spaceId: page.spaceId,
        values: merged as Prisma.InputJsonObject,
      },
    });
  }
  return true;
}
