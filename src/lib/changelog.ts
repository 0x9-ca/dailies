// What's new, shown at /changelog. Newest day first; one short, visitor-facing line per change (no internal or
// infrastructure work). Add an entry whenever a user-visible feature or change ships.
export type ChangelogDay = { date: string; items: string[] };

export const CHANGELOG: ChangelogDay[] = [
  {
    date: "2026-11-02",
    items: [
      "Opening a game from your rotation, a list or a game card now counts as a play, not just the Play button on its page.",
      "Import games into your rotation by pasting a list of names or links, like one copied from Discord.",
      "Share today's progress from your rotation: games played and your streak, ready to paste.",
      "Developers can add an Add to my rotation link to their own site, from their game page.",
      "Verified developers see stats for their game on its page: plays, rotations, lists and rating.",
      "Every category has its own page, with an overview, its games and related categories.",
      "Know when a game resets? Suggest its reset time from the game page.",
      "Short links (d.0x9.ca) now forward to dailies.0x9.ca, so you stay signed in.",
      "Game pages show more details: reset schedule, ratings, lists and answers to common questions.",
      "Browse pages have numbered page links.",
      "The home page warns you when an unplayed game in your rotation is about to reset, and the rotation's reset sort puts games you've played last.",
      "Reset times show friendly time zone names, plus the time where you are."
    ]
  },
  {
    date: "2026-10-30",
    items: [
      "Pages load faster: styles and scripts are now cached by your browser instead of downloaded with every page.",
      "Games added to a list in the last week get a New here pill.",
      "Lists have a panel badge for Twitch panels and socials. Copy the snippet from Stream settings.",
      "Search finds games even with a typo, and suggests what you might have meant.",
      "Better contrast and screen reader labels across the site.",
      "Shorter links: d.0x9.ca works everywhere dailies.0x9.ca does, and lists, games and shared rotations have short addresses like d.0x9.ca/c/northernlion. Share buttons now copy the short link.",
      "Stream mode now fits the whole list on screen, and slowly scrolls it if it still doesn't fit.",
      "A transparent overlay view for OBS shows where to suggest games and the top suggestions over your gameplay.",
      "Stream settings pick columns, scrolling, theme and more, and give you links to copy into OBS.",
      "Animations are switched off when your device asks for reduced motion.",
      "Public profiles show the curated lists their owner has made, with game counts and verified checks.",
      "Copy as text on your rotation copies today's games as a plain list for Discord, with a check on the ones you've played.",
      "Creator list pages are tidier on wide screens: the list gets most of the room, with Fan-dles and Suggestions as tabs in one sidebar.",
      "The sidebar collapses to a slim rail so the list can take the full width. Your choice is remembered on this device.",
      "Suggestions show the top 5 with a Show all button, in shorter rows.",
      "List headers are calmer: title, Twitch button and actions on one row, extra actions in a ... menu, and long descriptions fold behind More.",
      "Stream mode makes a list big and easy to read on a stream: large numbered rows, reset countdowns, and the top suggestions with where to send them. Turn it on from the list header, or add ?view=stream to the address for an OBS browser source. Esc exits.",
      "Game pages show a Players also play section with games that often share a rotation with it.",
      "Found a rotation someone shared? Copy to my rotation adds all its games to yours, signed in or not.",
      "Curated lists have an Add all to my rotation button next to Share.",
      "Game cards no longer run off the edge of very narrow phone screens.",
      "Game pages have a Mark as played button next to Play, so you can log a game without opening it. Tap it again to undo.",
      "Press ? anywhere for keyboard shortcuts: / to search, r for a random game, n for the next unplayed game in today's rotation, and g then h, b or r to go to Home, Browse or your Rotation.",
      "The home page has a Game of the day: one well-liked game, the same for everyone until midnight UTC.",
      "Surprise me on Browse opens a random game that matches your category and paywall filters. Random picks also skip the games you've hidden.",
      "Start typing in the search box and matching games appear right under it. Use the arrow keys and Enter to jump straight to one.",
      "The home page shows today's rotation at the top: how many games you've played, a Play next button and a link to your rotation.",
      "Turn on Remind me before resets on your rotation page to get a browser notification when a game you haven't played is about to reset (while a 0x9 dles tab is open).",
      "Your rotation page now shows a play history of the last 12 weeks, one square per day.",
      "Each category has its own feed of new games for any feed reader. Open a category on Browse and tap Feed under its name.",
      "Your rotation now shows how many of today's games you've played, a Play next button for the first one you haven't, and a day streak when you finish them all.",
      "Not interested in a game? Tap the eye on its card to hide it from the home page and Browse. You can undo it right away, or unhide games from the bottom of Browse or from Settings.",
      "Games listed in the last 7 days show a small New badge on their cards and their game page.",
      "A Share button on game pages and lists opens your device's share sheet, or copies the link where there isn't one.",
      "A new games feed at /feed.xml lists the 50 most recently added games, for any feed reader.",
      "Verified developers can add a badge with their game's rating to their own site, from the Help players find your game section.",
    ]
  },
  {
    date: "2026-10-21",
    items: [
      "Search from any page: a search box in the header on wide screens, and a search icon on phones and tablets that opens the full search bar. Press / to jump to it.",
    ]
  },
  {
    date: "2026-10-15",
    items: [
      "Verified developers who have joined our Discord server now get the Dle Developer role automatically: as soon as you verify a game, when you join afterwards, or the next time you sign in with Discord.",
      "Game pages no longer run off the edge of a phone screen.",
      "Main buttons such as Play and Browse games are now bright blue, so they no longer look disabled in the dark theme.",
      "The time zone field is now a regular picker with the most common zones (UTC, the US ones and the main European ones) at the top, so it no longer opens over the keyboard on phones.",
      "On phones, a streamer's list now has tabs for the list, Fan-dles and suggestions. On wide screens they sit side by side, with the list in the middle.",
      "Fan-dles: a section on a streamer's list for games made by their community. Verified developers who subscribe to the streamer, or have followed them for over a week, can show their games there after a one-time Twitch check. Streamers can hide a game or switch the section off.",
      "The submit form has an optional \"How to play\" box, shown on the game's page once an editor approves it.",
      "Submitting a game now asks if you made it. Say yes (and sign in, if you aren't) to start becoming its verified developer, and your answers are kept while you sign in. Once verified, you're offered a link to the game's page on 0x9 dles to share from your game and your socials.",
      "Twitch affiliates and partners are now verified creators when they sign in. They get a verified check and a public list of their own, open to suggestions from viewers, which they can edit or make private any time. If an editor already had a list for their channel, its games are copied over.",
      "A person can have at most 20 open suggestions on a list.",
      "Game cards keep their category pills to two lines. Extra categories fold into a +N chip you can tap to see them all; a verified developer is always shown.",
      "On phones, a game with several category pills no longer pushes its buttons onto a separate line: the pills wrap beside them.",
      "Games with a verified developer show a blue chip with their name on every game card and list row. If the developer has a public profile, tap it to open their profile.",
      "On the home page, the category list now uses the same coloured pills as the game cards, with the number of games in each.",
      "On wide screens, game cards keep their buttons on one row. The page you're on is underlined in the header, and keyboard users get a skip-to-content link.",
      "The submit form is easier to fill in on a phone, and it says up front that an editor reviews new games.",
      "Links, buttons and form fields are bigger to tap on phones, and the form text no longer makes iPhones zoom in.",
      "Keyboard focus is highlighted clearly, and the submit form has proper labels."
    ]
  },  {
    date: "2026-10-14",
    items: [
      "Public profiles. Turn one on in Settings to get a page with your name, picture and badges (verified developer, editor or admin, Twitch channel), the games you've made and, if you like, your daily rotation. Profiles are off until you switch them on.",
      "Made a game? Claim it from its page: add a small tag to your game's page (or a file to your site) and you become its verified developer, with a blue check. If you can't edit the page, an editor can confirm you instead.",
      "Verified developers can edit their game's title, link, description, how-to-play and reset time themselves. If a game's link changes, its developer has to be verified again at the new address."
    ]
  },
  {
    date: "2026-10-13",
    items: [
      "The home page explains what a dle is, names some of the best-known ones, and links every category."
    ]
  },
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
