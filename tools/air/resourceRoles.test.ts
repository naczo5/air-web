import { describe, expect, it } from "vitest";
import { imageLayerForResource } from "./resourceRoles";

describe("AIR resource roles", () => {
  it("keeps character sprites above persistent backgrounds", () => {
    expect(imageLayerForResource("BG043")).toBe(0);
    expect(imageLayerForResource("FGMZ01")).toBe(0);
    expect(imageLayerForResource("KURO")).toBe(0);
    expect(imageLayerForResource("CGMZ20")).toBe(1);
    expect(imageLayerForResource("CGUR11")).toBe(1);
  });
});
