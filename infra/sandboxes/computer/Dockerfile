FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    xterm \
    xdotool \
    x11-utils \
    x11-xserver-utils \
    imagemagick \
    novnc \
    websockify \
    python3 \
    ca-certificates \
    procps \
    bash \
    chromium \
    fonts-liberation \
    fonts-dejavu-core \
    dbus-x11 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /etc/rakazo/fluxbox \
  && printf '%s\n' '#!/bin/sh' 'exec xsetroot -solid "#111113" "$@"' > /usr/bin/fbsetbg \
  && chmod +x /usr/bin/fbsetbg \
  && ln -sfn /bin/true /usr/bin/xmessage
ENV DISPLAY=:1
ENV HOME=/home/rakazo
WORKDIR /home/rakazo
COPY start.sh /usr/local/bin/rakazo-computer
COPY rakazo-browser /usr/local/bin/rakazo-browser
COPY fluxbox.init /etc/rakazo/fluxbox/init
COPY fluxbox.apps /etc/rakazo/fluxbox/apps
COPY fluxbox.menu /etc/rakazo/fluxbox/menu
COPY embed.html /usr/share/novnc/embed.html
RUN chmod +x /usr/local/bin/rakazo-computer /usr/local/bin/rakazo-browser
EXPOSE 6080 6081
CMD ["/usr/local/bin/rakazo-computer"]
