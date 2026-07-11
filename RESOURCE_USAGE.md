docker compose --profile full up -d

owa_k1_53be58822bff06e656f3be3ebd83eb1acdd786f46150e3ca9ffee0ac06020ae5

# OpenWA Resource Usage

## Engine: Baileys (no Chromium)

**Date:** 2026-07-09

---

## Baseline — 0 Active Sessions

| Container          | CPU    | RAM       |
| ------------------ | ------ | --------- |
| `openwa-api`       | 0%     | 138 MB    |
| `openwa-dashboard` | 0%     | 7.5 MB    |
| `openwa-traefik`   | 0%     | 26.9 MB   |
| **Total**          | **0%** | **~i MB** |

---

## 1 Active Session (Connected)

| Container          | CPU       | RAM         |
| ------------------ | --------- | ----------- |
| `openwa-api`       | 0.02%     | 147.7 MB    |
| `openwa-dashboard` | 0%        | 7.6 MB      |
| `openwa-traefik`   | 0%        | 26.9 MB     |
| **Total**          | **0.02%** | **~182 MB** |

**Delta vs baseline: +10 MB for 1 active Baileys session**

---

## 2 Active Sessions (Connected)

| Container          | CPU    | RAM         |
| ------------------ | ------ | ----------- |
| `openwa-api`       | 0%     | 164.2 MB    |
| `openwa-dashboard` | 0%     | 8 MB        |
| `openwa-traefik`   | 0%     | 28.7 MB     |
| **Total**          | **0%** | **~201 MB** |

**Delta vs baseline: +29 MB for 2 active Baileys sessions (~14.5 MB per session)**

---

## Docker Run Command

```bash
docker compose up -d openwa-api
```

### With Dashboard & Proxy

```bash
docker compose --profile full up -d
```

### Individual Profiles

```bash
# API + Dashboard (no Traefik)
docker compose --profile with-dashboard up -d

# API + Proxy
docker compose --profile with-proxy up -d

# With PostgreSQL
docker compose --profile postgres up -d

# With Redis
docker compose --profile redis up -d

# With MinIO (S3 storage)
docker compose --profile minio up -d

# Combine profiles
docker compose --profile full --profile postgres --profile redis up -d
```

### Environment Variables

Key variables (set in `.env` or pass with `-e`):

| Variable         | Default           | Description                             |
| ---------------- | ----------------- | --------------------------------------- |
| `API_PORT`       | `2785`            | API port on host                        |
| `DASHBOARD_PORT` | `2886`            | Dashboard port on host                  |
| `ENGINE_TYPE`    | `whatsapp-web.js` | Engine (`whatsapp-web.js` or `baileys`) |
| `DATABASE_TYPE`  | `sqlite`          | Database (`sqlite` or `postgres`)       |
| `REDIS_ENABLED`  | `false`           | Enable Redis cache                      |
| `STORAGE_TYPE`   | `local`           | Storage (`local` or `s3`)               |
| `API_MASTER_KEY` | _(empty)_         | Master API key                          |
| `LOG_LEVEL`      | `info`            | Log level                               |

---

## Estimated Cost Per Session (Baileys)

| Sessions | Estimated RAM |
| -------- | ------------- |
| 0 (idle) | ~172 MB       |
| 1        | ~200-220 MB   |
| 5        | ~320-420 MB   |
| 10       | ~470-670 MB   |
