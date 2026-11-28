"use strict";

// COUNTRY NAMES, server-side, for grouping the free-text profile `country`.
//
// `users.country` is free text (lib/util.js; nothing computes with it): the
// SPA's profile select stores the ISO 3166 alpha-2 CODE (public/js/data/
// country-tz.js COUNTRY_TZ keys, e.g. "GB"), imports store whatever their file
// held ("UK", "USA", "United States"). `countryName(raw)` folds them into one
// row per country, named as the profile select names it:
//   * the names are READ from public/js/data/country-tz.js at first use (its
//     `"XX":{"n":"Name"` lines), never copied, so a renamed or added country
//     reaches this file with no second edit;
//   * an alpha-2 code, an alpha-3 code (ALPHA3 below, one per COUNTRY_TZ key,
//     locked both ways by tests/countries.spec.js), a select name and the common
//     abbreviations (USA, U.S., UK, U.K., Great Britain) all match,
//     case-blind, dots dropped, spaces collapsed;
//   * anything else is shown as typed (trimmed), grouped case- and space-blind.
// Requires only fs and path.

const fs = require("fs");
const path = require("path");

const ALPHA3 = Object.freeze({
  AF: "AFG", AL: "ALB", DZ: "DZA", AD: "AND", AO: "AGO", AG: "ATG", AR: "ARG", AM: "ARM", AU: "AUS", AT: "AUT",
  AZ: "AZE", BS: "BHS", BH: "BHR", BD: "BGD", BB: "BRB", BY: "BLR", BE: "BEL", BZ: "BLZ", BJ: "BEN", BT: "BTN",
  BO: "BOL", BA: "BIH", BW: "BWA", BR: "BRA", BN: "BRN", BG: "BGR", BF: "BFA", BI: "BDI", CV: "CPV", KH: "KHM",
  CM: "CMR", CA: "CAN", CF: "CAF", TD: "TCD", CL: "CHL", CN: "CHN", CO: "COL", KM: "COM", CG: "COG", CD: "COD",
  CR: "CRI", CI: "CIV", HR: "HRV", CU: "CUB", CY: "CYP", CZ: "CZE", DK: "DNK", DJ: "DJI", DM: "DMA", DO: "DOM",
  EC: "ECU", EG: "EGY", SV: "SLV", GQ: "GNQ", ER: "ERI", EE: "EST", SZ: "SWZ", ET: "ETH", FJ: "FJI", FI: "FIN",
  FR: "FRA", GA: "GAB", GM: "GMB", GE: "GEO", DE: "DEU", GH: "GHA", GR: "GRC", GD: "GRD", GT: "GTM", GN: "GIN",
  GW: "GNB", GY: "GUY", HT: "HTI", HN: "HND", HU: "HUN", IS: "ISL", IN: "IND", ID: "IDN", IR: "IRN", IQ: "IRQ",
  IE: "IRL", IL: "ISR", IT: "ITA", JM: "JAM", JP: "JPN", JO: "JOR", KZ: "KAZ", KE: "KEN", KI: "KIR", KP: "PRK",
  KR: "KOR", KW: "KWT", KG: "KGZ", LA: "LAO", LV: "LVA", LB: "LBN", LS: "LSO", LR: "LBR", LY: "LBY", LI: "LIE",
  LT: "LTU", LU: "LUX", MG: "MDG", MW: "MWI", MY: "MYS", MV: "MDV", ML: "MLI", MT: "MLT", MH: "MHL", MR: "MRT",
  MU: "MUS", MX: "MEX", FM: "FSM", MD: "MDA", MC: "MCO", MN: "MNG", ME: "MNE", MA: "MAR", MZ: "MOZ", MM: "MMR",
  NA: "NAM", NR: "NRU", NP: "NPL", NL: "NLD", NZ: "NZL", NI: "NIC", NE: "NER", NG: "NGA", MK: "MKD", NO: "NOR",
  OM: "OMN", PK: "PAK", PW: "PLW", PS: "PSE", PA: "PAN", PG: "PNG", PY: "PRY", PE: "PER", PH: "PHL", PL: "POL",
  PT: "PRT", QA: "QAT", RO: "ROU", RU: "RUS", RW: "RWA", KN: "KNA", LC: "LCA", VC: "VCT", WS: "WSM", SM: "SMR",
  ST: "STP", SA: "SAU", SN: "SEN", RS: "SRB", SC: "SYC", SL: "SLE", SG: "SGP", SK: "SVK", SI: "SVN", SB: "SLB",
  SO: "SOM", ZA: "ZAF", SS: "SSD", ES: "ESP", LK: "LKA", SD: "SDN", SR: "SUR", SE: "SWE", CH: "CHE", SY: "SYR",
  TW: "TWN", TJ: "TJK", TZ: "TZA", TH: "THA", TL: "TLS", TG: "TGO", TO: "TON", TT: "TTO", TN: "TUN", TR: "TUR",
  TM: "TKM", TV: "TUV", UG: "UGA", UA: "UKR", AE: "ARE", GB: "GBR", US: "USA", UY: "URY", UZ: "UZB", VU: "VUT",
  VA: "VAT", VE: "VEN", VN: "VNM", YE: "YEM", ZM: "ZMB", ZW: "ZWE",
});
// Abbreviations an import commonly carries (folded form -> alpha-2).
const ALIASES = Object.freeze({ uk: "GB", "great britain": "GB", us: "US", usa: "US" });

const COUNTRY_FILE = path.join(__dirname, "..", "public", "js", "data", "country-tz.js");
let _names = null;   // alpha-2 -> select name
let _byKey = null;   // folded spelling -> alpha-2

/** The profile select's names, read from its own table: Map alpha-2 -> name. */
function countryNames() {
  if (_names) return _names;
  const src = fs.readFileSync(COUNTRY_FILE, "utf8");
  _names = new Map([...src.matchAll(/^"([A-Z]{2})":\{"n":"([^"]+)"/gm)].map(m => [m[1], m[2]]));
  return _names;
}

/** Case-blind, dots dropped, whitespace collapsed. */
function foldCountry(s) { return String(s || "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim(); }

function _index() {
  if (_byKey) return _byKey;
  _byKey = new Map();
  for (const [cc, name] of countryNames()) {
    _byKey.set(cc.toLowerCase(), cc);
    if (ALPHA3[cc]) _byKey.set(ALPHA3[cc].toLowerCase(), cc);
    _byKey.set(foldCountry(name), cc);
  }
  for (const [k, cc] of Object.entries(ALIASES)) _byKey.set(k, cc);
  return _byKey;
}

/**
 * One profile country as a group: `{key, name}`. A recognised country is keyed
 * by its alpha-2 code and named as the select names it; anything else keeps
 * its folded spelling as the key and is shown as typed. Empty: null.
 */
function countryName(raw) {
  const typed = String(raw || "").replace(/\s+/g, " ").trim();
  if (!typed) return null;
  const k = foldCountry(typed);
  const cc = _index().get(k);
  return cc ? { key: `cc:${cc}`, name: countryNames().get(cc) } : { key: `t:${k}`, name: typed };
}

module.exports = { countryName, countryNames, foldCountry, ALPHA3, ALIASES };
