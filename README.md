# ⛳ Shank

*Track your rounds, own your bad shots.*

A simple shared golf tracker for you and your buddies. Log your rounds, and
Shank keeps a season leaderboard, auto-calculated handicaps, and your round
history — all shared across everyone's phones.

## How it's built
- Plain HTML / CSS / JavaScript — no framework, no build step.
- **Supabase** stores the shared data (players + rounds) in the cloud.
- Hosted free on **GitHub Pages**.

## Files
- `index.html` — the app layout (3 tabs: Board, Round, Players)
- `styles.css` — mobile-first styling
- `app.js` — all the logic (data, handicap math, screens)
- `config.js` — Supabase connection (the publishable key here is safe to be public)

## Handicap
A simplified version of the real formula: it averages your *best* recent rounds
(relative to par) and multiplies by 0.96. Rough with 1–2 rounds, accurate as you
log more.
