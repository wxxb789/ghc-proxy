FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/bun

RUN mkdir -p /home/bun/.local/share/ghc-proxy \
  && chown -R bun:bun /home/bun

COPY --from=builder --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 4141

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const response = await fetch('http://127.0.0.1:4141/health'); process.exit(response.ok ? 0 : 1)"

USER bun
ENTRYPOINT ["/entrypoint.sh"]
CMD ["start"]
