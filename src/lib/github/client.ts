import { z } from "zod";
import { createHash } from "node:crypto";
import { ExplorerError } from "./errors";
import { DEFAULT_LIMITS, sourceLines } from "@/lib/contracts/repository";
import { containsLikelySecret } from "./filter";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const repositorySchema = z.object({
  name: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
  default_branch: z.string(),
  language: z.string().nullable(),
  owner: z.object({ login: z.string() }),
});
const commitSchema = z.object({
  sha: shaSchema,
  commit: z.object({ tree: z.object({ sha: shaSchema }) }),
});
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.enum(["blob", "tree", "commit"]),
      sha: shaSchema,
      size: z.number().int().nonnegative().optional(),
    }),
  ),
});
const blobSchema = z.object({
  sha: shaSchema,
  size: z.number().int().nonnegative(),
  encoding: z.literal("base64"),
  content: z.string(),
});

export class GitHubClient {
  constructor(
    private readonly options: { token?: string; fetch?: typeof fetch; signal?: AbortSignal } = {},
  ) {}

  private async request<T>(path: string, schema: z.ZodType<T>, maxBytes: number): Promise<T> {
    let response: Response;
    const timeout = AbortSignal.timeout(15_000);
    const signal = this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
    try {
      response = await (this.options.fetch ?? fetch)(`https://api.github.com${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Abstract-Repository-Explorer",
          ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
        },
        signal,
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      if (this.options.signal?.aborted)
        throw new ExplorerError("CANCELLED", "Repository import was cancelled.", 499);
      throw new ExplorerError(
        "GITHUB_UNREACHABLE",
        "Could not reach GitHub. Check your connection and try again. Saved snapshots still work offline.",
        502,
      );
    }

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404)
        throw new ExplorerError(
          "NOT_FOUND",
          "Repository not found or not accessible. Check the URL; this version opens public repositories only.",
          404,
        );
      if (response.status === 409)
        throw new ExplorerError(
          "EMPTY_REPOSITORY",
          "This repository has no commits or files yet.",
          409,
        );
      if (response.status === 401)
        throw new ExplorerError(
          "GITHUB_AUTH",
          "GitHub rejected the configured server token. Remove it or replace it with a valid read-only token.",
          502,
        );
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")))
      ) {
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const retry = Number(response.headers.get("retry-after"));
        const retryAt =
          reset > 0
            ? new Date(reset * 1000).toISOString()
            : retry > 0
              ? new Date(Date.now() + retry * 1000).toISOString()
              : undefined;
        throw new ExplorerError(
          "RATE_LIMITED",
          "GitHub's request limit was reached. Wait before retrying, or configure a server-side GitHub token for your own usage.",
          429,
          retryAt,
        );
      }
      if (response.status === 403)
        throw new ExplorerError(
          "ACCESS_DENIED",
          "GitHub denied this request. Check repository availability and the server token's permissions, or try again later.",
          403,
        );
      throw new ExplorerError(
        "GITHUB_ERROR",
        "GitHub could not complete the request. Please try again later.",
        502,
      );
    }

    const announced = Number(response.headers.get("content-length"));
    if (announced > maxBytes) {
      await response.body?.cancel();
      throw new ExplorerError(
        "RESPONSE_TOO_LARGE",
        "GitHub's response exceeds this explorer's download limit. Try a smaller repository.",
        413,
      );
    }
    if (!response.body)
      throw new ExplorerError("GITHUB_RESPONSE", "GitHub returned an empty response.", 502);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw new ExplorerError(
            "RESPONSE_TOO_LARGE",
            "GitHub's response exceeds this explorer's download limit. Try a smaller repository.",
            413,
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof ExplorerError) throw error;
      throw new ExplorerError(
        "GITHUB_UNREACHABLE",
        "The GitHub download was interrupted. Please try again.",
        502,
      );
    } finally {
      reader.releaseLock();
    }
    let json: unknown;
    try {
      json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ExplorerError("GITHUB_RESPONSE", "GitHub returned an unreadable response.", 502);
    }
    const result = schema.safeParse(json);
    if (!result.success)
      throw new ExplorerError(
        "GITHUB_RESPONSE",
        "GitHub returned an unexpected response. No source was saved from this response.",
        502,
      );
    return result.data;
  }

  async repository(owner: string, name: string) {
    const result = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      repositorySchema,
      256 * 1024,
    );
    if (result.private)
      throw new ExplorerError(
        "PRIVATE_REPOSITORY",
        "Private repositories are not supported in this version. Please choose a public repository.",
        403,
      );
    return result;
  }

  commit(owner: string, name: string, branch: string) {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(branch)}`,
      commitSchema,
      4 * 1024 * 1024,
    );
  }

  tree(owner: string, name: string, sha: string) {
    return this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${sha}?recursive=1`,
      treeSchema,
      8 * 1024 * 1024,
    );
  }

  async source(owner: string, name: string, sha: string) {
    const blob = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/blobs/${sha}`,
      blobSchema,
      128 * 1024,
    );
    if (blob.sha !== sha)
      throw new ExplorerError(
        "SOURCE_MISMATCH",
        "GitHub returned a different source object. The file was not saved.",
        502,
      );
    if (blob.size > DEFAULT_LIMITS.maxFileBytes)
      throw new ExplorerError("FILE_TOO_LARGE", "This source file exceeds the 64 KiB limit.", 413);
    const encoded = blob.content.replace(/\s/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      throw new ExplorerError("GITHUB_RESPONSE", "GitHub returned invalid source encoding.", 502);
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.byteLength !== blob.size ||
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== sha
    ) {
      throw new ExplorerError(
        "SOURCE_MISMATCH",
        "The source content does not match its pinned Git object. The file was not saved.",
        502,
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new ExplorerError(
        "BINARY_SOURCE",
        "This file is not valid UTF-8 text and has been excluded.",
        422,
      );
    }
    if (content.includes("\0"))
      throw new ExplorerError(
        "BINARY_SOURCE",
        "This file contains binary content and has been excluded.",
        422,
      );
    if (containsLikelySecret(content))
      throw new ExplorerError(
        "SENSITIVE_SOURCE",
        "This file appears to contain a credential or private key. Its contents were not saved or displayed.",
        422,
      );
    return {
      content,
      size: bytes.length,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      lineCount: sourceLines(content).length,
    };
  }
}
