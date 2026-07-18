# okane-dokoitta 單 image 多角色（ADR-004）。
# 尚未在本機驗證過 docker build（開發機無 Docker）——CI/首次部署時驗證。
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @okane-dokoitta/web build
# 只帶 api 與其 workspace 依賴（含 TS 原始碼，runtime 用 tsx 執行）
RUN pnpm --filter @okane-dokoitta/api deploy --prod /app
RUN cp -r apps/web/dist /app/web-dist
# 自架維運腳本（SETUP_TUTORIAL §6.4：Discord 指令註冊）
RUN mkdir -p /app/scripts && cp scripts/discord-register-commands.mjs /app/scripts/

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV OKANE_DOKOITTA_WEB_DIST=/app/web-dist
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["serve"]
