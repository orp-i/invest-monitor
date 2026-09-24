import { createHash } from "node:crypto";
import type { NewsItem } from "@invest/domain";

export interface DedupThresholds {
  readonly simHashDistance: number;
  readonly minHashJaccard: number;
}

export function normalizeNewsText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function newsContentHash(title: string, contentText: string | null): string {
  return createHash("sha256")
    .update(normalizeNewsText(title))
    .update("\n")
    .update(normalizeNewsText(contentText ?? ""))
    .digest("hex");
}

export function simHash64(value: string): bigint {
  const weights = new Array<number>(64).fill(0);
  for (const token of tokens(value)) {
    const hash = createHash("sha256").update(token).digest().readBigUInt64BE(0);
    for (let bit = 0; bit < 64; bit += 1) {
      weights[bit] = (weights[bit] ?? 0) + ((hash & (1n << BigInt(bit))) === 0n ? -1 : 1);
    }
  }
  let result = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if ((weights[bit] ?? 0) >= 0) result |= 1n << BigInt(bit);
  }
  return result;
}

export function hammingDistance(left: bigint, right: bigint): number {
  let value = left ^ right;
  let count = 0;
  while (value > 0n) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

export function minHashSignature(value: string, size = 32): readonly number[] {
  const values = shingles(value);
  if (values.length === 0) return new Array<number>(size).fill(0);
  const signature = new Array<number>(size).fill(0xffffffff);
  for (const shingle of values) {
    for (let seed = 0; seed < size; seed += 1) {
      const hash = hash32(shingle, seed + 1);
      if (hash < (signature[seed] ?? 0xffffffff)) signature[seed] = hash;
    }
  }
  return signature;
}

export function minHashSimilarity(left: readonly number[], right: readonly number[]): number {
  const size = Math.min(left.length, right.length);
  if (size === 0) return 0;
  let equal = 0;
  for (let index = 0; index < size; index += 1) {
    if (left[index] === right[index]) equal += 1;
  }
  return equal / size;
}

export function findDuplicateNews(
  candidate: Pick<NewsItem, "canonicalUrl" | "contentHash" | "title" | "contentText">,
  existing: readonly NewsItem[],
  thresholds: DedupThresholds,
): NewsItem | null {
  const candidateText = `${candidate.title}\n${candidate.contentText ?? ""}`;
  const candidateSimHash = simHash64(candidateText);
  const candidateMinHash = minHashSignature(candidateText);
  for (const item of existing) {
    if (item.canonicalUrl === candidate.canonicalUrl || item.contentHash === candidate.contentHash) return item;
    const itemText = `${item.title}\n${item.contentText ?? ""}`;
    if (hammingDistance(candidateSimHash, simHash64(itemText)) <= thresholds.simHashDistance) return item;
    if (minHashSimilarity(candidateMinHash, minHashSignature(itemText)) >= thresholds.minHashJaccard) return item;
  }
  return null;
}

function tokens(value: string): string[] {
  return normalizeNewsText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function shingles(value: string): string[] {
  const values = tokens(value);
  if (values.length <= 3) return values;
  return values.slice(0, -2).map((token, index) => `${token} ${values[index + 1]} ${values[index + 2]}`);
}

function hash32(value: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
