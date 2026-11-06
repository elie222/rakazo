-- Additive: the previous release never reads this column, and every page it saved is JSX.
ALTER TABLE "pages" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'jsx';
