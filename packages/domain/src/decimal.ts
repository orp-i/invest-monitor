import { Decimal } from "decimal.js";
import { DecimalString } from "./schemas.js";
import type { Result } from "./result.js";

export interface DecimalNormalizationError {
  readonly message: string;
  readonly input: unknown;
}

const NULL_LIKE = new Set(["", "null", "n/a", "na", "none", "undefined", "-"]);

/**
 * Converts provider numbers and decimal variants to the plain representation
 * accepted by DecimalString. Financial values never leave this boundary as a
 * JavaScript number.
 */
export function normalizeDecimal(
  input: unknown,
): Result<string, DecimalNormalizationError> {
  if (input === null || input === undefined) {
    return { ok: false, error: { message: "decimal value is null", input } };
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (NULL_LIKE.has(trimmed.toLowerCase())) {
      return { ok: false, error: { message: "decimal value is empty", input } };
    }
  }

  if (typeof input !== "string" && typeof input !== "number" && typeof input !== "bigint") {
    return { ok: false, error: { message: "decimal value has an unsupported type", input } };
  }

  const raw = String(input).trim().replaceAll(",", "").replace(/^\+/, "");
  try {
    const decimal = new Decimal(raw);
    if (!decimal.isFinite()) {
      return { ok: false, error: { message: "decimal value is not finite", input } };
    }
    const plain = decimal.toFixed();
    const checked = DecimalString.safeParse(plain);
    if (!checked.success) {
      return { ok: false, error: { message: "normalized value is not a DecimalString", input } };
    }
    return { ok: true, value: checked.data };
  } catch {
    return { ok: false, error: { message: "invalid decimal value", input } };
  }
}

export function normalizeNullableDecimal(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "string" && NULL_LIKE.has(input.trim().toLowerCase())) return null;
  const result = normalizeDecimal(input);
  return result.ok ? result.value : null;
}

export function decimalAdd(left: string, right: string): string {
  return new Decimal(left).plus(new Decimal(right)).toFixed();
}

export function decimalDivide(left: string, right: string): string {
  return new Decimal(left).div(new Decimal(right)).toFixed();
}

export function decimalMax(values: readonly string[]): string {
  if (values.length === 0) return "0";
  return values.reduce((max, value) =>
    new Decimal(value).greaterThan(new Decimal(max)) ? value : max,
  );
}

export function decimalMin(values: readonly string[]): string {
  if (values.length === 0) return "0";
  return values.reduce((min, value) =>
    new Decimal(value).lessThan(new Decimal(min)) ? value : min,
  );
}
