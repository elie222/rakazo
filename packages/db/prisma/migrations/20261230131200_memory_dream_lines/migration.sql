-- AlterTable
ALTER TABLE "memory_dreams" ADD COLUMN "added" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "archived" TEXT[] DEFAULT ARRAY[]::TEXT[];
