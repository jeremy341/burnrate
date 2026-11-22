import { expect, it } from "vitest";

import type { UsageModelPriceOverride } from "~/contracts";
import { parseUsagePriceForm, usagePriceForm } from "./usagePriceForm";

it("opens an incomplete saved price and requires its missing rate before saving", () => {
  const legacyPrice = { inputCostPerMillionTokens: 0 } as UsageModelPriceOverride;
  const form = usagePriceForm("old-model", legacyPrice);

  expect(form.inputCostPerMillionTokens).toBe("0");
  expect(form.outputCostPerMillionTokens).toBe("");
  expect(parseUsagePriceForm(form)).toBeNull();
  expect(parseUsagePriceForm({ ...form, outputCostPerMillionTokens: "2" })).toEqual({
    model: "old-model",
    price: { inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 2 },
  });
});
