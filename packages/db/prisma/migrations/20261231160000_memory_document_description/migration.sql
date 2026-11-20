-- Additive: older releases keep writing notes without a description.
ALTER TABLE "memory_documents" ADD COLUMN "description" TEXT;
