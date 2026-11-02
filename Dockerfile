FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS production-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 TMPDIR=/tmp
WORKDIR /app
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY drizzle ./drizzle
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "const fs=require('node:fs'); for(const p of ['/data','/tmp']) fs.accessSync(p,fs.constants.W_OK); const h=new URL(process.env.APP_ORIGIN).host; const r=require('node:http').get({host:'127.0.0.1',port:process.env.PORT,path:'/api/v1/health/ready',headers:{host:h},timeout:4000},res=>{res.resume();process.exitCode=res.statusCode===200?0:1});r.on('timeout',()=>r.destroy());r.on('error',()=>{process.exitCode=1})"
ENTRYPOINT ["node", "dist/server/main.js"]
CMD ["serve"]
