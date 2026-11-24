import { describe, expect, it } from "vitest";
import { workspaceError } from "@/lib/browser/errors";

describe("local workspace connection errors", () => {
  it.each([
    "Failed to fetch",
    "Load failed",
    "NetworkError when attempting to fetch resource.",
    "fetch failed",
  ])("explains a browser network failure: %s", (message) => {
    expect(workspaceError(new TypeError(message))).toMatchObject({
      code: "LOCAL_SERVER_UNREACHABLE",
      message: expect.stringContaining("keep that terminal open"),
    });
  });
  it("preserves server diagnoses and retry times", () => {
    const error = {
      code: "RATE_LIMITED",
      message: "GitHub's request limit was reached.",
      retryAt: "2026-11-25T04:00:00Z",
    };
    expect(workspaceError(error)).toEqual(error);
    expect(workspaceError({ code: "GITHUB_UNREACHABLE", message: "Failed to fetch" }).code).toBe(
      "GITHUB_UNREACHABLE",
    );
  });
  it("keeps parsing failures distinct from a disconnected server", () => {
    expect(workspaceError(new SyntaxError("Invalid JSON"))).toEqual({
      code: "REQUEST_FAILED",
      message: "Invalid JSON",
    });
  });
});
