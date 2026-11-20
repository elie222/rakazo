/**
 * Rounds a dollar amount down to the cent, for a total that is a floor. It cuts the number's
 * shortest decimal form rather than multiplying, so 0.29 stays 0.29 (0.29 * 100 is 28.999…)
 * while 0.289999999999 still reads 0.28.
 */
export function floorCents(usd: number): number {
  return usd < 0.01 ? 0 : Number(String(usd).replace(/(\.\d\d)\d+$/, "$1"));
}
