# The execution worker's image: Node.js 22 for the worker itself, and the four toolchains it
# runs student code with (Python 3.12, C++17 via g++, OpenJDK 21, Go 1.23).
#
# Debian bookworm only ships Python 3.11, Go 1.19 and no JDK 21, so those three come from the
# official images (pinned by tag) instead of apt.
FROM python:3.12-slim-bookworm AS python
FROM golang:1.23-bookworm AS golang
FROM eclipse-temurin:21-jdk-jammy AS temurin

# JSON libraries for C++ and Java drivers (Python and Go use their standard libraries). Fetched in
# a throwaway stage so curl never reaches the final image, and checked against pinned checksums:
# the Gson one is the sha256 Maven Central publishes; the nlohmann one was taken from the v3.12.0
# release asset (its header says "version 3.12.0").
FROM debian:bookworm-slim AS judge-libs
ARG NLOHMANN_JSON_VERSION=3.12.0
ARG NLOHMANN_JSON_SHA256=aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63
ARG GSON_VERSION=2.14.0
ARG GSON_SHA256=2cbd119bf1961c28788310963dc80ba65f58cdeec1dd139c8bdb1240faa2c36f
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/judge/include/nlohmann /opt/judge/lib \
 && curl -fsSL -o /opt/judge/include/nlohmann/json.hpp \
      "https://github.com/nlohmann/json/releases/download/v${NLOHMANN_JSON_VERSION}/json.hpp" \
 && curl -fsSL -o /opt/judge/lib/gson.jar \
      "https://repo1.maven.org/maven2/com/google/code/gson/gson/${GSON_VERSION}/gson-${GSON_VERSION}.jar" \
 && echo "${NLOHMANN_JSON_SHA256}  /opt/judge/include/nlohmann/json.hpp" | sha256sum -c - \
 && echo "${GSON_SHA256}  /opt/judge/lib/gson.jar" | sha256sum -c - \
 && chown -R root:root /opt/judge \
 && find /opt/judge -type d -exec chmod 755 {} + \
 && find /opt/judge -type f -exec chmod 644 {} +

FROM node:22-bookworm-slim AS base

# g++ for C++17, util-linux for prlimit, tini to reap the zombies of killed programs (PID 1 must
# do that, or a fork bomb would leave the runner user's process table full), and the shared
# libraries the copied Python was built against.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      g++ util-linux tini ca-certificates \
      libssl3 libexpat1 libffi8 zlib1g libbz2-1.0 liblzma5 libsqlite3-0 libreadline8 libncursesw6 libuuid1 \
 && rm -rf /var/lib/apt/lists/*

# Python 3.12
COPY --from=python /usr/local/bin/python3.12 /usr/local/bin/python3.12
COPY --from=python /usr/local/lib/libpython3.12.so.1.0 /usr/local/lib/libpython3.12.so.1.0
COPY --from=python /usr/local/lib/python3.12 /usr/local/lib/python3.12
RUN ln -s python3.12 /usr/local/bin/python3 && ldconfig

# Go 1.23
COPY --from=golang /usr/local/go /usr/local/go

# OpenJDK 21
COPY --from=temurin /opt/java/openjdk /opt/java/openjdk

# nlohmann/json (C++) and Gson (Java): root-owned and read-only for the runner users.
COPY --from=judge-libs /opt/judge /opt/judge

ENV JAVA_HOME=/opt/java/openjdk \
    PATH=/usr/local/go/bin:/opt/java/openjdk/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Eight runner users, one per concurrent job (slot n runs as uid and gid 2000 + n). No shell, no
# home. The worker is root only so that it can start children as one of these.
RUN for i in 1 2 3 4 5 6 7 8; do \
      groupadd --gid $((2000 + i)) "runner$i" \
   && useradd --uid $((2000 + i)) --gid $((2000 + i)) --no-create-home \
        --home-dir /nonexistent --shell /usr/sbin/nologin "runner$i"; \
    done

# Per-run directories are made here. Root owns it (mode 755), so a runner can write only inside
# the directory made for its own run. Mount a writable volume here when the root filesystem is
# read-only.
RUN mkdir /work && chmod 755 /work

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock && npm cache clean --force
COPY src ./src
COPY fixtures ./fixtures
COPY cli.js DRIVERS.md ./
RUN chmod -R a+rX /app

# PID 1 is tini, which reaps the zombies of killed programs and passes signals on to the worker.
ENTRYPOINT ["/usr/bin/tini", "--"]

# --- test: the same image plus Vitest, for `pnpm test:worker-docker` ---------------------------
FROM base AS test
RUN npm install --no-audit --no-fund --no-package-lock && npm cache clean --force
COPY vitest.config.js ./
# The sandbox tests need root, the runner users and these tools, so they only run in this image.
ENV WORKER_SANDBOX_TESTS=1
CMD ["npx", "vitest", "run"]

# --- production: what runs on Fargate (this must stay the last stage) --------------------------
FROM base AS production
ENV NODE_ENV=production
CMD ["node", "src/index.js"]
