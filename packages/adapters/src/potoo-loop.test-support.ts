/**
 * In-memory doubles for the POTOO night-loop test. Implements only the
 * Prisma and job-queue surface the escalation, repair, and seed paths
 * touch, including P2002 on run clientNonce races.
 */

let seq = 0;
const nextId = (prefix: string) => {
  seq += 1;
  return `test-${prefix}-${seq}`;
};

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]) => {
    if (key === "spaceId_clientNonce") {
      const compound = value as { spaceId: string; clientNonce: string };
      return row.spaceId === compound.spaceId && row.clientNonce === compound.clientNonce;
    }
    if (value !== null && typeof value === "object" && "in" in (value as Record<string, unknown>)) {
      return (value as { in: unknown[] }).in.includes(row[key]);
    }
    return row[key] === value;
  });
}

function ordered(rows: any[], orderBy: any): any[] {
  const [key, dir] = Object.entries(orderBy ?? {})[0] ?? [];
  if (!key) return rows;
  return [...rows].sort((a, b) => (dir === "desc" ? b[key] - a[key] : a[key] - b[key]));
}

export function createFakePotooPrisma() {
  const store: Record<"run" | "task" | "message" | "event" | "routine", any[]> = {
    run: [],
    task: [],
    message: [],
    event: [],
    routine: [],
  };
  const tx = {
    task: {
      create: async ({ data }: any) => {
        const row = { id: nextId("task"), ...data };
        store.task.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        const before = store.task.length;
        store.task = store.task.filter((row) => !matches(row, where));
        return { count: before - store.task.length };
      },
    },
    run: {
      create: async ({ data }: any) => {
        if (
          data.clientNonce != null &&
          store.run.some(
            (row) => row.spaceId === data.spaceId && row.clientNonce === data.clientNonce,
          )
        ) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { id: nextId("run"), ...data };
        store.run.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        const before = store.run.length;
        store.run = store.run.filter((row) => !matches(row, where));
        return { count: before - store.run.length };
      },
    },
  };
  const prisma: any = {
    _store: store,
    run: {
      findUnique: async ({ where }: any) => {
        if (where.id) return store.run.find((row) => row.id === where.id) ?? null;
        if (where.spaceId_clientNonce) {
          return store.run.find((row) => matches(row, where)) ?? null;
        }
        return null;
      },
      ...tx.run,
    },
    task: { ...tx.task },
    message: {
      create: async ({ data }: any) => {
        const row = { id: nextId("msg"), ...data };
        store.message.push(row);
        return row;
      },
      findMany: async ({ where, orderBy, take }: any) => {
        const rows = ordered(
          store.message.filter((row) => matches(row, where)),
          orderBy,
        );
        return take != null ? rows.slice(0, take) : rows;
      },
    },
    event: {
      create: async ({ data }: any) => {
        const row = { id: nextId("evt"), ...data };
        store.event.push(row);
        return row;
      },
      findMany: async ({ where, orderBy, take, select }: any) => {
        let rows = ordered(
          store.event.filter((row) => matches(row, where)),
          orderBy,
        );
        if (take != null) rows = rows.slice(0, take);
        if (select) {
          rows = rows.map((row) =>
            Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])),
          );
        }
        return rows;
      },
    },
    routine: {
      findFirst: async ({ where }: any) => store.routine.find((row) => matches(row, where)) ?? null,
      create: async ({ data }: any) => {
        const row = { id: nextId("routine"), ...data };
        store.routine.push(row);
        return row;
      },
      deleteMany: async ({ where }: any) => {
        const before = store.routine.length;
        store.routine = store.routine.filter((row) => !matches(row, where));
        return { count: before - store.routine.length };
      },
    },
    $transaction: async (fn: any) => fn(tx),
  };
  return prisma;
}

export function createFakePotooJobs() {
  const enqueued: any[] = [];
  const fake = {
    enqueued,
    failNext: false,
    jobs: {
      enqueue: async (job: any) => {
        if (fake.failNext) {
          fake.failNext = false;
          throw new Error("queue unavailable");
        }
        enqueued.push(job);
      },
    },
  };
  return fake;
}
