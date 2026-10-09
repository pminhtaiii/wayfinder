FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.11.0
RUN groupadd --system security-api && useradd --system --gid security-api --create-home security-api
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/nest-cli.json ./apps/api/
COPY apps/api/src/ ./apps/api/src/
COPY apps/api/prisma/ ./apps/api/prisma/
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src/ ./packages/shared/src/
COPY scripts/ci/run-api-task.mjs ./scripts/ci/
RUN pnpm install --frozen-lockfile --filter @api/backend... && pnpm --filter @api/backend build
RUN chown -R security-api:security-api /app
WORKDIR /app/apps/api
USER security-api
CMD ["node", "dist/main.js"]
