import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryReadRequest,
  MemoryRemoveRequest,
  MemoryRevision,
  MemoryRevisionListRequest,
  MemoryRevisionReadRequest,
  MemoryRevisionSummary,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MemorySourceKind,
  MemoryStore,
  PortableFile,
} from "@rakazo/adapter-kit";
import { MemoryDocumentLimitError, MemoryRevisionConflictError } from "@rakazo/adapter-kit";
import { MEMORY_NOTES_PER_LAYER } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, withTransactionRetry } from "@rakazo/db";

/** Memory is the Space's: every member's runs read and write the same documents. */
export class MarkdownMemoryStore implements MemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  describe() {
    return {
      id: "markdown",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    };
  }

  async read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        spaceId: context.spaceId,
        scope: request.scope,
        ...(request.botId ? { botId: request.botId } : {}),
        ...(request.path ? { path: request.path } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { path: "asc" }],
    });
    return {
      documents: documents.map((doc) => ({
        id: doc.id,
        path: doc.path,
        content: doc.content,
        revision: doc.revision,
        updatedAt: doc.updatedAt.toISOString(),
      })),
    };
  }

  async search(
    request: MemorySearchRequest,
    context: AdapterContext,
  ): Promise<MemorySearchResult[]> {
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        spaceId: context.spaceId,
        ...(request.scope === "all" ? {} : { scope: request.scope }),
        ...(request.botId ? { botId: request.botId } : {}),
      },
    });
    const q = request.query.toLowerCase();
    return documents
      .filter((doc) => doc.content.toLowerCase().includes(q) || doc.path.toLowerCase().includes(q))
      .map((doc) => ({
        path: doc.path,
        snippet: snippet(doc.content, q),
        score: 1,
      }));
  }

  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    // A save replaces the current content and appends its history atomically.
    // Conflicts retry the whole transaction so revision numbers use fresh state.
    return withTransactionRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const sourceKind = request.sourceKind ?? "user";
          const existing = await tx.memoryDocument.findFirst({
            where: {
              spaceId: context.spaceId,
              scope: request.scope,
              botId: request.botId ?? null,
              path: request.path,
            },
          });
          if (request.expectedRevision !== undefined) {
            const live = existing?.revision ?? 0;
            if (live !== request.expectedRevision) throw new MemoryRevisionConflictError();
          }
          if (!existing) {
            // A bank stays scannable: a new path past the limit is refused, while an
            // existing path can always be overwritten.
            const notes = await tx.memoryDocument.count({
              where: {
                spaceId: context.spaceId,
                scope: request.scope,
                botId: request.botId ?? null,
              },
            });
            if (notes >= MEMORY_NOTES_PER_LAYER) throw new MemoryDocumentLimitError();
          }
          const doc = existing
            ? await tx.memoryDocument.update({
                where: { id: existing.id },
                data: {
                  content: request.content,
                  revision: existing.revision + 1,
                  ...(request.description === undefined
                    ? {}
                    : { description: request.description }),
                },
              })
            : await tx.memoryDocument.create({
                data: {
                  spaceId: context.spaceId,
                  userId: context.userId,
                  botId: request.botId,
                  scope: request.scope,
                  path: request.path,
                  content: request.content,
                  description: request.description ?? null,
                },
              });
          const revision = await tx.memoryRevision.create({
            data: {
              documentId: doc.id,
              revision: doc.revision,
              content: request.content,
              sourceKind,
              sourceRunId: request.sourceRunId,
              sourceThreadId: request.sourceThreadId,
            },
          });
          return {
            id: doc.id,
            path: doc.path,
            revision: doc.revision,
            content: doc.content,
            sourceKind,
            createdAt: revision.createdAt.toISOString(),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async listRevisions(
    request: MemoryRevisionListRequest,
    context: AdapterContext,
  ): Promise<MemoryRevisionSummary[]> {
    const take = Math.min(Math.max(request.limit ?? 20, 1), 100);
    const rows = await this.prisma.memoryRevision.findMany({
      where: {
        documentId: request.documentId,
        document: { spaceId: context.spaceId },
      },
      orderBy: [{ revision: "desc" }, { id: "desc" }],
      take,
      ...(request.cursor ? { cursor: { id: request.cursor }, skip: 1 } : {}),
      select: { id: true, revision: true, sourceKind: true, createdAt: true },
    });
    return rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      sourceKind: sourceKind(row.sourceKind),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async readRevision(
    request: MemoryRevisionReadRequest,
    context: AdapterContext,
  ): Promise<MemoryRevision | null> {
    const row = await this.prisma.memoryRevision.findFirst({
      where: {
        id: request.revisionId,
        documentId: request.documentId,
        document: { spaceId: context.spaceId },
      },
      select: {
        id: true,
        revision: true,
        content: true,
        sourceKind: true,
        createdAt: true,
        document: { select: { path: true } },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      path: row.document.path,
      revision: row.revision,
      content: row.content,
      sourceKind: sourceKind(row.sourceKind),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async remove(
    request: MemoryRemoveRequest,
    context: AdapterContext,
  ): Promise<{ removed: boolean }> {
    // Revisions cascade with the document row.
    const { count } = await this.prisma.memoryDocument.deleteMany({
      where: {
        ...(request.id ? { id: request.id } : {}),
        spaceId: context.spaceId,
        scope: request.scope,
        botId: request.botId ?? null,
        path: request.path,
      },
    });
    return { removed: count > 0 };
  }

  async *exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const snapshot = await this.read(
      { scope: request.scope === "all" ? "user" : request.scope, botId: request.botId },
      context,
    );
    for (const doc of snapshot.documents) {
      yield { path: doc.path, content: new TextEncoder().encode(doc.content) };
    }
  }

  async importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision> {
    let last: MemoryRevision | undefined;
    for await (const file of files) {
      last = await this.commit(
        {
          scope: "user",
          path: file.path,
          content: new TextDecoder().decode(file.content),
          sourceKind: "import",
        },
        context,
      );
    }
    if (!last) throw new Error("No memory files to import");
    return last;
  }
}

function snippet(content: string, q: string): string {
  const idx = content.toLowerCase().indexOf(q);
  if (idx < 0) return content.slice(0, 140);
  return content.slice(Math.max(0, idx - 40), idx + q.length + 80);
}

/** A row written before kinds existed came from a person. */
function sourceKind(value: string | null): MemorySourceKind {
  return value === "bot" || value === "dream" || value === "import" || value === "undo"
    ? value
    : "user";
}
