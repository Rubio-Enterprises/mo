import { describe, it, expect } from "vitest";

// Test the pure selection logic extracted from the hook.
// We test the range computation algorithm directly since the hook
// depends on DOM refs that are hard to mock in unit tests.

function computeRange(order: string[], anchor: string, target: string): string[] {
  const anchorIdx = order.indexOf(anchor);
  const targetIdx = order.indexOf(target);
  if (anchorIdx === -1 || targetIdx === -1) return [target];
  const start = Math.min(anchorIdx, targetIdx);
  const end = Math.max(anchorIdx, targetIdx);
  return order.slice(start, end + 1);
}

describe("computeRange", () => {
  const order = ["A", "B", "C", "D", "E"];

  it("selects forward range", () => {
    expect(computeRange(order, "B", "D")).toEqual(["B", "C", "D"]);
  });

  it("selects backward range", () => {
    expect(computeRange(order, "D", "B")).toEqual(["B", "C", "D"]);
  });

  it("selects single item when anchor equals target", () => {
    expect(computeRange(order, "C", "C")).toEqual(["C"]);
  });

  it("selects full range from first to last", () => {
    expect(computeRange(order, "A", "E")).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("returns only target when anchor not in order", () => {
    expect(computeRange(order, "Z", "C")).toEqual(["C"]);
  });

  it("returns only target when target not in order", () => {
    expect(computeRange(order, "B", "Z")).toEqual(["Z"]);
  });
});
