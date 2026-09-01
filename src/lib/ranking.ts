export function wilsonLowerBound(upVotes: number, downVotes: number): number {
  // Wilson lower bound avoids over-ranking items with very few votes.
  const n = upVotes + downVotes;
  if (n === 0) {
    return 0;
  }
  const z = 1.96;
  const pHat = upVotes / n;
  return (
    (pHat + (z * z) / (2 * n) - z * Math.sqrt((pHat * (1 - pHat) + (z * z) / (4 * n)) / n)) /
    (1 + (z * z) / n)
  );
}

export function computeGameScore(params: {
  upVotes: number;
  downVotes: number;
  reportCount: number;
  favoriteCount: number;
  createdAtIso: string;
}): number {
  const voteScore = wilsonLowerBound(params.upVotes, params.downVotes);
  const ageMs = Date.now() - Date.parse(params.createdAtIso);
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  const freshnessBoost = Math.max(0, 0.25 - ageDays * 0.005);
  const reportPenalty = Math.min(0.4, params.reportCount * 0.05);
  const favoriteBoost = Math.min(0.35, params.favoriteCount * 0.008);
  return Math.max(0, voteScore + freshnessBoost + favoriteBoost - reportPenalty);
}
