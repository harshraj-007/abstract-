import { describe, expect, it } from "vitest";
import { readSmallJson, requireSameOrigin } from "@/lib/http";

describe("local API request boundary", () => {
  it("accepts the local application origin", () => {
    expect(() =>
      requireSameOrigin(
        new Request("http://127.0.0.1:3000/api/repositories", {
          headers: { origin: "http://127.0.0.1:3000" },
        }),
      ),
    ).not.toThrow();
  });
  it("rejects requests from another website", () => {
    expect(() =>
      requireSameOrigin(
        new Request("http://127.0.0.1:3000/api/repositories", {
          headers: { origin: "https://unrelated.test" },
        }),
      ),
    ).toThrow();
  });
  it("accepts the browser Host when Next constructs a localhost request URL", () => {
    expect(() =>
      requireSameOrigin(
        new Request("http://localhost:3000/api/repositories", {
          headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" },
        }),
      ),
    ).not.toThrow();
  });
  it("still rejects a different Origin when the local Host is supplied", () => {
    expect(() =>
      requireSameOrigin(
        new Request("http://localhost:3000/api/repositories", {
          headers: { origin: "https://unrelated.test", host: "127.0.0.1:3000" },
        }),
      ),
    ).toThrow();
  });
  it("bounds streamed request bodies without trusting content-length", async () => {
    const request = new Request("http://localhost/api/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "x".repeat(3000) }),
    });
    await expect(readSmallJson(request)).rejects.toMatchObject({ status: 413 });
  });
  it("reports invalid JSON as a request error", async () => {
    const request = new Request("http://localhost/api/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    await expect(readSmallJson(request)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
