-- Gmail delivers to one mailbox under gmail.com and googlemail.com, and sign-in now looks
-- addresses up as gmail.com. Move stored addresses over so existing accounts keep signing in.
-- An address that shares its mailbox with another account stays as it is.
UPDATE "user" AS u
SET email = lower(split_part(u.email, '@', 1)) || '@gmail.com'
WHERE lower(u.email) LIKE '%@googlemail.com'
  AND NOT EXISTS (
    SELECT 1 FROM "user" AS other
    WHERE other.id <> u.id
      AND lower(split_part(other.email, '@', 1)) = lower(split_part(u.email, '@', 1))
      AND lower(split_part(other.email, '@', 2)) IN ('gmail.com', 'googlemail.com')
  );

UPDATE invitation
SET email = lower(split_part(email, '@', 1)) || '@gmail.com'
WHERE lower(email) LIKE '%@googlemail.com';

UPDATE access_grants
SET email = lower(split_part(email, '@', 1)) || '@gmail.com'
WHERE lower(email) LIKE '%@googlemail.com';
