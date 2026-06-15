const createView = document.querySelector("#createView");
const pollView = document.querySelector("#pollView");
const entries = document.querySelector("#entries");
const entryTemplate = document.querySelector("#entryTemplate");
const createForm = document.querySelector("#createForm");
const createMessage = document.querySelector("#createMessage");
const statusPill = document.querySelector("#statusPill");
const pollState = document.querySelector("#pollState");
const pollName = document.querySelector("#pollName");
const timer = document.querySelector("#timer");
const progressBar = document.querySelector("#progressBar");
const shareLink = document.querySelector("#shareLink");
const copyShare = document.querySelector("#copyShare");
const closeNow = document.querySelector("#closeNow");
const voteArea = document.querySelector("#voteArea");
const voteMessage = document.querySelector("#voteMessage");

let activePoll = null;
let timerHandle = null;

const latrobePreset = [
  { name: "Charlie", title: "Choke Points", author: "Edward Fishman" },
  { name: "Jacob", title: "Rasputin: The Downfall of the Romanovs", author: "Antony Beevor" },
  { name: "Perry", title: "Founding Brothers", author: "Joseph Ellis" },
  { name: "Zac", title: "Diplomacy", author: "Henry Kissinger" },
  { name: "Zach", title: "Relentless", author: "Tim Grover" },
  { name: "Member 6", title: "Rubicon", author: "Tom Holland" },
  { name: "Member 7", title: "The Political Thought of Xi Jinping", author: "Olivia Cheung & Steve Tsang" }
];

function setStatus(text) {
  statusPill.textContent = text;
}

function addEntry(values = {}) {
  const node = entryTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".entry-name").value = values.name || "";
  node.querySelector(".entry-title").value = values.title || "";
  node.querySelector(".entry-author").value = values.author || "";
  node.querySelector(".remove-entry").addEventListener("click", () => {
    if (entries.children.length > 2) node.remove();
  });
  entries.append(node);
}

function seedEntries() {
  document.querySelector("#pollTitle").value = "Latrobe Litwits: Next Read";
  latrobePreset.forEach(addEntry);
}

function collectEntries() {
  return [...entries.querySelectorAll(".entry-row")].map((row) => ({
    name: row.querySelector(".entry-name").value,
    title: row.querySelector(".entry-title").value,
    author: row.querySelector(".entry-author").value
  }));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Something went wrong.");
  return payload;
}

function pollIdFromPath() {
  const match = window.location.pathname.match(/^\/poll\/([^/]+)$/);
  return match ? match[1] : null;
}

function adminKey() {
  return new URLSearchParams(window.location.search).get("admin");
}

function absoluteUrl(path) {
  return `${window.location.origin}${path}`;
}

function participantName(id) {
  return activePoll.participants.find((person) => person.id === id)?.name || "Someone";
}

function bookMeta(book) {
  return book.author
    ? `Recommended by ${participantName(book.recommenderId)} - ${book.author}`
    : `Recommended by ${participantName(book.recommenderId)}`;
}

