import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const ROOT = process.cwd();
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = join(ROOT, "data");
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
  await ensureStore();
  return JSON.parse(await readFile(DATA_FILE, "utf8"));
}

async function writeStore(store) {
  await writeFile(DATA_FILE, JSON.stringify(store, null, 2));
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
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
  const closed = poll.closedAt || now >= new Date(poll.closesAt).getTime();
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
    createdAt: poll.createdAt,
    closesAt: poll.closesAt,
    closed,
    closedAt: poll.closedAt || null,
    isAdmin: adminKey && adminKey === poll.adminKey,
    participants: poll.participants,
    books: poll.books,
    votes: poll.votes,
    results: closed ? { votesByBook, winners } : null,
    voteCount: Object.keys(poll.votes).length
  };
}

async function createPoll(req, res) {
  const body = await readBody(req);
  const title = cleanText(body.title || "Book Club Ballot", 80);
  const hours = Number(body.hours);
  const durationHours = [24, 48, 72, 168].includes(hours) ? hours : 48;

  const entries = Array.isArray(body.entries) ? body.entries : [];
  const cleanedEntries = entries
    .map((entry) => ({
      name: cleanText(entry.name, 60),
      title: cleanText(entry.title, 120),
      author: cleanText(entry.author, 80)
    }))
    .filter((entry) => entry.name && entry.title);

  if (cleanedEntries.length < 2) {
    json(res, 400, { error: "Add at least two people and two book recommendations." });
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
  const books = cleanedEntries.map((entry, index) => ({
    id: randomUUID(),
    title: entry.title,
    author: entry.author,
    recommenderId: participants[index].id
  }));

  const now = new Date();
  const poll = {
    id,
    adminKey,
    title,
    createdAt: now.toISOString(),
    closesAt: new Date(now.getTime() + durationHours * 60 * 60 * 1000).toISOString(),
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
  const body = await readBody(req);
  const participantId = cleanText(body.participantId, 80);
  const bookId = cleanText(body.bookId, 80);
  const store = await readStore();
  const poll = store.polls[id];

  if (!poll) {
    json(res, 404, { error: "Ballot not found." });
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

  if (book.recommenderId === participant.id) {
    json(res, 403, { error: "You cannot vote for the book you recommended." });
    return;
  }

  poll.votes[participant.id] = {
    participantId: participant.id,
    bookId: book.id,
    votedAt: new Date().toISOString()
  };
  await writeStore(store);

  json(res, 200, { poll: publicPoll(poll) });
}

async function closePoll(id, req, res) {
  const body = await readBody(req);
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

  if (!poll.closedAt) poll.closedAt = new Date().toISOString();
  await writeStore(store);
  json(res, 200, { poll: publicPoll(poll, adminKey) });
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
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream"
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pollMatch = url.pathname.match(/^\/api\/polls\/([^/]+)$/);
    const voteMatch = url.pathname.match(/^\/api\/polls\/([^/]+)\/vote$/);
    const closeMatch = url.pathname.match(/^\/api\/polls\/([^/]+)\/close$/);

    if (req.method === "POST" && url.pathname === "/api/polls") return createPoll(req, res);
    if (req.method === "GET" && pollMatch) return getPoll(pollMatch[1], req, res);
    if (req.method === "POST" && voteMatch) return vote(voteMatch[1], req, res);
    if (req.method === "POST" && closeMatch) return closePoll(closeMatch[1], req, res);

    if (req.method === "GET") return serveStatic(req, res);
    json(res, 405, { error: "Method not allowed." });
  } catch (error) {
    json(res, 500, { error: error.message || "Something went wrong." });
  }
});

await ensureStore();
server.listen(PORT, HOST, () => {
  console.log(`Book Vote is running at http://${HOST}:${PORT}`);
});
