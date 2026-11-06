import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomBytes, randomUUID, randomInt } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || join(ROOT, "data");
const DATA_FILE = join(DATA_DIR, "polls.json");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function ensureStore() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) {
    await writeFile(DATA_FILE, JSON.stringify({ polls: {} }, null, 2));
  }
}

async function readStore() {
  return JSON.parse(await readFile(DATA_FILE, "utf8"));
}

async function writeStore(store) {
  const temporary = `${DATA_FILE}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2));
  await rename(temporary, DATA_FILE);
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function cleanText(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function publicPoll(poll, adminKey) {
  const now = Date.now();
  const phase = poll.phase || "voting";
  const closed = Boolean(poll.closedAt || (phase !== "nominations" && now >= new Date(poll.closesAt).getTime()));
  const votesByBook = Object.fromEntries(poll.books.map((book) => [book.id, 0]));

  for (const vote of Object.values(poll.votes)) {
    if (votesByBook[vote.bookId] !== undefined) votesByBook[vote.bookId] += 1;
  }

  const maxVotes = Math.max(0, ...Object.values(votesByBook));
  const winners = closed
    ? poll.books.filter((book) => votesByBook[book.id] === maxVotes && maxVotes > 0).map((book) => book.id)
    : [];

  return {
    id: poll.id,
    title: poll.title,
    phase,
    roundNumber: poll.roundNumber || 1,
    allowSelfVote: Boolean(poll.allowSelfVote),
    randomDraw: poll.randomDraw || null,
    roundHistory: (poll.roundHistory || []).map(({ votes, ...summary }) => summary),
    durationHours: poll.durationHours || 48,
    votingStartedAt: poll.votingStartedAt || poll.createdAt,
    createdAt: poll.createdAt,
    closesAt: poll.closesAt,
    closed,
    closedAt: poll.closedAt || null,
    isAdmin: Boolean(adminKey && adminKey === poll.adminKey),
    participants: poll.participants.map(({ id, name }) => ({ id, name })),
    books: poll.books,
    votes: poll.votes,
    results: closed ? { votesByBook, winners } : null,
    voteCount: Object.keys(poll.votes).length
  };
}

async function createPoll(req, res) {
  const body = req.body;
  const title = cleanText(body.title || "Book Club Ballot", 80);
  const hours = Number(body.hours);
  const durationHours = [5, 24, 48, 72, 168].includes(hours) ? hours : 48;

  const nominations = body.mode === "nominations";
  const entries = !nominations && Array.isArray(body.entries) ? body.entries : [];
  const cleanedEntries = entries
    .map((entry) => ({
      name: cleanText(entry.name, 60),
      title: cleanText(entry.title, 120),
      author: cleanText(entry.author, 80)
    }))
    .filter((entry) => entry.name);

  const bookEntries = cleanedEntries.filter((entry) => entry.title);

  if (!nominations && cleanedEntries.length < 2) {
    json(res, 400, { error: "Add at least two people." });
    return;
  }

  if (!nominations && bookEntries.length < 2) {
    json(res, 400, { error: "Add at least two book recommendations." });
    return;
  }

  const names = new Set(cleanedEntries.map((entry) => entry.name.toLocaleLowerCase()));
  if (names.size !== cleanedEntries.length) {
    json(res, 400, { error: "Each person needs a unique name." });
    return;
  }

  const id = randomBytes(5).toString("base64url");
  const adminKey = randomBytes(16).toString("base64url");
  const participants = cleanedEntries.map((entry) => ({ id: randomUUID(), name: entry.name }));
  const books = cleanedEntries
    .map((entry, index) => ({ entry, participant: participants[index] }))
    .filter(({ entry }) => entry.title)
    .map(({ entry, participant }) => ({
      id: randomUUID(),
      title: entry.title,
      author: entry.author,
      recommenderId: participant.id
    }));

  const now = new Date();
  const poll = {
    id,
    adminKey,
    title,
    createdAt: now.toISOString(),
    phase: nominations ? "nominations" : "voting",
    durationHours,
    votingStartedAt: nominations ? null : now.toISOString(),
    closesAt: nominations ? null : new Date(now.getTime() + durationHours * 60 * 60 * 1000).toISOString(),
    closedAt: null,
    participants,
    books,
    votes: {}
  };

  const store = await readStore();
  store.polls[id] = poll;
  await writeStore(store);

  json(res, 201, {
    poll: publicPoll(poll, adminKey),
    sharePath: `/poll/${id}`,
    adminPath: `/poll/${id}?admin=${adminKey}`
  });
}

async function getPoll(id, req, res) {
  const store = await readStore();
  const poll = store.polls[id];
  if (!poll) {
    json(res, 404, { error: "Ballot not found." });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  json(res, 200, { poll: publicPoll(poll, url.searchParams.get("admin")) });
}

async function vote(id, req, res) {
  const body = req.body;
  const participantId = cleanText(body.participantId, 80);
  const bookId = cleanText(body.bookId, 80);
  const store = await readStore();
  const poll = store.polls[id];

  if (!poll) {
    json(res, 404, { error: "Ballot not found." });
    return;
  }

  if (poll.phase === "nominations") {
    json(res, 403, { error: "Nominations are still open. Voting has not started." });
    return;
  }

  if (poll.closedAt || Date.now() >= new Date(poll.closesAt).getTime()) {
    json(res, 403, { error: "Voting is closed." });
    return;
  }

  const participant = poll.participants.find((person) => person.id === participantId);
  const book = poll.books.find((candidate) => candidate.id === bookId);

  if (!participant || !book) {
    json(res, 400, { error: "Choose your name and a book." });
    return;
  }

  if (!poll.allowSelfVote && book.recommenderId === participant.id) {
    json(res, 403, { error: "You cannot vote for the book you recommended." });
    return;
  }

  poll.votes[participant.id] = {
    participantId: participant.id,
    bookId: book.id,
    votedAt: new Date().toISOString()
  };
  await writeStore(store);

  json(res, 200, { poll: publicPoll(poll, body.adminKey) });
}

async function closePoll(id, req, res) {
  const body = req.body;
  const adminKey = cleanText(body.adminKey, 80);
  const store = await readStore();
  const poll = store.polls[id];

  if (!poll) {
    json(res, 404, { error: "Ballot not found." });
    return;
  }

  if (adminKey !== poll.adminKey) {
    json(res, 403, { error: "Admin link required." });
    return;
  }

  if (poll.phase === "nominations") {
    json(res, 400, { error: "Start voting before closing the ballot." });
    return;
  }

  if (!poll.closedAt) poll.closedAt = new Date().toISOString();
  await writeStore(store);
  json(res, 200, { poll: publicPoll(poll, adminKey) });
}

async function nominate(id, req, res) {
  const body = req.body;
  const store = await readStore();
  const poll = store.polls[id];
  if (!poll) return json(res, 404, { error: "Ballot not found." });
  if (poll.phase !== "nominations" || poll.closedAt) {
    return json(res, 403, { error: "Nominations have closed. The ballot is now locked." });
  }
  const name = cleanText(body.name, 60);
  const title = body.voterOnly === true ? "" : cleanText(body.title, 120);
  const author = body.voterOnly === true ? "" : cleanText(body.author, 80);
  if (!name || (body.voterOnly !== true && (!title || !author))) {
    return json(res, 400, { error: "Enter your name, book title and author, or choose to join without a book." });
  }
  let person = body.participantId ? poll.participants.find(p => p.id === body.participantId) : null;
  if (body.participantId && (!person || !person.editKey || person.editKey !== body.editKey)) {
    return json(res, 403, { error: "Use the same browser you submitted from to edit your recommendation." });
  }
  if (poll.participants.some(p => p.id !== person?.id && p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return json(res, 409, { error: "That name is already on the list. To edit, use the browser you submitted from. If you share a name, add your last name." });
  }
  if (!person) {
    person = { id: randomUUID(), name, editKey: randomBytes(24).toString("base64url") };
    poll.participants.push(person);
  } else person.name = name;
  const existing = poll.books.find(b => b.recommenderId === person.id);
  poll.books = poll.books.filter(b => b.recommenderId !== person.id);
  if (title) poll.books.push({ id: existing?.id || randomUUID(), title, author, recommenderId: person.id });
  await writeStore(store);
  json(res, 200, { poll: publicPoll(poll, body.adminKey), participantId: person.id, editKey: person.editKey });
}

async function startVoting(id, req, res) {
  const store = await readStore();
  const poll = store.polls[id];
  if (!poll) return json(res, 404, { error: "Ballot not found." });
  if (req.body.adminKey !== poll.adminKey) return json(res, 403, { error: "Organizer link required." });
  if (poll.phase !== "nominations" || poll.closedAt) return json(res, 409, { error: "Voting has already started." });
  if (poll.participants.length < 2 || poll.books.length < 2) {
    return json(res, 400, { error: "At least two members and two book recommendations are needed before voting starts." });
  }
  const now = new Date();
  poll.phase = "voting";
  poll.votingStartedAt = now.toISOString();
  poll.closesAt = new Date(now.getTime() + poll.durationHours * 3600000).toISOString();
  await writeStore(store);
  json(res, 200, { poll: publicPoll(poll, req.body.adminKey) });
}

async function startRunoff(id, req, res) {
  const store = await readStore();
  const poll = store.polls[id];
  if (!poll) return json(res, 404, { error: "Ballot not found." });
  if (req.body.adminKey !== poll.adminKey) return json(res, 403, { error: "Organizer link required." });
  const result = publicPoll(poll);
  if (!result.closed || result.results.winners.length < 2 || (poll.roundNumber || 1) !== 1) {
    return json(res, 409, { error: "A runoff is available only after the first vote closes with a tie." });
  }
  // Keep the original books, counts and individual votes. The member URL and roster stay the same.
  poll.roundHistory = [{
    roundNumber: 1, books: structuredClone(poll.books), participants: structuredClone(result.participants),
    votes: structuredClone(poll.votes), results: result.results, voteCount: result.voteCount,
    votingStartedAt: poll.votingStartedAt || poll.createdAt, closesAt: poll.closesAt,
    closedAt: poll.closedAt || poll.closesAt
  }];
  const finalists = new Set(result.results.winners);
  poll.books = poll.books.filter(book => finalists.has(book.id));
  poll.votes = {};
  poll.roundNumber = 2;
  poll.allowSelfVote = true;
  poll.durationHours = 5;
  poll.phase = "voting";
  poll.closedAt = null;
  poll.votingStartedAt = new Date().toISOString();
  poll.closesAt = new Date(Date.parse(poll.votingStartedAt) + 5 * 3600000).toISOString();
  await writeStore(store);
  json(res, 200, { poll: publicPoll(poll, req.body.adminKey) });
}

async function drawWinner(id, req, res) {
  const store = await readStore();
  const poll = store.polls[id];
  if (!poll) return json(res, 404, { error: "Ballot not found." });
  if (req.body.adminKey !== poll.adminKey) return json(res, 403, { error: "Organizer link required." });
  // Retried requests return the saved outcome rather than drawing a second time.
  if (poll.randomDraw) return json(res, 200, { poll: publicPoll(poll, req.body.adminKey) });
  const result = publicPoll(poll);
  if (!result.closed || poll.roundNumber !== 2 || result.results.winners.length < 2) {
    return json(res, 409, { error: "A random draw is available only if the completed runoff is still tied." });
  }
  const candidates = result.results.winners;
  poll.randomDraw = {
    candidateIds: [...candidates], winnerId: candidates[randomInt(candidates.length)],
    drawnAt: new Date().toISOString(), method: "Equal-chance random draw among tied runoff winners"
  };
  await writeStore(store);
  json(res, 200, { poll: publicPoll(poll, req.body.adminKey) });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" || url.pathname.startsWith("/poll/")
    ? "/index.html"
    : decodeURIComponent(url.pathname);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Referrer-Policy": "no-referrer"
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

// Serialize complete read/modify/write transactions, including simultaneous nominations.
// Atomic renames let readers see either the old or new complete store, never partial JSON.
let mutations = Promise.resolve();
function mutate(operation) {
  const next = mutations.then(operation);
  mutations = next.catch(() => {});
  return next;
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pollMatch = url.pathname.match(/^\/api\/polls\/([^/]+)$/);
    const actionMatch = url.pathname.match(/^\/api\/polls\/([^/]+)\/(vote|close|nominate|start|runoff|draw)$/);
    if (req.method === "POST") {
      try { req.body = await readBody(req); }
      catch { return json(res, 400, { error: "Invalid request body." }); }
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        return json(res, 400, { error: "Invalid request body." });
      }
      if (url.pathname === "/api/polls") return await mutate(() => createPoll(req, res));
      if (actionMatch) {
        const handlers = { vote, close: closePoll, nominate, start: startVoting, runoff: startRunoff, draw: drawWinner };
        return await mutate(() => handlers[actionMatch[2]](actionMatch[1], req, res));
      }
    }
    if (req.method === "GET" && pollMatch) return await getPoll(pollMatch[1], req, res);
    if (req.method === "GET") return await serveStatic(req, res);
    json(res, 405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: "Could not save this change. Please try again." });
  }
});

await ensureStore();
server.listen(PORT, HOST, () => {
  console.log(`Book Vote is running at http://${HOST}:${server.address().port}`);
});
