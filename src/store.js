'use strict';

// In-memory booking store. Data is lost when the process restarts,
// which is fine for a demo.

const crypto = require('node:crypto');
const { CABINS, departsAt } = require('./flights');
const { HttpError } = require('./errors');

// 32 characters with no 0/O/1/I, so references are easy to read aloud.
const PNR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class BookingStore {
  constructor() {
    this.bookings = new Map(); // pnr -> booking
    this.soldByFlight = new Map(); // flightId -> { economy, business }
  }

  seatsSold(flightId, cabin) {
    const sold = this.soldByFlight.get(flightId);
    return sold ? sold[cabin] : 0;
  }

  seatsLeft(flightId, cabin) {
    return CABINS[cabin].capacity - this.seatsSold(flightId, cabin);
  }

  adjustSeats(flightId, cabin, delta) {
    const sold = this.soldByFlight.get(flightId) || { economy: 0, business: 0 };
    sold[cabin] += delta;
    this.soldByFlight.set(flightId, sold);
  }

  generatePnr() {
    for (let attempt = 0; attempt < 10; attempt++) {
      let pnr = '';
      for (const byte of crypto.randomBytes(6)) {
        pnr += PNR_ALPHABET[byte % PNR_ALPHABET.length];
      }
      if (!this.bookings.has(pnr)) return pnr;
    }
    throw new Error('Could not generate a unique booking reference');
  }

  createBooking({ flight, cabin, passengers, contactEmail }) {
    const count = passengers.length;
    const left = this.seatsLeft(flight.id, cabin);
    if (left < count) {
      throw new HttpError(409, `Only ${left} ${CABINS[cabin].label} seat(s) left on this flight`);
    }

    const booking = {
      pnr: this.generatePnr(),
      status: 'CONFIRMED',
      flightId: flight.id,
      flightNumber: flight.flightNumber,
      from: flight.from,
      fromCity: flight.fromCity,
      to: flight.to,
      toCity: flight.toCity,
      date: flight.date,
      departure: flight.departure,
      durationMinutes: flight.durationMinutes,
      cabin,
      passengers,
      contactEmail,
      farePerPassenger: flight.cabins[cabin].fare,
      totalAmount: flight.cabins[cabin].fare * count,
      currency: flight.currency,
      createdAt: new Date().toISOString(),
    };

    this.bookings.set(booking.pnr, booking);
    this.adjustSeats(flight.id, cabin, count);
    return booking;
  }

  getBooking(pnr) {
    return this.bookings.get(pnr) || null;
  }

  cancelBooking(pnr, now = new Date()) {
    const booking = this.getBooking(pnr);
    if (!booking) throw new HttpError(404, 'Booking not found');
    if (booking.status === 'CANCELLED') throw new HttpError(409, 'Booking is already cancelled');
    if (departsAt(booking) <= now) throw new HttpError(409, 'This flight has already departed');

    booking.status = 'CANCELLED';
    booking.cancelledAt = now.toISOString();
    this.adjustSeats(booking.flightId, booking.cabin, -booking.passengers.length);
    return booking;
  }
}

module.exports = { BookingStore };
