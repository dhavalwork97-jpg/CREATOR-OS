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
  // Instagram feed images must be JPEG with an aspect ratio between 4:5 and 1.91:1; Reels must be MP4/MOV.
  async function prepareFile(card, file) {
    if (card.format === "reel") {
      if (!["video/mp4", "video/quicktime"].includes(file.type)) throw new Error("Reels must be an MP4 or MOV video.");
      return file;
    }
    if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
    const bitmap = await createImageBitmap(file);
    const ratio = bitmap.width / bitmap.height;
    if (ratio < 0.8 || ratio > 1.91) throw new Error("Instagram feed images must be between 4:5 and 1.91:1. This one is " + bitmap.width + "×" + bitmap.height + ". Regenerate it using the 4:5 prompt.");
    if (file.type === "image/jpeg" && file.size <= 8 * 1024 * 1024 && bitmap.width <= 1440) return file;
    const scale = Math.min(1, 1440 / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("Could not convert the image to JPEG.");
    return blob;
  }
  function render(cards, zone, storage) {
    const list = $("board-cards");
    if (!cards.length) { list.innerHTML = '<p class="status">No content cards yet. Generate a weekly board to get started.</p>'; return; }
    list.innerHTML = cards.map(card => '<article class="board-card" data-id="' + esc(card.id) + '">' +
      '<div class="board-card-head"><strong>' + esc(card.day) + ' · ' + esc(card.format.toUpperCase()) + '</strong><span class="board-status">' + esc(card.status.replaceAll("_", " ")) + '</span></div>' +
      '<p class="meta">' + esc(card.pillar) + ' · Suggested slot: ' + esc(card.suggestedSlotLabel || "No slot available") + ' (' + esc(zone || "configured timezone") + ')</p>' +
      '<p>' + esc(card.idea) + '</p>' +
      '<label>AI media prompt</label><textarea class="board-prompt" maxlength="2000">' + esc(card.prompt) + '</textarea>' +
      '<label>Caption and hashtags</label><textarea class="board-caption" maxlength="2200">' + esc(card.caption) + '</textarea>' +
      '<label>Public HTTPS media URL · ' + (card.format === "reel" ? "MP4/MOV video" : "JPEG image") + '</label><input class="board-media" type="url" placeholder="https://your-host.example/media-file" value="' + esc(card.mediaUrl || "") + '">' +
      (card.mediaUrl ? (card.format === "reel"
        ? '<video src="' + esc(card.mediaUrl) + '" controls muted playsinline preload="metadata" style="display:block;max-width:100%;max-height:260px;border-radius:8px;margin-top:8px"></video>'
        : '<img src="' + esc(card.mediaUrl) + '" alt="Attached media preview" style="display:block;max-width:100%;max-height:260px;border-radius:8px;margin-top:8px">') : '') +
      (card.status !== "scheduled" && storage && storage.configured
        ? '<label>Or upload a file · ' + (card.format === "reel" ? "MP4 or MOV video, up to " + Math.round(storage.videoMaxBytes / 1048576) + " MB" : "image (PNG, JPEG or WebP; converted to JPEG)") + '</label><input class="board-upload" type="file" accept="' + (card.format === "reel" ? "video/mp4,video/quicktime" : "image/png,image/jpeg,image/webp") + '"><p class="agent-note board-upload-msg">Files are stored in your own Cloudinary account. Today: ' + storage.uploadsToday + '/' + storage.maxUploadsPerDay + ' uploads.</p>'
        : '<p class="agent-note">' + (storage && storage.configured ? "" : "Uploads are disabled until media storage is configured (see the README). You can still paste a public HTTPS URL.") + '</p>') +
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
      const fileInput = cardEl.querySelector(".board-upload");
      if (fileInput) fileInput.addEventListener("change", async () => {
        const file = fileInput.files[0]; if (!file) return;
        const note = cardEl.querySelector(".board-upload-msg");
        const card = cards.find(item => item.id === id);
        const buttons = cardEl.querySelectorAll("button"); buttons.forEach(b => b.disabled = true); fileInput.disabled = true;
        try {
          note.textContent = "Preparing file…";
          const blob = await prepareFile(card, file);
          note.textContent = "Requesting a secure upload link…";
          const pre = await request("/api/board/" + id + "/presign", { contentType: blob.type, size: blob.size });
          note.textContent = "Uploading " + Math.round(blob.size / 1024) + " KB…";
          const form = new FormData();
          Object.entries(pre.fields).forEach(([name, value]) => form.append(name, value));
          form.append("file", blob, blob.type === "video/quicktime" ? "upload.mov" : blob.type === "video/mp4" ? "upload.mp4" : "upload.jpg");
          const put = await fetch(pre.uploadUrl, { method: "POST", body: form });
          const uploaded = await put.json().catch(() => ({}));
          if (!put.ok) throw new Error((uploaded.error && uploaded.error.message) || "Upload failed (HTTP " + put.status + ").");
          note.textContent = "Checking the public link…";
          await request("/api/board/" + id + "/media", { key: pre.key, format: uploaded.format, bytes: uploaded.bytes });
          $("board-message").textContent = "Media uploaded. Review the card, then approve it.";
          await refresh();
        } catch (error) {
          note.textContent = error.message; fileInput.value = "";
          buttons.forEach(b => b.disabled = false); fileInput.disabled = false;
        }
      });
    });
  }
  async function refresh() {
    try { const state = await request("/api/state"); render(state.boardCards || [], state.schedule && state.schedule.label, state.storage); }
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
