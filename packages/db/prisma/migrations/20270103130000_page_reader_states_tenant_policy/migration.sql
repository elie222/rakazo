-- The reader's saved values belong to the Space the page is in, like every other protected table.
-- The table shipped with only its system policy, so a tenant read returned nothing and a tenant
-- write failed on the missing policy instead of being refused by the Space check.
CREATE POLICY page_reader_states_tenant ON "page_reader_states"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));