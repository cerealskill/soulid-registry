# soulid-registry

REST API for resolving and publishing SOUL ID documents.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Status check |
| GET | `/resolve/:soul_id` | — | Resolve a Soul Document |
| GET | `/list` | — | List registered souls |
| POST | `/publish` | API Key | Publish or update a Soul Document |
| DELETE | `/soul/:soul_id` | API Key | Delete a Soul Document |

## soul_id format

```
namespace:archetype:version:instance
soulid:custodian:v1:001
```

## Publish example

```bash
curl -X POST https://registry.soulid.io/publish \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "soul_id": "soulid:custodian:v1:001",
    "name": "Custodian",
    "purpose": "Monitor and maintain system stability",
    "owner": { "id": "soulid", "type": "organization" }
  }'
```

## Resolve example

```bash
curl https://registry.soulid.io/resolve/soulid:custodian:v1:001
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `TURSO_URL` | Turso database URL (`libsql://...`) |
| `TURSO_TOKEN` | Turso auth token |
| `REGISTRY_API_KEY` | Secret key for publish/delete endpoints |

## Stack

- [Hono](https://hono.dev) — Edge-native web framework
- [Turso](https://turso.tech) — SQLite at the edge
- [Vercel](https://vercel.com) — Edge runtime deployment
