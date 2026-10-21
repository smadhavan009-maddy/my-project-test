'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { BookingStore } = require('../src/store');
const flights = require('../src/flights');

// Fixed clock: 2026-10-21 10:00 UTC. Tests use dates relative to this.
const NOW = new Date('2026-10-21T10:00:00Z');
const TOMORROW = '2026-10-22';

let server;
let base;

before(async () => {
  server = createServer({ store: new BookingStore(), clock: () => NOW });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const search = (params) => call('GET', `/api/flights?${new URLSearchParams(params)}`);

const passenger = (firstName = 'Asha', lastName = 'Rao') => ({ firstName, lastName });

async function firstFlightId(from = 'DEL', to = 'BOM', date = TOMORROW) {
  const { body } = await search({ from, to, date, passengers: 1 });
  return body.flights[0].id;
}

test('flight id round-trips through parse and build', () => {
  const parsed = flights.parseFlightId('DELBOM202610222');
  assert.deepEqual(parsed, { from: 'DEL', to: 'BOM', isoDate: TOMORROW, slot: 2 });
  assert.equal(flights.buildFlight(parsed.from, parsed.to, parsed.isoDate, parsed.slot).id, 'DELBOM202610222');
  assert.equal(flights.parseFlightId('DELDEL202610220'), null);
  assert.equal(flights.parseFlightId('garbage'), null);
});

test('health and airports endpoints respond', async () => {
  assert.deepEqual((await call('GET', '/api/health')).body, { status: 'ok' });
  const { body } = await call('GET', '/api/airports');
  assert.ok(body.some((a) => a.code === 'DEL' && a.city === 'Delhi'));
});

test('search returns three departures with seat availability', async () => {
  const { status, body } = await search({ from: 'DEL', to: 'BOM', date: TOMORROW, passengers: 2, cabin: 'business' });
  assert.equal(status, 200);
  assert.equal(body.flights.length, 3);
  for (const flight of body.flights) {
    assert.equal(flight.cabins.business.seatsLeft, 12);
    assert.equal(flight.cabins.economy.seatsLeft, 150);
    assert.ok(flight.cabins.business.fare > flight.cabins.economy.fare);
  }
});

test('search rejects same origin/destination, unknown airports and past dates', async () => {
  assert.equal((await search({ from: 'DEL', to: 'DEL', date: TOMORROW })).status, 400);
  assert.equal((await search({ from: 'XXX', to: 'BOM', date: TOMORROW })).status, 400);
  assert.equal((await search({ from: 'DEL', to: 'BOM', date: '2026-10-01' })).status, 400);
  assert.equal((await search({ from: 'DEL', to: 'BOM', date: 'not-a-date' })).status, 400);
  assert.equal((await search({ from: 'DEL', to: 'BOM', date: TOMORROW, passengers: 10 })).status, 400);
});

test('booking creates a reservation, reduces seats and can be looked up', async () => {
  const flightId = await firstFlightId();
  const created = await call('POST', '/api/bookings', {
    flightId,
    cabin: 'economy',
    passengers: [passenger(), passenger('Ravi', 'Kumar')],
    contactEmail: 'traveller@example.com',
  });
  assert.equal(created.status, 201);
  assert.match(created.body.pnr, /^[A-Z2-9]{6}$/);
  assert.equal(created.body.status, 'CONFIRMED');
  assert.equal(created.body.passengers.length, 2);
  assert.equal(created.body.totalAmount, created.body.farePerPassenger * 2);

  const lookup = await call('GET', `/api/bookings/${created.body.pnr.toLowerCase()}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.pnr, created.body.pnr);

  const after = await search({ from: 'DEL', to: 'BOM', date: TOMORROW, passengers: 1 });
  const flight = after.body.flights.find((f) => f.id === flightId);
  assert.equal(flight.cabins.economy.seatsLeft, 148);
});

test('booking validates passengers, email and cabin', async () => {
  const flightId = await firstFlightId('DEL', 'BLR');
  const base = { flightId, cabin: 'economy', passengers: [passenger()], contactEmail: 'a@b.co' };

  assert.equal((await call('POST', '/api/bookings', { ...base, passengers: [] })).status, 400);
  assert.equal((await call('POST', '/api/bookings', { ...base, passengers: [{ firstName: 'Solo' }] })).status, 400);
  assert.equal((await call('POST', '/api/bookings', { ...base, passengers: [passenger('123', 'Bad')] })).status, 400);
  assert.equal((await call('POST', '/api/bookings', { ...base, contactEmail: 'not-an-email' })).status, 400);
  assert.equal((await call('POST', '/api/bookings', { ...base, cabin: 'first' })).status, 400);
  assert.equal((await call('POST', '/api/bookings', { ...base, flightId: 'nope' })).status, 400);
  assert.equal((await call('POST', '/api/bookings', null)).status, 400);
});

test('business cabin cannot be overbooked', async () => {
  const flightId = await firstFlightId('BOM', 'BLR');
  const nine = Array.from({ length: 9 }, (_, i) => passenger('Pax', `Group ${'ABCDEFGHI'[i]}`));
  const first = await call('POST', '/api/bookings', {
    flightId,
    cabin: 'business',
    passengers: nine,
    contactEmail: 'group@example.com',
  });
  assert.equal(first.status, 201);

  const tooMany = await call('POST', '/api/bookings', {
    flightId,
    cabin: 'business',
    passengers: [passenger(), passenger(), passenger(), passenger()],
    contactEmail: 'late@example.com',
  });
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.body.error, /3 Business seat\(s\) left/);
});

test('cancelling releases seats and cannot be repeated', async () => {
  const flightId = await firstFlightId('HYD', 'MAA');
  const created = await call('POST', '/api/bookings', {
    flightId,
    cabin: 'economy',
    passengers: [passenger(), passenger('Meera', 'Iyer')],
    contactEmail: 'cancel@example.com',
  });

  const cancelled = await call('POST', `/api/bookings/${created.body.pnr}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'CANCELLED');

  const again = await call('POST', `/api/bookings/${created.body.pnr}/cancel`);
  assert.equal(again.status, 409);

  const after = await search({ from: 'HYD', to: 'MAA', date: TOMORROW, passengers: 1 });
  assert.equal(after.body.flights.find((f) => f.id === flightId).cabins.economy.seatsLeft, 150);
});

test('unknown booking returns 404 and unknown routes return 404', async () => {
  assert.equal((await call('GET', '/api/bookings/ZZZZZ9')).status, 404);
  assert.equal((await call('POST', '/api/bookings/ZZZZZ9/cancel')).status, 404);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('static UI is served with security headers', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});
