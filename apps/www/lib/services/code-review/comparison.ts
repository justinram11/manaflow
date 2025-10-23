import { createHash } from "node:crypto";

type ComparisonRefInput = {
  raw: string;
  defaultOwner: string;
  repoName: string;
};

export type ComparisonRefDetails = {
  owner: string;
  repo: string;
  ref: string;
  label: string;
};

export type ComparisonJobDetails = {
  slug: string;
  base: ComparisonRefDetails;
  head: ComparisonRefDetails;
  repoFullName: string;
  compareUrl: string;
  virtualPrNumber: number;
};

const VIRTUAL_PR_NUMBER_OFFSET = 1_000_000_000;
const HASH_BYTES = 6;

export function parseComparisonRef({
  raw,
  defaultOwner,
  repoName,
}: ComparisonRefInput): ComparisonRefDetails {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("Comparison ref cannot be empty");
  }

  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex === -1) {
    return {
      owner: defaultOwner,
      repo: repoName,
      ref: trimmed,
      label: trimmed,
    };
  }

  const owner = trimmed.slice(0, separatorIndex).trim();
  const ref = trimmed.slice(separatorIndex + 1).trim();
  if (owner.length === 0 || ref.length === 0) {
    throw new Error(`Invalid comparison ref: ${raw}`);
  }

  return {
    owner,
    repo: repoName,
    ref,
    label: trimmed,
  };
}

export function buildComparisonJobDetails({
  repoOwner,
  repoName,
  baseRef,
  headRef,
}: {
  repoOwner: string;
  repoName: string;
  baseRef: string;
  headRef: string;
}): ComparisonJobDetails {
  const base = parseComparisonRef({
    raw: baseRef,
    defaultOwner: repoOwner,
    repoName,
  });
  const head = parseComparisonRef({
    raw: headRef,
    defaultOwner: repoOwner,
    repoName,
  });

  const slug = `${base.label}...${head.label}`;
  const repoFullName = `${repoOwner}/${repoName}`;
  const compareUrl = `https://github.com/${repoFullName}/compare/${encodeURIComponent(
    base.label
  )}...${encodeURIComponent(head.label)}`;

  const virtualPrNumber = computeVirtualPrNumber({
    repoFullName,
    baseOwner: base.owner,
    baseRef: base.ref,
    headOwner: head.owner,
    headRef: head.ref,
  });

  return {
    slug,
    base,
    head,
    repoFullName,
    compareUrl,
    virtualPrNumber,
  };
}

export function computeVirtualPrNumber({
  repoFullName,
  baseOwner,
  baseRef,
  headOwner,
  headRef,
}: {
  repoFullName: string;
  baseOwner: string;
  baseRef: string;
  headOwner: string;
  headRef: string;
}): number {
  const hash = createHash("sha256");
  hash.update(repoFullName);
  hash.update("\0");
  hash.update(baseOwner);
  hash.update("\0");
  hash.update(baseRef);
  hash.update("\0");
  hash.update(headOwner);
  hash.update("\0");
  hash.update(headRef);

  const digest = hash.digest();
  let value = 0;
  for (let index = 0; index < HASH_BYTES; index += 1) {
    value = value * 256 + digest[index];
  }

  return VIRTUAL_PR_NUMBER_OFFSET + value;
}
