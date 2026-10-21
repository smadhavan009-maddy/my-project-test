'use strict';

// Demo flight schedule. Flights are generated deterministically from the
// route, date and departure slot, so no flight database is needed.

const AIRPORTS = {
  DEL: 'Delhi',
  BOM: 'Mumbai',
  BLR: 'Bengaluru',
  HYD: 'Hyderabad',
  MAA: 'Chennai',
  CCU: 'Kolkata',
  GOI: 'Goa',
  COK: 'Kochi',
};

const AIRPORT_CODES = Object.keys(AIRPORTS);

const CABINS = {
  economy: { label: 'Economy', capacity: 150, multiplier: 1 },
  business: { label: 'Business', capacity: 12, multiplier: 2.8 },
};

const DEPARTURE_SLOTS = ['06:30', '12:15', '18:40'];
const SLOT_FARE_ADJUSTMENT = [0, -300, 400];
const CURRENCY = 'INR';
const BOOKING_WINDOW_DAYS = 330;

// Flight id = <FROM><TO><YYYYMMDD><slot index>, e.g. DELBOM202610250
const FLIGHT_ID_PATTERN = /^([A-Z]{3})([A-Z]{3})(\d{4})(\d{2})(\d{2})([0-2])$/;

function isValidAirport(code) {
  return Object.hasOwn(AIRPORTS, code);
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function isWithinBookingWindow(isoDate, now = new Date()) {
  const earliest = toIsoDate(now);
  const latest = toIsoDate(new Date(now.getTime() + BOOKING_WINDOW_DAYS * 86400000));
  return isoDate >= earliest && isoDate <= latest;
}

// Small deterministic hash so the same route always gets the same fare and duration.
function hash(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

const roundTo10 = (amount) => Math.round(amount / 10) * 10;

function buildFlightId(from, to, isoDate, slot) {
  return `${from}${to}${isoDate.replaceAll('-', '')}${slot}`;
}

function parseFlightId(id) {
  const match = FLIGHT_ID_PATTERN.exec(String(id));
  if (!match) return null;
  const [, from, to, year, month, day, slot] = match;
  const isoDate = `${year}-${month}-${day}`;
  if (!isValidAirport(from) || !isValidAirport(to) || from === to || !isValidIsoDate(isoDate)) {
    return null;
  }
  return { from, to, isoDate, slot: Number(slot) };
}

function buildFlight(from, to, isoDate, slot) {
  const route = hash(from + to);
  const baseFare = 2500 + (route % 40) * 100;
  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  const weekendSurcharge = weekday === 5 || weekday === 0 ? 600 : 0; // Fri and Sun
  const economyFare = roundTo10(baseFare + SLOT_FARE_ADJUSTMENT[slot] + weekendSurcharge);
  const routeIndex = AIRPORT_CODES.indexOf(from) * AIRPORT_CODES.length + AIRPORT_CODES.indexOf(to);

  const cabins = {};
  for (const [key, cabin] of Object.entries(CABINS)) {
    cabins[key] = {
      label: cabin.label,
      fare: roundTo10(economyFare * cabin.multiplier),
      capacity: cabin.capacity,
    };
  }

  return {
    id: buildFlightId(from, to, isoDate, slot),
    flightNumber: `SK${100 + routeIndex * DEPARTURE_SLOTS.length + slot}`,
    from,
    fromCity: AIRPORTS[from],
    to,
    toCity: AIRPORTS[to],
    date: isoDate,
    departure: DEPARTURE_SLOTS[slot],
    durationMinutes: 70 + (route % 110),
    currency: CURRENCY,
    cabins,
  };
}

function listFlights(from, to, isoDate) {
  return DEPARTURE_SLOTS.map((_, slot) => buildFlight(from, to, isoDate, slot));
}

// Times are treated as UTC because the demo has no timezone data.
function departsAt(flight) {
  return new Date(`${flight.date}T${flight.departure}:00Z`);
}

module.exports = {
  AIRPORTS,
  CABINS,
  BOOKING_WINDOW_DAYS,
  isValidAirport,
  isValidIsoDate,
  isWithinBookingWindow,
  parseFlightId,
  buildFlight,
  listFlights,
  departsAt,
};
