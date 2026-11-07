(function () {
  const root = document.getElementById("content-board");
  if (!root) return;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  async function request(path, body) {
    const response = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (response.status === 401) { location.href = "/login.html"; throw new Error("Please sign in"); }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "Request failed (" + response.status + ")");
    return value;
  }
  function render(cards) {
    const list = $("board-cards");
    if (!cards.length) { list.innerHTML = '<p class="status">No content cards yet. Generate a weekly board to get started.</p>'; return; }
    list.innerHTML = cards.map(card => '<article class="board-card" data-id="' + esc(card.id) + '">' +
      '<div class="board-card-head"><strong>' + esc(card.day) + ' · ' + esc(card.format.toUpperCase()) + '</strong><span class="board-status">' + esc(card.status.replaceAll("_", " ")) + '</span></div>' +
      '<p class="meta">' + esc(card.pillar) + ' · Suggested slot: ' + esc(card.suggestedSlotLabel || "No slot available") + ' (Ahmedabad time)</p>' +
      '<p>' + esc(card.idea) + '</p>' +
      '<label>AI media prompt</label><textarea class="board-prompt" maxlength="2000">' + esc(card.prompt) + '</textarea>' +
      '<label>Caption and hashtags</label><textarea class="board-caption" maxlength="2200">' + esc(card.caption) + '</textarea>' +
      '<label>Public HTTPS media URL · ' + (card.format === "reel" ? "MP4/MOV video" : "JPEG image") + '</label><input class="board-media" type="url" placeholder="https://your-host.example/media-file" value="' + esc(card.mediaUrl || "") + '">' +
      '<p class="agent-note">Upload media to a host you already use and paste its direct public HTTPS URL. Creator OS does not store uploaded files.</p>' +
      '<div class="agent-actions">' +
      (card.status === "scheduled" ? '<span class="agent-note">Scheduled for ' + esc(new Date(card.scheduledAt).toLocaleString()) + '</span>' :
      '<button type="button" class="secondary board-save">Save card</button><button type="button" class="board-approve">Approve & schedule</button><button type="button" class="danger board-discard">Discard</button>') +
      '</div></article>').join("");
    list.querySelectorAll(".board-card").forEach(cardEl => {
      const id = cardEl.dataset.id;
      const run = async (action, body) => {
        const buttons = cardEl.querySelectorAll("button"); buttons.forEach(b => b.disabled = true);
        try { await request("/api/board/" + id + "/" + action, body || {}); $("board-message").textContent = action === "approve" ? "Approved and added to the existing schedule queue." : action === "discard" ? "Card discarded." : "Card saved."; await refresh(); }
        catch (error) { $("board-message").textContent = error.message; buttons.forEach(b => b.disabled = false); }
      };
      cardEl.querySelector(".board-save")?.addEventListener("click", () => run("update", { prompt: cardEl.querySelector(".board-prompt").value, caption: cardEl.querySelector(".board-caption").value, mediaUrl: cardEl.querySelector(".board-media").value }));
      cardEl.querySelector(".board-approve")?.addEventListener("click", () => run("approve"));
      cardEl.querySelector(".board-discard")?.addEventListener("click", () => run("discard"));
    });
  }
  async function refresh() {
    try { const state = await request("/api/state"); render(state.boardCards || []); }
    catch (error) { $("board-message").textContent = error.message; }
  }
  $("board-form").addEventListener("submit", async event => {
    event.preventDefault();
    const button = $("board-generate"); button.disabled = true; $("board-message").textContent = "Building your content board…";
    try {
      await request("/api/board/generate", {
        niche: $("board-niche").value, audience: $("board-audience").value,
        objective: $("board-objective").value,
        pillars: $("board-pillars").value.split(",").map(x => x.trim()).filter(Boolean),
        postsPerWeek: Number($("board-frequency").value)
      });
      $("board-message").textContent = "Board generated. Review each prompt and caption, attach media, then approve individual cards.";
      await refresh();
    } catch (error) { $("board-message").textContent = error.message; }
    finally { button.disabled = false; }
  });
  refresh();
})();
