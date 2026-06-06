import {toMinor, fromMinor, sumMinor, multiplyMinor} from "../../src/pkg/utils/money";

describe("money minor-unit helpers", () => {
    it("converts major units to integer minor units (rounding cents)", () => {
        expect(toMinor(15)).toBe(1500);
        expect(toMinor(15.99)).toBe(1599);
        // 0.1 + 0.2 float noise must not leak into the integer result.
        expect(toMinor(0.1 + 0.2)).toBe(30);
    });

    it("round-trips minor -> major", () => {
        expect(fromMinor(toMinor(12.34))).toBeCloseTo(12.34, 5);
    });

    it("sums and multiplies exactly in integer minor units", () => {
        expect(sumMinor([100, 250, 50])).toBe(400);
        expect(sumMinor([])).toBe(0);
        expect(multiplyMinor(150, 3)).toBe(450);
    });
});
