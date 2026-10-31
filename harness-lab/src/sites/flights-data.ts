import { AIRLINES } from "../data.js";
import { hash, rng } from "../lib/core.js";

export interface Offer {
  id: string;
  airline: string;
  flightNo: string;
  from: string;
  to: string;
  date: string;
  dep: string;
  arr: string;
  durationMin: number;
  stops: number;
  via?: string;
  pricePerPax: number;
  checkedBag: boolean;
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function offersFor(from: string, to: string, date: string): Offer[] {
  const r = rng(`${from}>${to}@${date}`);
  const base = 90 + (hash(`${from}${to}`) % 260);
  const used = new Set<number>();
  const out: Offer[] = [];
  for (let i = 0; i < 12; i++) {
    const airline = AIRLINES[Math.floor(r() * AIRLINES.length)]!;
    const stops = r() < 0.4 ? 0 : r() < 0.8 ? 1 : 2;
    const dur = 150 + (hash(`${from}${to}`) % 240) + stops * (70 + Math.floor(r() * 120));
    const depMin = 5 * 60 + Math.floor(r() * 18 * 12) * 5;
    let price = Math.round(base * (0.7 + r() * 0.9) + (stops === 0 ? 40 : 0));
    while (used.has(price)) price += 1;
    used.add(price);
    const flightNo = `${airline.code}${100 + Math.floor(r() * 899)}`;
    out.push({
      id: `${flightNo}-${i}-${date}`,
      airline: airline.name,
      flightNo,
      from,
      to,
      date,
      dep: hhmm(depMin),
      arr: hhmm(depMin + dur),
      durationMin: dur,
      stops,
      via: stops ? ["LCA", "FCO", "AMS"][Math.floor(r() * 3)] : undefined,
      pricePerPax: price,
      checkedBag: r() > 0.5,
    });
  }
  return out;
}

export function cheapestFlight(
  from: string,
  to: string,
  date: string,
  pax: number,
  directOnly = false,
) {
  const list = offersFor(from, to, date).filter((o) => !directOnly || o.stops === 0);
  const best = list.reduce((a, b) => (b.pricePerPax < a.pricePerPax ? b : a));
  return {
    offerId: best.id,
    airline: best.airline,
    flightNo: best.flightNo,
    dep: best.dep,
    stops: best.stops,
    pricePerPax: best.pricePerPax,
    total: best.pricePerPax * pax,
  };
}

/** Roughly one offer in four re-prices at checkout. Deterministic per offer. */
export function repricedPrice(o: Offer): number | null {
  return hash(o.id) % 4 === 0 ? o.pricePerPax + 17 + (hash(`${o.id}!`) % 30) : null;
}
