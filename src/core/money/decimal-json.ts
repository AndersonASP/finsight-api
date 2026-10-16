import { Prisma } from "@prisma/client";

/**
 * By default Prisma.Decimal serializes to JSON via `.toString()`, which drops
 * trailing zeros ("150" instead of "150.00"). Every money field in this API
 * is meant to always render as a fixed 2-decimal string, so patch it once
 * globally rather than remembering `.toFixed(2)` at every response site.
 */
Prisma.Decimal.prototype.toJSON = function (this: Prisma.Decimal) {
  return this.toFixed(2);
};
