# OpenWA Docker Commands

Use these commands from the project root:

```bash
cd "/home/adile/Desktop/whatsapp api/OpenWA"
```

## Development Docker Setup

Start the API and dashboard:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Stop the API and dashboard:

```bash
docker compose -f docker-compose.dev.yml down
```

Check running containers:

```bash
docker compose -f docker-compose.dev.yml ps
```

View logs:

```bash
docker compose -f docker-compose.dev.yml logs -f
```

View only API logs:

```bash
docker compose -f docker-compose.dev.yml logs -f openwa
```

View only dashboard logs:

```bash
docker compose -f docker-compose.dev.yml logs -f dashboard
```

Restart after code/config changes:

```bash
docker compose -f docker-compose.dev.yml down
docker compose -f docker-compose.dev.yml up -d --build
```

## Production Docker Setup

Start basic production stack:

```bash
docker compose up -d --build
```

Stop production stack:

```bash
docker compose down
```

Start production with PostgreSQL:

```bash
docker compose --profile postgres up -d --build
```

Start full production stack:

```bash
docker compose --profile full up -d --build
```

## Access URLs

Dashboard:

```text
http://localhost:2886
```

API:

```text
http://localhost:2785/api
```

Swagger API docs:

```text
http://localhost:2785/api/docs
```

## API Key

Development default:

```text
dev-admin-key
```

Or read the generated key:

```bash
cat data/.api-key
```

## Notes

`docker compose down` stops and removes containers and the project network, but it does not delete your local `data/` folder.

Do not use `docker compose down -v` unless you intentionally want to delete Docker volumes.
