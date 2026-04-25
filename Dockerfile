# syntax=docker/dockerfile:1.7

# ---------- 1. deps: install node_modules with bun (matches local dev) ----------
FROM oven/bun:1 AS deps
WORKDIR /app
# bun.lock is gitignored; copy it only if present so a fresh checkout
# without a lockfile still builds, but a pinned dev environment stays
# reproducible.
COPY package.json ./
COPY bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# ---------- 2. builder: produce .next/ ----------
FROM oven/bun:1 AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# ---------- 3. runner: production image with the claude CLI on PATH ----------
FROM node:22-bookworm-slim AS runner
# PORT is the documented default — `docker run -e PORT=8080 …` overrides it
# at start time, and Next.js reads PORT natively so we don't have to
# inject the value via --port flags. BRIDGE_PORT mirrors PORT so the
# spawned permission-hook scripts and curl-back URLs hit the right port.
ENV NODE_ENV=production \
    PORT=7777 \
    BRIDGE_PORT=7777 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# git: claude reads sibling repos' git state for context.
# tini: reaps the grandchild `claude -p` subprocesses the bridge
#       spawns. Without a proper PID 1, killed sessions accumulate as
#       defunct zombies inside the container.
# claude CLI: the bridge spawns this binary for every chat turn.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --omit=dev @anthropic-ai/claude-code \
 && npm cache clean --force

# Bridge resolves sibling repos as `../<folder-name>` relative to
# BRIDGE_ROOT (= process.cwd()). Putting the bridge inside /workspace
# means siblings live at /workspace/<folder-name> — bind-mount your
# repo parent there at run time. See the run command at the bottom.
WORKDIR /workspace/edusoft-lms-bridge

# Copy only what the runtime actually needs — keeps the image lean and
# stops baking dev-only files (tests, docs, .git) into the layer.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/BRIDGE.md ./BRIDGE.md
COPY --from=builder /app/agents ./agents
COPY --from=builder /app/public ./public

# Volumes the operator should bind/mount externally so state survives
# `docker rm`. Declared so `docker inspect` documents the contract;
# bind-mounts at run time still take precedence over these anonymous
# volumes.
#   /workspace                 → repo parent (siblings live here)
#   /root/.claude              → claude auth + per-session .jsonl files
#   /workspace/edusoft-lms-bridge/sessions      → task meta.json store
#   /workspace/edusoft-lms-bridge/.bridge-state → per-session settings
#   /workspace/edusoft-lms-bridge/.uploads      → user-uploaded chat files
VOLUME ["/root/.claude", "/workspace/edusoft-lms-bridge/sessions", "/workspace/edusoft-lms-bridge/.bridge-state", "/workspace/edusoft-lms-bridge/.uploads"]

# EXPOSE is metadata only — pure documentation, doesn't bind anything
# at runtime. Override the actual published port via `docker run -p`.
EXPOSE 7777

ENTRYPOINT ["/usr/bin/tini", "--"]
# `next start` reads PORT and HOSTNAME from env, so passing --port here
# would just shadow `docker run -e PORT=8080`. Keep the CMD env-driven.
# sh -c lets us also forward BRIDGE_PORT=$PORT in case the operator
# only sets PORT (the runtime code prefers BRIDGE_PORT but falls back
# to PORT, so this is just an explicit handshake).
CMD ["sh", "-c", "exec npx next start"]

# ---------------------------------------------------------------------
# Build:
#   docker build -t edusoft-bridge .
#
# Run (replace D:/Edusoft with your repo parent dir):
#   docker run -d --name bridge \
#     -p 7777:7777 \
#     -v D:/Edusoft/lms.edusoft.vn:/workspace \
#     -v $HOME/.claude:/root/.claude \
#     -e ANTHROPIC_API_KEY=sk-ant-… \
#     edusoft-bridge
#
# Run on a different port (PORT env drives both Next.js and the
# spawned children's hook URLs):
#   docker run -d -p 8080:8080 -e PORT=8080 -e BRIDGE_PORT=8080 \
#     -v D:/Edusoft/lms.edusoft.vn:/workspace \
#     -v $HOME/.claude:/root/.claude \
#     edusoft-bridge
#
# Notes:
#   - Mounting $HOME/.claude reuses your local OAuth / API key and the
#     existing session .jsonl history. Skip it and pass
#     ANTHROPIC_API_KEY only if you want a clean container slate.
#   - Sibling repos must live next to edusoft-lms-bridge under the
#     mounted /workspace so the bridge can resolve `@<repo-name>`.
# ---------------------------------------------------------------------
