(function () {
  const root = document.getElementById("providers");
  if (!root) return;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function request(path, body) {
    const response = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (response.status === 401) { location.href = "/login.html"; throw new Error("Please sign in"); }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "Request failed (" + response.status + ")");
    return value;
  }
  const badge = (provider) => '<span class="board-status">' + (provider.costClass === "paid" ? "PAID" : "FREE TIER") + "</span>";
  function storageHtml(st) {
    if (!st) return "";
    const mb = bytes => (bytes / 1048576).toFixed(bytes >= 1048576 * 10 ? 0 : 1) + " MB";
    return '<p><strong>Media storage · ' + esc(st.provider) + "</strong> " + '<span class="board-status">FREE TIER</span><br><span class="meta">' + (st.configured ? "Ready" + (st.publicHost ? " · public host " + esc(st.publicHost) : "") : "Not configured (set the CLOUDINARY_* variables on the server)") + "</span><br>" +
      '<span class="meta">Stored: ' + mb(st.usedBytes) + " of " + mb(st.maxBytes) + " (" + st.objects + " files) · uploads today " + st.uploadsToday + "/" + st.maxUploadsPerDay + "</span><br>" +
      '<span class="agent-note">' + esc(st.costNote) + "</span></p>";
  }
  function render(data) {
    const t = data.text, i = data.image;
    const textState = !t.enabled ? "Disabled (set GEMINI_TEXT_ENABLED=true on the server)" : !t.keyPresent ? "Enabled, but GEMINI_API_KEY is missing" : t.rateLimitedUntil ? "Rate-limited until " + new Date(t.rateLimitedUntil).toLocaleTimeString() : "Ready";
    const imageState = !i.enabled ? "Disabled" : !i.keyPresent ? "Enabled, but GEMINI_API_KEY is missing" : "Enabled (each generation needs your confirmation)";
    const cost = i.estimatedCostUsdPerImage === null ? "not configured (set GEMINI_IMAGE_COST_USD_PER_IMAGE)" : "US$" + i.estimatedCostUsdPerImage + " per image";
    $("providers-body").innerHTML =
      '<p><strong>Text · ' + esc(t.label) + "</strong> " + badge(t) + '<br><span class="meta">Model: ' + esc(t.model) + " (" + esc(t.modelSource) + ") · " + esc(textState) + "</span><br>" +
      '<span class="meta">Today: ' + t.usageToday.requests + "/" + t.dailyLimit + " requests · " + t.usageToday.errors + " errors · " + t.usageToday.inputTokens + " in / " + t.usageToday.outputTokens + " out tokens</span><br>" +
      '<span class="agent-note">' + esc(t.costNote) + "</span></p>" +
      '<p><strong>Image · ' + esc(i.label) + "</strong> " + badge(i) + '<br><span class="meta">Model: ' + esc(i.model) + " · " + esc(imageState) + "</span><br>" +
      '<span class="meta">Today: ' + i.usageToday.attempts + "/" + i.dailyLimit + " attempts · estimated cost " + esc(cost) + "</span><br>" +
      '<span class="agent-note">' + esc(i.costNote) + "</span></p>" +
      storageHtml(data.storage) +
      '<p class="agent-note">' + esc(data.policy) + "</p>";
    $("providers-test").disabled = !t.configured;
    $("providers-models").disabled = !t.keyPresent;
  }
  async function refresh() {
    try { render(await request("/api/providers")); } catch (error) { $("providers-body").textContent = error.message; }
  }
  $("providers-test").addEventListener("click", async () => {
    const button = $("providers-test"); button.disabled = true; $("providers-message").textContent = "Testing the text provider…";
    try { const r = await request("/api/providers/text/test", {}); $("providers-message").textContent = "Works. " + r.model + " replied: " + r.text; }
    catch (error) { $("providers-message").textContent = error.message; }
    finally { await refresh(); }
  });
  $("providers-models").addEventListener("click", async () => {
    $("providers-message").textContent = "Loading models available to your key…";
    try {
      const r = await request("/api/providers/text/models");
      $("providers-model-select").innerHTML = r.models.map(m => '<option value="' + esc(m.id) + '"' + (m.id === r.current ? " selected" : "") + ">" + esc(m.displayName) + " (" + esc(m.id) + ")</option>").join("");
      $("providers-model-row").hidden = false;
      $("providers-message").textContent = r.models.length + " text models found. Check Google's pricing page before choosing: only some models have a free tier.";
    } catch (error) { $("providers-message").textContent = error.message; }
  });
  $("providers-model-save").addEventListener("click", async () => {
    try { const r = await request("/api/providers/text/model", { model: $("providers-model-select").value }); $("providers-message").textContent = "Text model set to " + r.model + "."; await refresh(); }
    catch (error) { $("providers-message").textContent = error.message; }
  });
  refresh();
})();
