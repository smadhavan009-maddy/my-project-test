# SkyHop Airways: Demo Flight Booking App

A small, self-contained airline booking demo. Users can:

1. **Search flights** by origin, destination, date, number of passengers (1–9) and cabin (Economy / Business)
2. **Pick a flight** and enter passenger names plus a contact email
3. **Get a confirmation** with a 6-character booking reference (PNR), printable
4. **Manage a booking**: look it up by PNR and cancel it (seats are released)

It is built with plain Node.js (no npm dependencies) and a vanilla HTML/CSS/JS front end.

## Run it

### Option A: Node.js (20+)

```bash
npm start          # http://localhost:3000
npm test           # API tests (node:test)
```

Change the port with `PORT=8080 npm start`.

### Option B: Docker

```bash
docker build -t skyhop-airline:1.0 .
docker run -d --name skyhop -p 3000:3000 --restart unless-stopped skyhop-airline:1.0
```

or `docker compose up -d --build`.

The container runs as a non-root user and has a health check on `/api/health`.

### Option C: Google Cloud Run

```bash
gcloud run deploy skyhop-airline --source . --region asia-south1 \
  --allow-unauthenticated --max-instances 1
```

`--max-instances 1` keeps all bookings in one instance, because data is held in memory (see below).

The same image runs on any container host: Azure Container Apps, AWS App Runner/ECS, Kubernetes, or a VM with Docker.

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/health` | Liveness check |
| GET  | `/api/airports` | List of airports |
| GET  | `/api/flights?from=DEL&to=BOM&date=YYYY-MM-DD&passengers=1&cabin=economy` | Search flights with seats left |
| POST | `/api/bookings` | Book: `{ flightId, cabin, passengers: [{firstName, lastName}], contactEmail }` |
| GET  | `/api/bookings/:pnr` | Look up a booking |
| POST | `/api/bookings/:pnr/cancel` | Cancel a booking |

## Project layout

```
src/flights.js   Airports, cabins and the generated flight schedule
src/store.js     In-memory bookings and seat inventory
src/server.js    HTTP server, routing and input validation
public/          Single-page UI (index.html, app.js, styles.css)
test/            API tests
```

## Demo limitations

- **Data is in memory.** Bookings reset when the app restarts. For real use, swap `BookingStore` for a database.
- **No payments or login.** Booking confirms immediately; anyone with a PNR can view or cancel it.
- **Flights are generated.** Each route gets three departures a day (06:30, 12:15, 18:40) with deterministic fares. Times are treated as UTC.
- **Minimal personal data.** Only passenger names and one contact email are collected. No ID or payment details.
