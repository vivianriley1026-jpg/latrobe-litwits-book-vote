# Book Vote

Latrobe Litwits’ book-club nominations and voting app. Production server has no runtime dependencies.

## Shared nominations

1. Open the app and leave **Let members submit through a shared link** selected.
2. Name the round and choose its eventual voting window (5, 24, 48, 72 hours or one week).
3. Click **Create share link**. Keep/bookmark the private organizer link; share only the **Member link**.
4. Each member enters their name, book title and author. Members can instead join without recommending a book.
5. Members can edit their own entry in the same browser until voting opens. Their edit key stays in browser storage and is never included in the public poll response. Names are unique within a round; people with the same first name should use their full names.
6. When everyone has joined, use the private organizer link to **Close nominations & start voting**. At least two books are required. This locks the list and starts the full voting window at that moment—not when the round was created.
7. Send the same member link again for voting. Members choose their names, cannot vote for their own recommendation, and can change votes until the deadline. The organizer can close voting early.

This is a small trusted-club tool, not an identity-verified election system: names on the voter selector are honor-based, as in the original app. Keep the group link within the club. Clearing browser storage loses the member’s nomination-edit key; saving the organizer link is important because there is no account recovery flow.

## Manual ballots and existing rounds

Choose **Enter everyone’s books and start voting now** to use the original manual workflow. Include all voters, leaving the book blank for anyone not making a recommendation. Old ballots without a phase field remain readable/votable and retain their original deadlines and votes. No migration or reset is required.

## Run and test

```sh
npm start
# http://127.0.0.1:3000

npm ci
npm test
```

Tests cover the server lifecycle, authorization, concurrent submissions, protected editing, delayed timer, self-vote blocking, restart persistence, legacy ballots, form interactions, private-link separation, text escaping and draft-preserving refresh. UI interaction tests use JSDOM, not a visual browser.

## Hosting / storage

Live service: https://latrobe-litwits-book-vote.onrender.com/

- Start: `node server.js`
- Runtime: Node 18 or newer
- Host: `HOST`, defaults to localhost unless `PORT` is provided
- Port: host-provided `PORT`
- Store: `DATA_DIR` when supplied, otherwise `./data/polls.json`
- Existing Render persistent disk: `/opt/render/project/src/data`. **Keep this disk mounted. Never replace the production store with the repository’s sample file.**

Writes are serialized within a single Node process and use atomic file replacement. This file store is intended for one server instance; do not run multiple independent writers against it. Test/preview instances should use a temporary `DATA_DIR` so they never touch real ballots.
