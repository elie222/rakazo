# The published app image, plus what the shared start script needs to set the disk's owner
# before it drops to the node user.
ARG RAKAZO_IMAGE_TAG=latest
FROM ghcr.io/elie222/rakazo/app:${RAKAZO_IMAGE_TAG}
USER root
COPY --chmod=755 infra/sandboxes/computer/apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh \
  && apt-get update && apt-get install -y --no-install-recommends gosu tini \
  && rm -rf /var/lib/apt/lists/* \
  && /tmp/apt-security.sh --check && rm -f /tmp/apt-security.sh
COPY --chmod=755 infra/railway/start.sh infra/railway/
COPY --chmod=755 infra/render/start.sh infra/render/
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["bash", "infra/render/start.sh"]
