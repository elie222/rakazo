-- Index only conversational text; commands, credentials and progress are excluded.
CREATE INDEX "messages_history_search_idx" ON "messages"
USING GIN (to_tsvector('simple', jsonb_path_query_array(blocks,
  '$[*] ? (@.kind == "text" || @.kind == "channel_message" || @.kind == "bot_message_received" || @.kind == "bot_message_sent" || @.kind == "handoff").text')::text || jsonb_path_query_array(blocks, '$[*] ? (@.kind == "subagent").result')::text));
