/**
 * The edition catalogue a profile builder offers (FLR-T-6.8, FLR-REQ-100): the model codes a US
 * house is usually built under, each with its publisher, the trade it covers and the editions that
 * have been published. Data only — names and years, never a word of any code's text (0.7).
 *
 * A profile is not limited to this list: a jurisdiction's own code ("a state building code", a
 * local ordinance) is any code name matching the citation grammar (Rules 3.2), with any edition.
 * The catalogue is what the builder suggests, not what it accepts.
 */

/** The trade a code covers, in the order a profile builder lists them. */
export type Domain = 'building' | 'electrical' | 'plumbing' | 'mechanical' | 'fuelGas' | 'energy' | 'other';

export const DOMAINS: readonly { readonly id: Domain; readonly title: string }[] = [
  { id: 'building', title: 'Building' },
  { id: 'electrical', title: 'Electrical' },
  { id: 'plumbing', title: 'Plumbing' },
  { id: 'mechanical', title: 'Mechanical' },
  { id: 'fuelGas', title: 'Fuel gas' },
  { id: 'energy', title: 'Energy' },
  { id: 'other', title: 'Other' },
];

export interface CodeInfo {
  /** The short name a citation uses (Rules 3.2): `IRC`. */
  readonly code: string;
  readonly title: string;
  readonly publisher: string;
  readonly domain: Domain;
  /** The published editions, oldest first. */
  readonly editions: readonly string[];
}

/** The model codes, by domain and then name. Editions are the years each was published. */
export const CODES: readonly CodeInfo[] = [
  { code: 'IRC', title: 'International Residential Code', publisher: 'International Code Council', domain: 'building', editions: ['2012', '2015', '2018', '2021', '2024'] },
  { code: 'NEC', title: 'National Electrical Code (NFPA 70)', publisher: 'National Fire Protection Association', domain: 'electrical', editions: ['2014', '2017', '2020', '2023', '2026'] },
  { code: 'IPC', title: 'International Plumbing Code', publisher: 'International Code Council', domain: 'plumbing', editions: ['2015', '2018', '2021', '2024'] },
  { code: 'UPC', title: 'Uniform Plumbing Code', publisher: 'IAPMO', domain: 'plumbing', editions: ['2015', '2018', '2021', '2024'] },
  { code: 'IMC', title: 'International Mechanical Code', publisher: 'International Code Council', domain: 'mechanical', editions: ['2015', '2018', '2021', '2024'] },
  { code: 'UMC', title: 'Uniform Mechanical Code', publisher: 'IAPMO', domain: 'mechanical', editions: ['2015', '2018', '2021', '2024'] },
  { code: 'IFGC', title: 'International Fuel Gas Code', publisher: 'International Code Council', domain: 'fuelGas', editions: ['2015', '2018', '2021', '2024'] },
  { code: 'IECC', title: 'International Energy Conservation Code', publisher: 'International Code Council', domain: 'energy', editions: ['2015', '2018', '2021', '2024'] },
];

const BY_CODE = new Map(CODES.map((c) => [c.code, c]));

/** What the catalogue knows of a code, or undefined for a code it does not list. */
export const codeInfo = (code: string): CodeInfo | undefined => BY_CODE.get(code);

/**
 * The domain of a code: the catalogue's, else `other`. The synthetic codes of the standard's
 * example packs (`TEST-CODE`, `TEST-ELEC`) are read by their name, so a test profile sorts sensibly.
 */
export function domainOf(code: string): Domain {
  const known = BY_CODE.get(code)?.domain;
  if (known !== undefined) return known;
  if (/(^|-)ELEC(-|$)/.test(code)) return 'electrical';
  if (/(^|-)PLUMB(-|$)/.test(code)) return 'plumbing';
  if (/(^|-)MECH(-|$)/.test(code)) return 'mechanical';
  if (/(^|-)GAS(-|$)/.test(code)) return 'fuelGas';
  if (/(^|-)(CODE|BLDG|BUILDING)(-|$)/.test(code)) return 'building';
  return 'other';
}

export const domainTitle = (domain: Domain): string => DOMAINS.find((d) => d.id === domain)?.title ?? 'Other';

/** The newest edition the catalogue lists for a code, or undefined. */
export const latestEdition = (code: string): string | undefined => BY_CODE.get(code)?.editions.at(-1);

/** The order of domains, for sorting. */
export const domainRank = (domain: Domain): number => DOMAINS.findIndex((d) => d.id === domain);
