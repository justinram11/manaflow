import { describe, expect, it } from "vitest";
import { parseGitUrl } from "./parse-git-url";

describe("parseGitUrl", () => {
  it("parses SSH URLs", () => {
    const result = parseGitUrl("git@github.com:owner/repo.git");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      fullName: "owner/repo",
      cloneUrl: "git@github.com:owner/repo.git",
    });
  });

  it("preserves SSH clone URL (does not convert to HTTPS)", () => {
    const result = parseGitUrl("git@github.com:user/project.git");
    expect(result?.cloneUrl).toBe("git@github.com:user/project.git");
  });

  it("parses SSH URLs without .git suffix", () => {
    const result = parseGitUrl("git@gitlab.com:org/lib");
    expect(result).toEqual({
      owner: "org",
      repo: "lib",
      fullName: "org/lib",
      cloneUrl: "git@gitlab.com:org/lib",
    });
  });

  it("parses HTTPS URLs", () => {
    const result = parseGitUrl("https://github.com/owner/repo.git");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      fullName: "owner/repo",
      cloneUrl: "https://github.com/owner/repo.git",
    });
  });

  it("parses HTTPS URLs without .git suffix", () => {
    const result = parseGitUrl("https://github.com/owner/repo");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      fullName: "owner/repo",
      cloneUrl: "https://github.com/owner/repo",
    });
  });

  it("parses owner/repo shorthand as GitHub HTTPS", () => {
    const result = parseGitUrl("owner/repo");
    expect(result).toEqual({
      owner: "owner",
      repo: "repo",
      fullName: "owner/repo",
      cloneUrl: "https://github.com/owner/repo.git",
    });
  });

  it("handles non-GitHub SSH hosts", () => {
    const result = parseGitUrl("git@gitlab.com:org/project.git");
    expect(result).toEqual({
      owner: "org",
      repo: "project",
      fullName: "org/project",
      cloneUrl: "git@gitlab.com:org/project.git",
    });
  });

  it("handles non-GitHub HTTPS hosts", () => {
    const result = parseGitUrl("https://gitlab.com/org/project.git");
    expect(result).toEqual({
      owner: "org",
      repo: "project",
      fullName: "org/project",
      cloneUrl: "https://gitlab.com/org/project.git",
    });
  });

  it("returns null for empty input", () => {
    expect(parseGitUrl("")).toBeNull();
  });

  it("returns null for invalid input", () => {
    expect(parseGitUrl("not-a-url")).toBeNull();
    expect(parseGitUrl("ftp://example.com/foo")).toBeNull();
  });

  it("trims whitespace", () => {
    const result = parseGitUrl("  git@github.com:owner/repo.git  ");
    expect(result?.fullName).toBe("owner/repo");
  });
});
