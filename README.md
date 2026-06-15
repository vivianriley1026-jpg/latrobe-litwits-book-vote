# Book Vote

A small book-club ballot app for creating a shared voting link.

## What It Does

- Creates a ballot from a list of people and their recommended books.
- Starts with the Latrobe Litwits ballot details pulled from the screenshots in this folder.
- Lets the organizer choose a 24 hour, 48 hour, 72 hour, or 1 week voting window.
- Gives the organizer an admin link and a clean share link for the group chat.
- Prevents someone from voting for the book they recommended.
- Lets people change their vote until the ballot closes.
- Hides vote totals until the timer ends or the organizer closes the ballot.

## Current Preset

The create screen is prefilled with:

- Charlie: `Choke Points` by Edward Fishman
- Jacob: `Rasputin: The Downfall of the Romanovs` by Antony Beevor
- Perry: `Founding Brothers` by Joseph Ellis
- Zac: `Diplomacy` by Henry Kissinger
- Zach: `Relentless` by Tim Grover
- Member 6: `Rubicon` by Tom Holland
- Member 7: `The Political Thought of Xi Jinping` by Olivia Cheung & Steve Tsang

The screenshots showed two members only as phone numbers, so they are left as `Member 6` and `Member 7` for editing before a real ballot is created. The chat screenshot also appears to swap `Lolita` for `Rasputin: The Downfall of the Romanovs`, so the preset uses `Rasputin`.

## Run Locally

From this folder:

```sh
node server.js
```

Then open:

```text
http://127.0.0.1:3000
```

On this Mac, if `node` is not on your normal path, this bundled runtime worked during testing:

```sh
/Users/timothyleonard/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server.js
```

## Make A Real Shareable Link

To paste a link into iMessage, this app needs to be running on a public host. The simplest setup is a small Node host with persistent file storage, such as Render, Railway, Fly.io, or a VPS.

Use these settings:

- Build command: none
- Start command: `node server.js`
- Port: use the host-provided `PORT` environment variable
- Persistent storage: keep the `data` folder so votes survive restarts

After it is hosted, open the public URL, create a ballot, and paste the generated share link into the text thread. Keep the admin link for yourself.
