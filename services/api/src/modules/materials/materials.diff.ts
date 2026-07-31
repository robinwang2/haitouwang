import type { Material, MaterialClaim, MaterialDiff, MaterialDiffLine } from './materials.types';

export function diffMaterials(from: Material, to: Material): MaterialDiff {
  const fromClaims = new Map(from.document.claims.map((claim) => [claim.id, claim]));
  const toClaims = new Map(to.document.claims.map((claim) => [claim.id, claim]));
  const addedClaimIds = [...toClaims.keys()]
    .filter((id) => !fromClaims.has(id))
    .sort((left, right) => left.localeCompare(right));
  const removedClaimIds = [...fromClaims.keys()]
    .filter((id) => !toClaims.has(id))
    .sort((left, right) => left.localeCompare(right));
  const changedClaimIds = [...fromClaims.keys()]
    .filter((id) => toClaims.has(id) && !claimsEqual(fromClaims.get(id)!, toClaims.get(id)!))
    .sort((left, right) => left.localeCompare(right));

  return {
    from: { id: from.id, version: from.version },
    to: { id: to.id, version: to.version },
    added_claim_ids: addedClaimIds,
    removed_claim_ids: removedClaimIds,
    changed_claim_ids: changedClaimIds,
    lines: diffLines(from.document.plain_text, to.document.plain_text),
  };
}

function claimsEqual(left: MaterialClaim, right: MaterialClaim): boolean {
  if (left.text !== right.text || left.status !== right.status) return false;
  if (left.citations.length !== right.citations.length) return false;
  return left.citations.every((citation, index) => {
    const other = right.citations[index];
    return (
      citation.fact_id === other?.fact_id &&
      citation.fact_version === other.fact_version &&
      citation.claim_path === other.claim_path
    );
  });
}

function diffLines(fromText: string, toText: string): MaterialDiffLine[] {
  const from = fromText.split('\n');
  const to = toText.split('\n');
  const lengths = Array.from({ length: from.length + 1 }, () =>
    Array.from({ length: to.length + 1 }, () => 0),
  );
  for (let left = from.length - 1; left >= 0; left -= 1) {
    for (let right = to.length - 1; right >= 0; right -= 1) {
      lengths[left]![right] =
        from[left] === to[right]
          ? lengths[left + 1]![right + 1]! + 1
          : Math.max(lengths[left + 1]![right]!, lengths[left]![right + 1]!);
    }
  }

  const result: MaterialDiffLine[] = [];
  let left = 0;
  let right = 0;
  while (left < from.length && right < to.length) {
    if (from[left] === to[right]) {
      result.push({ operation: 'equal', text: from[left]! });
      left += 1;
      right += 1;
    } else if (lengths[left + 1]![right]! >= lengths[left]![right + 1]!) {
      result.push({ operation: 'delete', text: from[left]! });
      left += 1;
    } else {
      result.push({ operation: 'insert', text: to[right]! });
      right += 1;
    }
  }
  while (left < from.length) {
    result.push({ operation: 'delete', text: from[left]! });
    left += 1;
  }
  while (right < to.length) {
    result.push({ operation: 'insert', text: to[right]! });
    right += 1;
  }
  return result;
}
