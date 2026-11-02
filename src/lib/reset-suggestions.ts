import { z } from "zod";

// Crowdsourced reset-time suggestions (table reset_suggestions, migration 0035).
export const RESET_SUGGESTION_DAILY_LIMIT = 10;

export const resetSuggestionSchema = z.object({
  reset_basis: z.enum(["local", "server"]),
  reset_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  reset_timezone: z.string().max(64).nullable().optional(),
  note: z.string().trim().max(200).optional()
});

export type OpenSuggestionRow = {
  id: string;
  game_id: string;
  user_id: string;
  reset_basis: "local" | "server";
  reset_time_minutes: number;
  reset_timezone: string | null;
  note: string | null;
  created_at: string;
  display_name: string | null;
};

export type SuggestionGroup = {
  key: string;
  gameId: string;
  basis: "local" | "server";
  minutes: number;
  timezone: string | null;
  /** Id of the newest suggestion in the group; the admin actions are addressed by it. */
  id: string;
  rows: OpenSuggestionRow[];
};

/** Groups identical suggestions (same game, basis, time and zone); input newest first, biggest groups first. */
export function groupSuggestions(rows: OpenSuggestionRow[]): SuggestionGroup[] {
  const groups = new Map<string, SuggestionGroup>();
  for (const row of rows) {
    const key = `${row.game_id}|${row.reset_basis}|${row.reset_time_minutes}|${row.reset_timezone ?? ""}`;
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { key, gameId: row.game_id, basis: row.reset_basis, minutes: row.reset_time_minutes, timezone: row.reset_timezone, id: row.id, rows: [row] });
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || (a.rows[0].created_at < b.rows[0].created_at ? 1 : -1));
}
