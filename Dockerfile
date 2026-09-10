# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Cả hai nửa trong một image.
#
# `backend/Dockerfile` và `frontend/Dockerfile` vẫn là cách đóng gói chính:
# hai tiến trình, nginx đứng trước, đúng như một hệ thống thật nên chạy. File
# này dành cho nơi chỉ có duy nhất một service — gói free của một nhà cung cấp
# hosting chẳng hạn.
#
# Lý do không phải là tiết kiệm. Cookie refresh đặt SameSite=Strict, nên trình
# duyệt chỉ gửi nó khi trang web và API thuộc cùng một site. Tách ra hai
# hostname dưới một public suffix như `onrender.com` là hai site khác nhau:
# đăng nhập vẫn được, rồi F5 một cái là mất phiên, còn Safari thì chặn thẳng.
# Một origin duy nhất làm câu hỏi đó biến mất.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS frontend

WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
# Đường dẫn tương đối: frontend gọi về chính origin đang phục vụ nó. Vite ghim
# giá trị này vào bundle lúc build, không đọc lúc chạy.
ENV VITE_API_URL=/api/v1
RUN npm run build


FROM node:22-alpine AS backend

WORKDIR /app
COPY backend/package*.json ./
RUN npm ci

COPY backend/tsconfig.json backend/tsconfig.build.json backend/drizzle.config.ts ./
COPY backend/src ./src
COPY backend/drizzle ./drizzle

RUN npm run build


# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

FROM node:22-alpine AS runtime

# dumb-init thu dọn tiến trình mồ côi và chuyển tiếp SIGTERM đúng cách. Thiếu
# nó, Node chạy ở PID 1 — nơi các handler tín hiệu mặc định không áp dụng — và
# đoạn tắt êm trong server.ts không bao giờ chạy khi container bị dừng.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=backend /app/dist ./dist
COPY --from=backend /app/drizzle ./drizzle
COPY backend/drizzle.config.ts ./
COPY backend/docker-start.sh ./

# app.ts tìm frontend ở đúng đây, và không mount gì nếu không thấy.
COPY --from=frontend /app/dist ./public

# Hai việc user `node` không tự làm được, nên làm khi vẫn còn là root: cho
# script quyền chạy, và tạo một thư mục nó được phép ghi. Seed đổ file thông
# tin đăng nhập vào ./seed-output, mà /app thì thuộc về root.
RUN chmod +x docker-start.sh \
    && mkdir -p seed-output \
    && chown node:node seed-output

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
