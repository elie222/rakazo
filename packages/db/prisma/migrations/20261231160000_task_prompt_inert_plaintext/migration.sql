-- Task prompts are now encrypted, and a value shaped like `rkz1:<key id>:…` reads as ciphertext.
-- A zero-width space keeps an older plaintext prompt with that shape reading as text, as writes
-- with encryption off already do. Real ciphertext names a stored Space key and is left alone.
UPDATE "tasks" SET "prompt" = U&'\200B' || "prompt"
WHERE "prompt" LIKE 'rkz1:%:%'
  AND NOT EXISTS (SELECT 1 FROM "space_keys" WHERE "id" = split_part("tasks"."prompt", ':', 2));
