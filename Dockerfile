FROM node:22-bookworm-slim

WORKDIR /app/backend

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir unisms \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
  DB_PATH=/app/data/data.db \
  PYTHON_BIN=/opt/venv/bin/python \
  PATH="/opt/venv/bin:${PATH}"

COPY backend/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY backend/ ./

WORKDIR /app
COPY frontend/ ./frontend/

WORKDIR /app/backend
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["npm", "start"]
