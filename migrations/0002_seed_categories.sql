INSERT OR IGNORE INTO users (id, email, display_name, role)
VALUES ('00000000-0000-0000-0000-000000000001', 'system@dailygamelist.local', 'System', 'admin');

INSERT OR IGNORE INTO categories (id, slug, name, description, created_by_user_id) VALUES
  ('10000000-0000-0000-0000-000000000001', 'word-games', 'Word Games', 'Daily vocabulary and letter puzzle games.', '00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002', 'number-games', 'Number Games', 'Math and number reasoning games.', '00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000003', 'logic-games', 'Logic Games', 'Deduction, strategy, and logic games.', '00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000004', 'trivia-games', 'Trivia Games', 'General knowledge and themed trivia.', '00000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000005', 'geography-games', 'Geography Games', 'Maps, countries, and location games.', '00000000-0000-0000-0000-000000000001');
