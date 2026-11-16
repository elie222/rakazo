FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
COPY apt-security.sh /tmp/apt-security.sh
RUN /tmp/apt-security.sh \
  && apt-get update && apt-get upgrade -y --no-install-recommends && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git python3 python3-pip xvfb x11vnc fluxbox procps \
  && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash rakazo \
  && /tmp/apt-security.sh --check && rm -f /tmp/apt-security.sh
WORKDIR /home/rakazo
USER rakazo
ENV DISPLAY=:1
CMD ["bash", "-lc", "Xvfb :1 -screen 0 1280x720x24 & sleep 0.5 && fluxbox & x11vnc -display :1 -forever -shared -nopw -listen 0.0.0.0 -rfbport 5900 & sleep infinity"]
