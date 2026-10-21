'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HttpError } = require('./errors');
const flights = require('./flights');
const { BookingStore } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_PASSENGERS = 9;
const NAME_PATTERN = /^[A-Za-z][A-Za-z .'-]{0,49}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(new HttpError(400, 'Request body must be valid JSON'));
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new HttpError(400, 'Request body must be a JSON object'));
      }
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

// ---- Validation -----------------------------------------------------------

function validateRoute(from, to) {
  if (!flights.isValidAirport(from) || !flights.isValidAirport(to)) {
    throw new HttpError(400, 'Unknown airport code');
  }
  if (from === to) throw new HttpError(400, 'Origin and destination must be different');
}

function validateDate(isoDate, now) {
  if (!flights.isValidIsoDate(isoDate)) {
    throw new HttpError(400, 'Date must be in YYYY-MM-DD format');
  }
  if (!flights.isWithinBookingWindow(isoDate, now)) {
    throw new HttpError(
      400,
      `Flights can be booked from today up to ${flights.BOOKING_WINDOW_DAYS} days ahead`,
    );
  }
}

function validateCabin(cabin) {
  if (!Object.hasOwn(flights.CABINS, cabin)) throw new HttpError(400, 'Unknown cabin class');
}

function validatePassengerCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PASSENGERS) {
    throw new HttpError(400, `Passengers must be between 1 and ${MAX_PASSENGERS}`);
  }
  return count;
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return NAME_PATTERN.test(name) ? name : null;
}

function validatePassengers(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PASSENGERS) {
    throw new HttpError(400, `Add between 1 and ${MAX_PASSENGERS} passengers`);
  }
  return list.map((passenger, index) => {
    const firstName = cleanName(passenger && passenger.firstName);
    const lastName = cleanName(passenger && passenger.lastName);
    if (!firstName || !lastName) {
      throw new HttpError(400, `Passenger ${index + 1} needs a valid first and last name`);
    }
    return { firstName, lastName };
  });
}

function validateEmail(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email.length > 120 || !EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, 'A valid contact email is required');
  }
  return email;
}

// ---- Handlers -------------------------------------------------------------

function withAvailability(flight, store) {
  const cabins = {};
  for (const [key, cabin] of Object.entries(flight.cabins)) {
    cabins[key] = { ...cabin, seatsLeft: store.seatsLeft(flight.id, key) };
  }
  return { ...flight, cabins };
}

function searchFlights({ url, store, now }) {
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  const date = url.searchParams.get('date') || '';
  const cabin = url.searchParams.get('cabin') || 'economy';
  const passengers = validatePassengerCount(url.searchParams.get('passengers') || '1');

  validateRoute(from, to);
  validateDate(date, now);
  validateCabin(cabin);

  const results = flights
    .listFlights(from, to, date)
    .filter((flight) => flights.departsAt(flight) > now)
    .map((flight) => withAvailability(flight, store));

  return [200, { from, to, date, cabin, passengers, flights: results }];
}

function createBooking({ body, store, now }) {
  const parsed = flights.parseFlightId(body.flightId);
  if (!parsed) throw new HttpError(400, 'Invalid flight selected');
  validateDate(parsed.isoDate, now);

  const flight = flights.buildFlight(parsed.from, parsed.to, parsed.isoDate, parsed.slot);
  if (flights.departsAt(flight) <= now) throw new HttpError(409, 'This flight has already departed');

  validateCabin(body.cabin);
  const passengers = validatePassengers(body.passengers);
  const contactEmail = validateEmail(body.contactEmail);

  return [201, store.createBooking({ flight, cabin: body.cabin, passengers, contactEmail })];
}

function getBooking({ match, store }) {
  const booking = store.getBooking(match[1].toUpperCase());
  if (!booking) throw new HttpError(404, 'Booking not found');
  return [200, booking];
}

function cancelBooking({ match, store, now }) {
  return [200, store.cancelBooking(match[1].toUpperCase(), now)];
}

const ROUTES = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: () => [200, { status: 'ok' }] },
  {
    method: 'GET',
    pattern: /^\/api\/airports$/,
    handler: () =>
      [200, Object.entries(flights.AIRPORTS).map(([code, city]) => ({ code, city }))],
  },
  { method: 'GET', pattern: /^\/api\/flights$/, handler: searchFlights },
  { method: 'POST', pattern: /^\/api\/bookings$/, handler: createBooking },
  { method: 'GET', pattern: /^\/api\/bookings\/([A-Za-z0-9]{6})$/, handler: getBooking },
  { method: 'POST', pattern: /^\/api\/bookings\/([A-Za-z0-9]{6})\/cancel$/, handler: cancelBooking },
];

async function handleRequest(req, res, store, clock) {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && Object.hasOwn(STATIC_FILES, url.pathname)) {
    const entry = STATIC_FILES[url.pathname];
    const data = await fs.readFile(path.join(PUBLIC_DIR, entry.file));
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    return res.end(data);
  }

  const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname));
  if (!route) throw new HttpError(404, 'Not found');

  const body = req.method === 'POST' ? await readJsonBody(req) : {};
  const [status, payload] = route.handler({
    url,
    match: url.pathname.match(route.pattern),
    body,
    store,
    now: clock(),
  });
  return sendJson(res, status, payload);
}

function createServer({ store = new BookingStore(), clock = () => new Date() } = {}) {
  return http.createServer((req, res) => {
    handleRequest(req, res, store, clock).catch((err) => {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`SkyHop demo airline running on http://${host}:${port}`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

module.exports = { createServer };
