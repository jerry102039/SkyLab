import { describe, expect, test } from "vitest";
import { applyDateField, isDateRangeValid } from "./AuditPage";

const base = { search: "", action: "", userId: "", startDate: "", endDate: "" };

describe("AuditPage 日期篩選範圍", () => {
  test("任一端為空即視為合法", () => {
    expect(isDateRangeValid("", "")).toBe(true);
    expect(isDateRangeValid("2026-09-01", "")).toBe(true);
    expect(isDateRangeValid("", "2026-09-01")).toBe(true);
  });

  test("起始不可晚於結束，同一天合法", () => {
    expect(isDateRangeValid("2026-09-01", "2026-09-09")).toBe(true);
    expect(isDateRangeValid("2026-09-09", "2026-09-09")).toBe(true);
    expect(isDateRangeValid("2026-09-10", "2026-09-09")).toBe(false);
    expect(isDateRangeValid("2026-10-01", "2026-09-30")).toBe(false);
  });

  test("起始改到結束之後，結束跟著移到同一天", () => {
    const next = applyDateField({ ...base, startDate: "2026-09-01", endDate: "2026-09-05" }, "startDate", "2026-09-20");
    expect(next.startDate).toBe("2026-09-20");
    expect(next.endDate).toBe("2026-09-20");
  });

  test("結束改到起始之前，起始跟著移到同一天", () => {
    const next = applyDateField({ ...base, startDate: "2026-09-10", endDate: "2026-09-15" }, "endDate", "2026-09-03");
    expect(next.startDate).toBe("2026-09-03");
    expect(next.endDate).toBe("2026-09-03");
  });

  test("範圍仍合法時不動另一端，其他篩選欄位保持不變", () => {
    const filters = { ...base, search: "login", startDate: "2026-09-01", endDate: "2026-09-15" };
    const next = applyDateField(filters, "startDate", "2026-09-05");
    expect(next).toEqual({ ...filters, startDate: "2026-09-05" });

    const cleared = applyDateField(filters, "endDate", "");
    expect(cleared).toEqual({ ...filters, endDate: "" });
  });
});
