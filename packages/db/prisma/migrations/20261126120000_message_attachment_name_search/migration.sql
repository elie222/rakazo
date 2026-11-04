-- Sole statement so the attachment-name index builds outside an implicit
-- transaction, without blocking chat writes for the entire build.
CREATE INDEX CONCURRENTLY "messages_attachment_name_search_idx" ON "messages"
USING GIN (to_tsvector('simple', translate(jsonb_path_query_array(blocks, '$[*] ? (@.kind == "file" || @.kind == "image").name')::text, '._-', '   ')));
