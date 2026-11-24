import type { ApiError } from "@/lib/contracts/repository";

export function workspaceError(error: unknown): ApiError {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    // A structured response proves the local server answered. Preserve its actual diagnosis.
    if ("code" in error && typeof error.code === "string")
      return {
        code: error.code,
        message: error.message,
        ...("retryAt" in error && typeof error.retryAt === "string"
          ? { retryAt: error.retryAt }
          : {}),
      };
    if (
      /^(?:failed to fetch|fetch failed|load failed|networkerror when attempting to fetch resource\.?)$/i.test(
        error.message.trim(),
      )
    )
      return {
        code: "LOCAL_SERVER_UNREACHABLE",
        message:
          "Cannot connect to the local Abstract server. Start npm run dev or npm run start in the project folder, keep that terminal open, then try again.",
      };
    return { code: "REQUEST_FAILED", message: error.message };
  }
  return {
    code: "REQUEST_FAILED",
    message: "The request could not be completed. Please try again.",
  };
}
