import { describe, expect, it } from "vitest";
import { DecimalString, normalizeDecimal, normalizeNullableDecimal } from "@invest/domain";

describe("DecimalString normalization", () => {
  it("turns scientific notation into plain decimal text", () => {
    expect(normalizeDecimal("1e-7")).toEqual({ ok: true, value: "0.0000001" });
    expect(normalizeDecimal("-2.5E+3")).toEqual({ ok: true, value: "-2500" });
    expect(DecimalString.safeParse("1e-7").success).toBe(false);
  });

  it("converts provider floating point values at the adapter boundary", () => {
    expect(normalizeDecimal(4604.399902)).toEqual({ ok: true, value: "4604.399902" });
    expect(normalizeDecimal("+1,234.5000")).toEqual({ ok: true, value: "1234.5" });
    expect(normalizeNullableDecimal("N/A")).toBeNull();
  });
});
