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

  it("parses SSH URLs with nested GitLab groups", () => {
    const result = parseGitUrl("git@gitlab.com:moneydolly1/code/mono.git");
    expect(result).toEqual({
      owner: "moneydolly1/code",
      repo: "mono",
      fullName: "moneydolly1/code/mono",
      cloneUrl: "git@gitlab.com:moneydolly1/code/mono.git",
    });
  });

  it("parses HTTPS URLs with nested GitLab groups", () => {
    const result = parseGitUrl("https://gitlab.com/group/subgroup/repo");
    expect(result).toEqual({
      owner: "group/subgroup",
      repo: "repo",
      fullName: "group/subgroup/repo",
      cloneUrl: "https://gitlab.com/group/subgroup/repo",
    });
  });

  it("parses deeply nested GitLab groups", () => {
    const result = parseGitUrl("git@gitlab.com:a/b/c/repo.git");
    expect(result).toEqual({
      owner: "a/b/c",
      repo: "repo",
      fullName: "a/b/c/repo",
      cloneUrl: "git@gitlab.com:a/b/c/repo.git",
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
