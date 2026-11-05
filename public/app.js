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
  addEntry();
  addEntry();
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

  if (activePoll.phase === "nominations") {
    timer.textContent = "Nominations open";
    progressBar.style.width = "0%";
    return;
  }
  const created = new Date(activePoll.votingStartedAt || activePoll.createdAt).getTime();
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
  if (activePoll.phase === "nominations") return renderNominationArea();
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
      body: JSON.stringify({ participantId, bookId, adminKey: adminKey() })
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
  const nominating = activePoll.phase === "nominations";
  setStatus(nominating ? "Nominations" : activePoll.closed ? "Closed" : "Voting");
  pollState.textContent = nominating ? "Collecting the next shortlist" : activePoll.closed ? "Final results" : "Open ballot";
  pollName.textContent = activePoll.title;
  shareLink.value = absoluteUrl(`/poll/${activePoll.id}`);
  closeNow.classList.toggle("hidden", !activePoll.isAdmin || activePoll.closed || nominating);
  document.querySelector("#organizerControls").classList.toggle("hidden", !activePoll.isAdmin);
  document.querySelector("#organizerLink").value = activePoll.isAdmin ? window.location.href : "";
  updateOrganizer();
  renderVoteArea();
  updateTimer();
  clearInterval(timerHandle);
  timerHandle = setInterval(refreshPoll, 15000);
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
      mode: document.querySelector("#collectionMode").value,
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

function message(text, success = false) {
  voteMessage.style.color = success ? "#167a61" : "#c84d39";
  voteMessage.textContent = text;
}

function updateOrganizer() {
  const nominating = activePoll.phase === "nominations";
  const button = document.querySelector("#startVoting");
  button.classList.toggle("hidden", !nominating);
  button.disabled = activePoll.books.length < 2;
  document.querySelector("#startHelp").textContent = nominating
    ? `Wait for everyone to join, including members who only want to vote. At least two books are required. The ${activePoll.durationHours}-hour voting window starts when you open voting.` : "";
}

function nominationCredential() {
  try { return JSON.parse(localStorage.getItem(`bookvote:${activePoll.id}:nomination`) || "null"); }
  catch { return null; }
}

function renderNominationList() {
  const list = document.querySelector("#nominationList");
  if (!list) return;
  document.querySelector("#nominationCount").textContent = `${activePoll.books.length} books · ${activePoll.participants.length} members joined`;
  list.innerHTML = activePoll.books.map(book => `
    <article class="book-card"><div>
      <p class="book-title">${escapeHtml(book.title)}</p>
      <p class="book-meta">${escapeHtml(bookMeta(book))}</p>
    </div></article>`).join("") || '<p class="help empty-list">The shortlist starts here. Add the first recommendation above.</p>';
  const voters = activePoll.participants.filter(p => !activePoll.books.some(b => b.recommenderId === p.id));
  document.querySelector("#votersOnly").textContent = voters.length ? `Joining just to vote: ${voters.map(p => p.name).join(", ")}` : "";
}

