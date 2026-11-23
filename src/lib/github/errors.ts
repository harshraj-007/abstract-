import type { ApiError } from "@/lib/contracts/repository";

export class ExplorerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryAt?: string,
  ) {
    super(message);
    this.name = "ExplorerError";
  }
}

export function publicError(error: unknown): { error: ApiError; status: number } {
  if (error instanceof ExplorerError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryAt ? { retryAt: error.retryAt } : {}),
      },
      status: error.status,
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message:
        "Something went wrong while opening this repository. Your saved snapshots are still available. Please try again.",
    },
    status: 500,
  };
}
