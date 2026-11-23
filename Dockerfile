# DockerAC - Assetto Corsa Server Manager runtime image.
# The image contains no licensed software: Server Manager, the ACSM licence and the
# plugins are installed at first start through the setup page on port 8772 and are
# stored in the /data volume.

FROM node:22.12.0-bookworm-slim AS node

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    DATA_DIR=/data

# libc6-i386/lib32*: 32 bit runtime for sTracker and steamcmd
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip tini \
      libc6-i386 lib32gcc-s1 lib32stdc++6 lib32z1 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node

RUN useradd -m -s /bin/bash -u 1000 assetto \
 && mkdir -p /data \
 && chown assetto:assetto /data

COPY setup /opt/setup
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

WORKDIR /data
VOLUME ["/data"]

EXPOSE 8772

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD curl -fsS http://localhost:8772/healthcheck.json > /dev/null || exit 1

STOPSIGNAL SIGINT
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