function formatRemaining(ms) {
  if (ms <= 0) return "Voting closed";
  const totalMinutes = Math.ceil(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

function updateTimer() {
  if (!activePoll) return;

  const created = new Date(activePoll.createdAt).getTime();
  const closes = new Date(activePoll.closesAt).getTime();
  const now = Date.now();
  const remaining = closes - now;
  const elapsed = Math.max(0, now - created);
  const total = Math.max(1, closes - created);
  const percent = activePoll.closed ? 100 : Math.min(100, (elapsed / total) * 100);

  progressBar.style.width = `${percent}%`;
  timer.textContent = activePoll.closed ? "Voting closed" : formatRemaining(remaining);

  if (!activePoll.closed && remaining <= 0) loadPoll();
}

function selectedParticipantId() {
  return localStorage.getItem(`bookvote:${activePoll.id}:participant`) || "";
}

function rememberParticipant(id) {
  localStorage.setItem(`bookvote:${activePoll.id}:participant`, id);
}

function renderVoteArea() {
  const chosenParticipantId = selectedParticipantId();
  const chosenVote = activePoll.votes[chosenParticipantId]?.bookId;

  if (activePoll.closed) {
    renderResults();
    return;
  }

  const options = activePoll.participants
    .map((person) => `<option value="${person.id}" ${person.id === chosenParticipantId ? "selected" : ""}>${escapeHtml(person.name)}</option>`)
    .join("");

  voteArea.innerHTML = `
    <div class="vote-header">
      <div>
        <p class="eyebrow">Cast your vote</p>
        <h2>${activePoll.voteCount} of ${activePoll.participants.length} voted</h2>
      </div>
      <label class="select-wrap">
        Your name
        <select id="participantSelect">
          <option value="">Select</option>
          ${options}
        </select>
      </label>
    </div>
    <div class="book-list">
      ${activePoll.books.map((book) => {
        const ownBook = book.recommenderId === chosenParticipantId;
        const selected = chosenVote === book.id;
        return `
          <article class="book-card ${ownBook ? "disabled" : ""}">
            <div>
              <p class="book-title">${escapeHtml(book.title)}</p>
              <p class="book-meta">${escapeHtml(bookMeta(book))}</p>
            </div>
            <button class="vote-button ${selected ? "selected" : ""}" data-book-id="${book.id}" ${!chosenParticipantId || ownBook ? "disabled" : ""}>
              ${ownBook ? "Yours" : selected ? "Picked" : "Vote"}
            </button>
          </article>
        `;
      }).join("")}
    </div>
  `;

  voteArea.querySelector("#participantSelect").addEventListener("change", (event) => {
    rememberParticipant(event.target.value);
    voteMessage.textContent = "";
    renderVoteArea();
  });

  voteArea.querySelectorAll(".vote-button[data-book-id]").forEach((button) => {
    button.addEventListener("click", () => submitVote(button.dataset.bookId));
  });
}

function renderResults() {
  const votesByBook = activePoll.results?.votesByBook || {};
  const winners = new Set(activePoll.results?.winners || []);
  const maxVotes = Math.max(1, ...Object.values(votesByBook));

  pollState.textContent = "Final results";
  voteArea.innerHTML = `
    <div class="vote-header">
      <div>
        <p class="eyebrow">Results</p>
        <h2>${activePoll.voteCount} of ${activePoll.participants.length} voted</h2>
      </div>
    </div>
    <div class="results-list">
      ${activePoll.books.map((book) => {
        const count = votesByBook[book.id] || 0;
        const width = Math.max(8, (count / maxVotes) * 100);
        return `
          <article class="book-card ${winners.has(book.id) ? "winner" : ""}">
            <div>
              <p class="book-title">${escapeHtml(book.title)}</p>
              <p class="book-meta">${escapeHtml(bookMeta(book))}</p>
              <div class="progress-wrap" aria-hidden="true"><div class="progress-bar" style="width: ${width}%"></div></div>
            </div>
            <div class="result-count">${count}</div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

async function submitVote(bookId) {
  try {
    voteMessage.textContent = "";
    const participantId = selectedParticipantId();
    const { poll } = await api(`/api/polls/${activePoll.id}/vote`, {
      method: "POST",
      body: JSON.stringify({ participantId, bookId })
    });
    activePoll = poll;
    renderPoll();
    voteMessage.style.color = "#167a61";
    voteMessage.textContent = "Vote saved.";
  } catch (error) {
    voteMessage.style.color = "#c84d39";
    voteMessage.textContent = error.message;
  }
}

function renderPoll() {
  createView.classList.add("hidden");
  pollView.classList.remove("hidden");
  setStatus(activePoll.closed ? "Closed" : "Open");
  pollState.textContent = activePoll.closed ? "Final results" : "Open ballot";
  pollName.textContent = activePoll.title;
  shareLink.value = absoluteUrl(`/poll/${activePoll.id}`);
  closeNow.classList.toggle("hidden", !activePoll.isAdmin || activePoll.closed);
  renderVoteArea();
  updateTimer();
  clearInterval(timerHandle);
  timerHandle = setInterval(updateTimer, 15000);
}

async function loadPoll() {
  const id = pollIdFromPath();
  if (!id) return;

  try {
    const params = adminKey() ? `?admin=${encodeURIComponent(adminKey())}` : "";
    const { poll } = await api(`/api/polls/${id}${params}`);
    activePoll = poll;
    renderPoll();
  } catch (error) {
    setStatus("Missing");
    createView.classList.remove("hidden");
    pollView.classList.add("hidden");
    createMessage.textContent = error.message;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

document.querySelector("#addEntry").addEventListener("click", () => addEntry());

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  createMessage.textContent = "";
  setStatus("Creating");

  try {
    const payload = {
      title: document.querySelector("#pollTitle").value,
      hours: Number(new FormData(createForm).get("hours")),
      entries: collectEntries()
    };
    const result = await api("/api/polls", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    activePoll = result.poll;
    window.history.pushState({}, "", result.adminPath);
    renderPoll();
  } catch (error) {
    setStatus("Ready");
    createMessage.textContent = error.message;
  }
});

copyShare.addEventListener("click", async () => {
  await navigator.clipboard.writeText(shareLink.value);
  copyShare.textContent = "Copied";
  setTimeout(() => {
    copyShare.textContent = "Copy";
  }, 1200);
});

closeNow.addEventListener("click", async () => {
  const { poll } = await api(`/api/polls/${activePoll.id}/close`, {
    method: "POST",
    body: JSON.stringify({ adminKey: adminKey() })
  });
  activePoll = poll;
  renderPoll();
});

seedEntries();
loadPoll();
