import { ExplorerError } from "./errors";

export function parseRepositoryUrl(input: string): { owner: string; name: string } {
  const invalid = () =>
    new ExplorerError(
      "INVALID_URL",
      "Enter a repository root URL, such as https://github.com/owner/repository. Branch, file, and non-GitHub URLs are not supported yet.",
    );
  if (input.length > 500) throw invalid();
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw invalid();
  // Reject normalized traversal and encoded paths instead of accepting ambiguous URLs.
  const originalPath = input.trim().replace(/^https:\/\/[^/]+/i, "");
  if (
    originalPath.includes("%") ||
    originalPath.includes("\\") ||
    /\/(?:\.|\.\.)(?:\/|$)/.test(originalPath)
  )
    throw invalid();
  const match = /^\/([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38}))\/([a-zA-Z0-9_.-]{1,100})\/?$/.exec(
    url.pathname,
  );
  if (!match) throw invalid();
  const name = match[2].replace(/\.git$/, "");
  if (!name || name === "." || name === "..") throw invalid();
  return { owner: match[1], name };
}
