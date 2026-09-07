export type Id = string;

/** Generate a prefixed id, e.g. newId("th") -> "th_1a2b3c...". */
export const newId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
