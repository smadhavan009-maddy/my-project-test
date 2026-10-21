(() => {
  'use strict';

  const CABIN_LABELS = { economy: 'Economy', business: 'Business' };
  const BOOKING_WINDOW_DAYS = 330; // Keep in sync with src/flights.js
  const state = { search: null, flight: null };

  const $ = (selector) => document.querySelector(selector);

  // Small DOM helper. Text is always set via textContent, so nothing is injected as HTML.
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  const money = (amount, currency) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);

  const formatDuration = (minutes) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;

  const isoDateFromNow = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA');

  function addDays(isoDate, days) {
    const date = new Date(`${isoDate}T00:00:00`);
    date.setDate(date.getDate() + days);
    return date.toLocaleDateString('en-CA');
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function setError(selector, message) {
    const node = $(selector);
    node.textContent = message || '';
    node.hidden = !message;
  }

  function showView(name) {
    for (const view of document.querySelectorAll('.view')) {
      view.classList.toggle('active', view.id === `view-${name}`);
    }
    for (const button of document.querySelectorAll('.nav-btn')) {
      button.classList.toggle('active', button.dataset.nav === name);
    }
    window.scrollTo(0, 0);
  }

  // ---- Search -------------------------------------------------------------

  function renderResults(data) {
    const list = $('#results');
    const cabinLabel = CABIN_LABELS[data.cabin];
    list.replaceChildren(
      el('h2', { text: `${data.flights.length} flight(s): ${data.from} → ${data.to} on ${data.date}` }),
    );

    if (!data.flights.length) {
      list.append(el('p', { class: 'muted', text: 'No flights left for this date. Try another day.' }));
      return;
    }

    for (const flight of data.flights) {
      const cabin = flight.cabins[data.cabin];
      const enough = cabin.seatsLeft >= data.passengers;
      const button = el('button', {
        class: 'primary',
        type: 'button',
        text: enough ? 'Select' : 'Not enough seats',
      });
      button.disabled = !enough;
      button.addEventListener('click', () => selectFlight(flight));

      list.append(
        el('article', { class: 'card flight' },
          el('div', {},
            el('div', { class: 'times', text: `${flight.departure}  ·  ${formatDuration(flight.durationMinutes)}` }),
            el('div', { class: 'muted', text: `SkyHop ${flight.flightNumber} · ${flight.fromCity} → ${flight.toCity}` }),
          ),
          el('div', { class: 'flight-side' },
            el('div', { class: 'price', text: `${money(cabin.fare, flight.currency)} / passenger` }),
            el('div', { class: 'muted', text: `${cabinLabel} · ${cabin.seatsLeft} seats left` }),
            button,
          ),
        ),
      );
    }
  }

  // ---- Passenger details & confirmation -----------------------------------

  function selectFlight(flight) {
    state.flight = flight;
    const { search } = state;
    const cabin = flight.cabins[search.cabin];
    const total = cabin.fare * search.passengers;

    $('#trip-summary').replaceChildren(
      el('h2', { text: `${flight.fromCity} → ${flight.toCity}` }),
      el('p', {
        class: 'muted',
        text: `${flight.date} · departs ${flight.departure} · ${formatDuration(flight.durationMinutes)} · SkyHop ${flight.flightNumber} · ${CABIN_LABELS[search.cabin]}`,
      }),
      el('p', {
        text: `${search.passengers} passenger(s) × ${money(cabin.fare, flight.currency)} = ${money(total, flight.currency)}`,
      }),
    );

    const fields = $('#passenger-fields');
    fields.replaceChildren();
    for (let i = 0; i < search.passengers; i++) {
      const first = el('input', { name: `first-${i}`, required: '', maxlength: '50', autocomplete: 'off' });
      const last = el('input', { name: `last-${i}`, required: '', maxlength: '50', autocomplete: 'off' });
      fields.append(
        el('fieldset', { class: 'passenger' },
          el('legend', { text: `Passenger ${i + 1}` }),
          el('label', {}, 'First name', first),
          el('label', {}, 'Last name (as on ID)', last),
        ),
      );
    }

    setError('#booking-error', '');
    showView('passengers');
  }

  function fact(label, value) {
    return el('div', { class: 'fact' }, el('dt', { text: label }), el('dd', { text: value }));
  }

  function bookingDetails(booking) {
    return el('div', {},
      el('div', { class: 'booking-head' },
        el('div', {},
          el('div', { class: 'muted', text: 'Booking reference' }),
          el('div', { class: 'pnr', text: booking.pnr }),
        ),
        el('span', { class: `status status-${booking.status.toLowerCase()}`, text: booking.status }),
      ),
      el('dl', { class: 'facts' },
        fact('Flight', `SkyHop ${booking.flightNumber}`),
        fact('Route', `${booking.fromCity} (${booking.from}) → ${booking.toCity} (${booking.to})`),
        fact('Date', booking.date),
        fact('Departure', booking.departure),
        fact('Duration', formatDuration(booking.durationMinutes)),
        fact('Cabin', CABIN_LABELS[booking.cabin]),
        fact('Contact', booking.contactEmail),
        fact('Total paid', money(booking.totalAmount, booking.currency)),
      ),
      el('h3', { text: 'Passengers' }),
      el('ol', {}, ...booking.passengers.map((p) => el('li', { text: `${p.firstName} ${p.lastName}` }))),
    );
  }

  function renderConfirmation(booking) {
    $('#confirmation').replaceChildren(
      el('h2', { text: 'Booking confirmed' }),
      bookingDetails(booking),
      el('div', { class: 'actions' },
        el('button', { class: 'secondary', type: 'button', text: 'Print', onclick: () => window.print() }),
      ),
    );
  }

  // ---- Manage booking -----------------------------------------------------

  function renderManaged(booking) {
    const container = $('#booking-details');
    container.replaceChildren(el('div', { class: 'card' }, bookingDetails(booking)));

    if (booking.status === 'CONFIRMED') {
      const cancel = el('button', { class: 'danger', type: 'button', text: 'Cancel booking' });
      cancel.addEventListener('click', () => cancelBooking(booking.pnr));
      container.firstChild.append(el('div', { class: 'actions' }, cancel));
    } else {
      container.firstChild.append(el('p', { class: 'muted', text: 'This booking has been cancelled and its seats released.' }));
    }
  }

  async function cancelBooking(pnr) {
    if (!window.confirm(`Cancel booking ${pnr}? The seats will be released.`)) return;
    try {
      renderManaged(await api(`/api/bookings/${encodeURIComponent(pnr)}/cancel`, { method: 'POST' }));
      setError('#lookup-error', '');
    } catch (err) {
      setError('#lookup-error', err.message);
    }
  }

  // ---- Event wiring -------------------------------------------------------

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-nav]');
    if (target) showView(target.dataset.nav);
  });

  $('#search-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const params = new URLSearchParams(new FormData(form));
    setError('#search-error', '');
    try {
      const data = await api(`/api/flights?${params}`);
      state.search = data;
      renderResults(data);
    } catch (err) {
      $('#results').replaceChildren();
      setError('#search-error', err.message);
    }
  });

  $('#passenger-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const { search, flight } = state;

    const passengers = [];
    for (let i = 0; i < search.passengers; i++) {
      passengers.push({
        firstName: form.elements[`first-${i}`].value,
        lastName: form.elements[`last-${i}`].value,
      });
    }

    setError('#booking-error', '');
    try {
      const booking = await api('/api/bookings', {
        method: 'POST',
        body: JSON.stringify({
          flightId: flight.id,
          cabin: search.cabin,
          passengers,
          contactEmail: form.elements.contactEmail.value,
        }),
      });
      renderConfirmation(booking);
      showView('confirmation');
    } catch (err) {
      setError('#booking-error', err.message);
    }
  });

  $('#lookup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const pnr = new FormData(event.currentTarget).get('pnr').trim().toUpperCase();
    setError('#lookup-error', '');
    try {
      renderManaged(await api(`/api/bookings/${encodeURIComponent(pnr)}`));
    } catch (err) {
      $('#booking-details').replaceChildren();
      setError('#lookup-error', err.message);
    }
  });

  async function init() {
    const today = new Date().toLocaleDateString('en-CA');
    const dateInput = $('#search-form [name="date"]');
    dateInput.min = today;
    dateInput.max = isoDateFromNow(BOOKING_WINDOW_DAYS);
    dateInput.value = addDays(today, 1);

    const from = $('#search-form [name="from"]');
    const to = $('#search-form [name="to"]');
    try {
      const airports = await api('/api/airports');
      for (const airport of airports) {
        const label = `${airport.city} (${airport.code})`;
        from.append(el('option', { value: airport.code, text: label }));
        to.append(el('option', { value: airport.code, text: label }));
      }
      from.value = 'DEL';
      to.value = 'BOM';
    } catch (err) {
      setError('#search-error', `Could not load airports: ${err.message}`);
    }
  }

  init();
})();
