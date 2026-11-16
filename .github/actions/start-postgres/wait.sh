#!/usr/bin/env bash
# Waits for the database the start-postgres action booted.
for _ in $(seq 1 30); do
  if docker exec ci-postgres pg_isready -U postgres -d rakazo; then
    exit 0
  fi
  sleep 1
done
echo "Postgres did not become ready" >&2
docker logs ci-postgres >&2 || true
exit 1