function renderNominationArea() {
  const credential = nominationCredential();
  const person = activePoll.participants.find(p => p.id === credential?.participantId);
  const book = activePoll.books.find(b => b.recommenderId === person?.id);
  const voterOnly = Boolean(person && !book);
  voteArea.innerHTML = `
    <p class="eyebrow">Everyone gets a pick</p>
    <h2>${person ? "Your recommendation" : "What should we read next?"}</h2>
    <p class="help">One recommendation per member. No account needed. You can edit your entry in this browser until the organizer starts voting.</p>
    <form id="nominationForm" class="stack">
      <label>Your name<input id="nomineeName" name="name" required maxlength="60" autocomplete="name" value="${escapeHtml(person?.name || "")}" placeholder="First and last name" /></label>
      <label class="check-label"><input id="voterOnly" type="checkbox" ${voterOnly ? "checked" : ""} /> I’ll join the vote without recommending a book</label>
      <div id="bookFields" class="nomination-fields ${voterOnly ? "hidden" : ""}">
        <label>Book title<input name="title" id="nomineeTitle" maxlength="120" ${voterOnly ? "" : "required"} value="${escapeHtml(book?.title || "")}" placeholder="The book you want the club to read" /></label>
        <label>Author<input name="author" id="nomineeAuthor" maxlength="80" ${voterOnly ? "" : "required"} value="${escapeHtml(book?.author || "")}" placeholder="Author’s name" /></label>
      </div>
      <button class="primary" type="submit">${person ? "Save changes" : "Submit my recommendation"}</button>
    </form>
    <section class="shortlist" aria-label="Current nominations">
      <p class="eyebrow">The growing shortlist</p>
      <h2 id="nominationCount"></h2>
      <div id="nominationList" class="book-list"></div>
      <p id="votersOnly" class="help"></p>
      <p class="help">This list refreshes automatically. Return to this same link to vote.</p>
    </section>`;
  const only = document.querySelector("#voterOnly");
  function toggleBookFields() {
    document.querySelector("#bookFields").classList.toggle("hidden", only.checked);
    for (const id of ["#nomineeTitle", "#nomineeAuthor"]) document.querySelector(id).required = !only.checked;
    document.querySelector('#nominationForm button[type="submit"]').textContent = person ? "Save changes" : only.checked ? "Join the vote" : "Submit my recommendation";
  }
  only.addEventListener("change", toggleBookFields);
  toggleBookFields();
  document.querySelector("#nominationForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    message("");
    try {
      // Check that an edit key can be kept before creating the entry.
      localStorage.setItem("bookvote:storage-check", "ok");
      localStorage.removeItem("bookvote:storage-check");
      const result = await api(`/api/polls/${activePoll.id}/nominate`, {
        method: "POST",
        body: JSON.stringify({
          name: document.querySelector("#nomineeName").value,
          title: document.querySelector("#nomineeTitle").value,
          author: document.querySelector("#nomineeAuthor").value,
          voterOnly: only.checked,
          participantId: person ? credential.participantId : undefined,
          editKey: person ? credential.editKey : undefined,
          adminKey: adminKey()
        })
      });
      localStorage.setItem(`bookvote:${activePoll.id}:nomination`, JSON.stringify({ participantId: result.participantId, editKey: result.editKey }));
      rememberParticipant(result.participantId);
      activePoll = result.poll;
      renderPoll();
      message("Saved — you’re on the list. You can make changes here until voting opens.", true);
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  });
  renderNominationList();
}

let refreshing = false;
async function refreshPoll() {
  updateTimer();
  if (refreshing || !activePoll) return;
  refreshing = true;
  try {
    const params = adminKey() ? `?admin=${encodeURIComponent(adminKey())}` : "";
    const { poll } = await api(`/api/polls/${activePoll.id}${params}`);
    const changedPhase = poll.phase !== activePoll.phase || poll.closed !== activePoll.closed;
    activePoll = poll;
    if (changedPhase) {
      renderPoll();
      message(poll.closed ? "Voting has closed. Results are below." : "Voting is now open. Choose your name and cast your vote.", true);
    } else if (poll.phase === "nominations") {
      // Do not replace the form or erase an in-progress recommendation.
      renderNominationList();
      updateOrganizer();
    }
  } catch { /* Keep the member's form intact through a brief connection failure. */ }
  finally { refreshing = false; }
}

async function copyLink(input, button, normalText) {
  try {
    await navigator.clipboard.writeText(input.value);
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = normalText; }, 1400);
  } catch {
    input.focus(); input.select();
    message("Select and copy the highlighted link manually.");
  }
}
copyShare.addEventListener("click", () => copyLink(shareLink, copyShare, "Copy"));
document.querySelector("#copyOrganizer").addEventListener("click", (event) => copyLink(document.querySelector("#organizerLink"), event.target, "Copy private link"));

async function organizerAction(action, prompt) {
  if (!window.confirm(prompt)) return;
  try {
    const { poll } = await api(`/api/polls/${activePoll.id}/${action}`, {
      method: "POST", body: JSON.stringify({ adminKey: adminKey() })
    });
    activePoll = poll;
    renderPoll();
    message(action === "start" ? "Voting is open. Share the same member link with the club." : "Voting is closed. Results are ready.", true);
  } catch (error) { message(error.message); }
}
document.querySelector("#startVoting").addEventListener("click", () => organizerAction("start", `Everyone ready? This locks the member list and recommendations, and starts ${activePoll.durationHours} hours of voting.`));
closeNow.addEventListener("click", () => organizerAction("close", "Close voting now and reveal the results? This cannot be undone."));

document.querySelector("#collectionMode").addEventListener("change", (event) => {
  const manual = event.target.value === "manual";
  document.querySelector("#manualEntries").classList.toggle("hidden", !manual);
  document.querySelector("#collectionHelp").textContent = manual
    ? "Add every voter. Leave the book blank for anyone who wants to vote without a recommendation. Voting starts as soon as you create the link."
    : "Send one link to the club. Members add their own recommendations, then you open voting when everyone is ready.";
});
window.addEventListener("popstate", () => {
  clearInterval(timerHandle);
  if (pollIdFromPath()) loadPoll();
  else { activePoll = null; pollView.classList.add("hidden"); createView.classList.remove("hidden"); setStatus("Ready"); }
});
seedEntries();
loadPoll();
