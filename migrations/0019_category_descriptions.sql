-- Real descriptions for categories that still carry the import placeholder. They open each category page
-- (/games?category=...). Categories an editor has already described are left alone.

UPDATE categories SET description = 'Guess the word, unscramble the letters or fill the grid: Wordle and the word puzzles it inspired.', updated_at = datetime('now') WHERE slug = 'words' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Name the video game from a screenshot, character, sound or clue.', updated_at = datetime('now') WHERE slug = 'video-games' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Find countries, cities and landmarks from maps, flags, outlines and street views.', updated_at = datetime('now') WHERE slug = 'geography' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Name the movie or show from a frame, quote, poster, cast or plot.', updated_at = datetime('now') WHERE slug = 'moviestv' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Daily puzzles that don''t fit neatly anywhere else.', updated_at = datetime('now') WHERE slug = 'miscellaneous' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Guess the song, artist or album from a short clip, lyrics or artwork.', updated_at = datetime('now') WHERE slug = 'music' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Daily quiz questions, from general knowledge to deep cuts.', updated_at = datetime('now') WHERE slug = 'trivia' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Visual puzzles built on shapes, patterns and spatial reasoning.', updated_at = datetime('now') WHERE slug = 'shapespatterns' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Guess the player, team or moment from stats, silhouettes and career clues.', updated_at = datetime('now') WHERE slug = 'sports' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Daily puzzles inspired by board games and card games.', updated_at = datetime('now') WHERE slug = 'cardboard-games' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Place events, people and artifacts in time, or name them from historical clues.', updated_at = datetime('now') WHERE slug = 'history' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Identify animals, plants, elements and natural wonders from daily clues.', updated_at = datetime('now') WHERE slug = 'sciencenature' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Unusual daily games with a twist you won''t find anywhere else.', updated_at = datetime('now') WHERE slug = 'novelty' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Match, mix and guess colors by eye.', updated_at = datetime('now') WHERE slug = 'colors' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Guess the dish, ingredient or cuisine from photos and clues.', updated_at = datetime('now') WHERE slug = 'food' AND description = 'Imported from dles.json';
UPDATE categories SET description = 'Identify cars, planes and other vehicles from photos and specs.', updated_at = datetime('now') WHERE slug = 'vehicles' AND description = 'Imported from dles.json';
