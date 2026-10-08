// What's new, shown at /changelog. Newest day first; one short, visitor-facing line per change (no internal or
// infrastructure work). Add an entry whenever a user-visible feature or change ships.
export type ChangelogDay = { date: string; items: string[] };

export const CHANGELOG: ChangelogDay[] = [
  {
    date: "2026-10-08",
    items: [
      "Added this changelog, linked from the footer.",
      "Suggest games for a curated list. Anyone can suggest a game or vote for someone else's suggestion, and the most-voted suggestions come first. The list's editors and its Twitch streamer can add a suggestion to the list, dismiss it, or turn suggestions off for that list.",
      "On wide screens, suggestions sit in a column to the right of the list. Clicking a suggestion opens the game in a new tab, and its categories are shown.",
      "On wide screens, a list's title and its Twitch button share a line.",
      "Cards fade out once you've played the game since its last reset. If you haven't played it and it resets in under two hours, its reset bar turns red.",
      "Tidier game pages, with the vote buttons in a compact row and the details first. Badge colours are easier to read.",
      "On phones, list rows are tidier: badges are always visible and the buttons share a line with the categories."
    ]
  },
  {
    date: "2026-10-07",
    items: [
      "The site is now called 0x9 dles, with a new look for links shared on social media.",
      "Game cards are more compact. Tap anywhere on a card to open the game, and a countdown to the next reset runs along the bottom.",
      "The home page shows how many games are listed, with Popular Today and Newly Added side by side.",
      "Link your Discord and Twitch sign-ins to one account from Settings.",
      "The game browser filters as you type.",
      "A list tagged with a Twitch streamer shows a LIVE tag on their Twitch button while they're streaming.",
      "Each game has its own preview image when shared, and some games have a \"How to play\" section.",
      "New games are announced in the #dailies channel on Discord.",
      "Vote counts update live. Curated lists update live and can be sorted by votes.",
      "Open pages reload themselves after the site is updated.",
      "Missing pages show a proper \"not found\" page, and the whole site is HTTPS only."
    ]
  },
  {
    date: "2026-10-06",
    items: [
      "Reset times are shown in your own time zone.",
      "A public moderation log shows every game approved, denied, hidden, restored or deleted, and every NSFW or paywall label change.",
      "Sign in with Twitch, from a new sign-in page.",
      "Curated lists can be tagged with a Twitch streamer. Tagged lists get a verified badge and a link to the channel, and the streamer can edit the list.",
      "Vote for and favorite games straight from a curated list.",
      "Light mode, toggled from the header. Dark is still the default.",
      "A new icon, and the site can be installed as an app.",
      "The submission form accepts more ways of writing links and times, and its errors say exactly what's wrong."
    ]
  },
  {
    date: "2026-10-05",
    items: [
      "Games that reset on their server's clock can have a time zone.",
      "Curated lists show reset times. Rotations and curated lists can be sorted by which game resets soonest.",
      "Each category has its own page.",
      "Moderators can hide or delete a reported game straight from the report.",
      "Fewer games are wrongly flagged as having broken links."
    ]
  },
  {
    date: "2026-09-03",
    items: [
      "Mark a game as paywalled or NSFW when submitting it, and hide either kind while browsing.",
      "A \"Feeling auspicious?\" button picks a random game for you."
    ]
  },
  {
    date: "2026-09-01",
    items: [
      "Launch. Browse, vote for and favorite daily games, and build a rotation of the ones you play. Rotations can be exported and imported as a file.",
      "Submit a game, with or without signing in.",
      "Curated lists, put together by editors. Games can be added from their own pages and reordered by dragging.",
      "Games that cost money to play get a green $ badge.",
      "Rankings take into account how often a game is opened and how many lists feature it."
    ]
  }
];
