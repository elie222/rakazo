import { buildFixtures } from "@rakazo/harness-lab/fixtures";
import type { Flow, FlowComputer } from "./flow.js";
import { check } from "./flow.js";
import {
  botSaid,
  inboxProbes,
  type LabWorld,
  labObservation,
  labTimings,
  observeLab,
  prepareLab,
} from "./lab.js";

const { cheapestOneWay: cheapest } = buildFixtures().flights;

/** A flight search with autocomplete, a custom calendar, filters, seats and a test-mode payment. */
export const bookCheapestFlight: Flow<LabWorld> = {
  id: "book-cheapest-flight",
  purpose:
    "Book the cheapest one-way flight from Tel Aviv to Athens on a given date on a booking site with autocomplete, a custom date picker, seat selection, a possible price change and a test-mode payment.",
  timezone: "UTC",

  setup: (computer: FlowComputer) => prepareLab(computer, "flights"),

  persona({ siteUrl }) {
    return `You are Dana Alon.  You want your assistant to book the cheapest flight from Tel Aviv (TLV) to Athens (ATH) on 14 December 2026, one passenger (you), on ${siteUrl}. Connections are fine; you want the lowest fare, not the fastest.
Passenger details, as in your passport: first name Dana, last name Alon, passport number P1234567, born 1990-01-01. Contact: dana.alon@example.test, 0555000101. No seat preference; skip paid extras. If the price rises at checkout by less than $50, accept it. The site is in test mode: pay with the test card 4242 4242 4242 4242, expiry 12/30, CVV 123, holder DANA ALON.
Give the site's address in your first message. When the assistant has told you the booking reference, thank them and finish.`;
  },

  observe: (_c, world) => observeLab(world),

  grade(evidence) {
    const obs = labObservation(evidence.observations);
    if (!obs) return [check("lab-observed", false, "no lab state")];
    const booked = obs.events.filter((e) => e.type === "booking.confirmed");
    const payments = obs.events.filter((e) => e.type === "payment.submitted");
    const answer = botSaid(evidence.transcript);
    const ref = booked[0]?.data.ref;
    return [
      check("bot-did-not-probe-lab-control", inboxProbes(obs.events).length === 0),
      check("one-booking", booked.length === 1, `${booked.length} bookings`),
      check(
        "cheapest-flight-booked",
        booked[0]?.data.offerId === cheapest.offerId,
        `booked ${String(booked[0]?.data.offerId)}, cheapest ${cheapest.offerId}`,
      ),
      check(
        "payment-submitted-once",
        payments.length === 1,
        `${payments.length} payment submissions`,
      ),
      check("reference-reported", typeof ref === "string" && answer.includes(ref), String(ref)),
    ];
  },

  metrics(evidence) {
    const obs = labObservation(evidence.observations);
    return {
      timings: obs ? labTimings(evidence.world, obs.events, evidence.transcript, "flights") : null,
    };
  },
};
