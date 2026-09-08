import { describe, expect, it } from "vitest";
import { formatQuickLookTime, quickLookIssuePath } from "./PveOperationsQuickLook";

describe("quickLookIssuePath", () => {
  it("opens the resource detail for a VM/LXC issue", () => {
    expect(quickLookIssuePath({ scope: "qemu", vmid: 101 })).toBe("/resource-mgmt/101");
    expect(quickLookIssuePath({ scope: "lxc", vmid: 202 })).toBe("/resource-mgmt/202");
  });

  it("opens monitoring for node issues and invalid guest targets", () => {
    expect(quickLookIssuePath({ scope: "node", target: "pve02" })).toBe("/monitoring");
    expect(quickLookIssuePath({ scope: "qemu", target: "vm-no-id" })).toBe("/monitoring");
  });
});

describe("formatQuickLookTime", () => {
  it("returns a readable time for a valid timestamp", () => {
    const value = formatQuickLookTime("2026-09-08T06:32:18.000Z", "en-US");
    expect(value).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("does not expose malformed timestamps", () => {
    expect(formatQuickLookTime(null, "en-US")).toBe("—");
    expect(formatQuickLookTime("not-a-date", "en-US")).toBe("—");
  });
});
