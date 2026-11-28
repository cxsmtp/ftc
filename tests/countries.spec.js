// lib/countries.js `countryName`, by value: every spelling a profile can hold
// for one country is one group, named as the profile select (public/js/data/
// country-tz.js COUNTRY_TZ) names it; anything else is shown as typed.
const { test, expect } = require("./isolated-test");
const C = require("../lib/countries");

test("codes, names and the usual abbreviations fold to the select's name; the rest stay as typed", () => {
  const one = (xs) => [...new Set(xs.map(x => JSON.stringify(C.countryName(x))))];
  expect(one(["US", "usa", "United States", "U.S.", "U.S.A.", "  united   STATES "])).toEqual([JSON.stringify({ key: "cc:US", name: "United States" })]);
  expect(one(["GB", "gbr", "UK", "u.k.", "Great Britain", "United Kingdom"])).toEqual([JSON.stringify({ key: "cc:GB", name: "United Kingdom" })]);
  expect(C.countryName("DEU")).toEqual({ key: "cc:DE", name: "Germany" });
  expect(C.countryName("de")).toEqual({ key: "cc:DE", name: "Germany" });
  expect(C.countryName("  Atlantis ")).toEqual({ key: "t:atlantis", name: "Atlantis" });
  expect(C.countryName("ATLANTIS").key, "an unrecognised value groups case-blind").toBe("t:atlantis");
  expect(C.countryName(""), "nothing given").toBeNull();
  expect(C.countryName(null)).toBeNull();
  // CONTROL: two countries stay apart.
  expect(C.countryName("US").key).not.toBe(C.countryName("UK").key);
});

test("the names are the select's own, and every select country has one alpha-3 code (both ways, no duplicate)", () => {
  const names = C.countryNames();
  expect(names.size, "anti-vacuity: the select's table was read").toBeGreaterThan(150);
  expect(names.get("GB")).toBe("United Kingdom");
  expect([...names.keys()].filter(cc => !C.ALPHA3[cc]), "a select country without an alpha-3 code").toEqual([]);
  expect(Object.keys(C.ALPHA3).filter(cc => !names.has(cc)), "an alpha-3 entry for no select country").toEqual([]);
  const a3 = Object.values(C.ALPHA3);
  expect(a3.length).toBe(new Set(a3).size);
  expect(a3.every(x => /^[A-Z]{3}$/.test(x))).toBe(true);
  // Every code and alias resolves to a select country.
  for (const cc of names.keys()) expect(C.countryName(C.ALPHA3[cc]).key, cc).toBe(`cc:${cc}`);
  for (const [k, cc] of Object.entries(C.ALIASES)) expect(names.has(cc), k).toBe(true);
});
