# A pull request preview: the server image plus its own Postgres, so one machine holds the whole
# stack and can stop when nobody is visiting. Build the server image first and pass its tag:
#   docker build -f infra/compose/Dockerfile -t rakazo-server:preview .
#   docker build --build-arg SERVER_IMAGE=rakazo-server:preview -t rakazo-preview infra/preview
ARG SERVER_IMAGE=rakazo-server:preview
FROM ${SERVER_IMAGE}
USER root
# The server image runs Postgres 18. Debian's package would create a cluster at install time;
# start.sh creates one on the volume instead.
RUN mkdir -p /etc/postgresql-common/createcluster.d \
  && echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.d/preview.conf \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu postgresql-common tini \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get install -y --no-install-recommends postgresql-18 \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["bash", "/app/infra/preview/start.sh"]
