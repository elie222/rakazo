# The supervisor's egress attestation probe: reads the host's live firewall from
# the host network namespace with CAP_NET_ADMIN, so it must never run an image
# anyone but this repository controls. Built only by the supervisor from this
# context (never pulled: the name is unqualified), on a digest-pinned base.
# The image contains the tools needed to read the host's iptables rules.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update && apt-get install -y --no-install-recommends \
    iptables \
    bash \
  && rm -rf /var/lib/apt/lists/*
