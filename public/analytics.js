(function () {
  const root = document.getElementById("analytics");
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
  const LABEL = { recommendation: "RECOMMENDATION", observation: "OBSERVATION", insufficient_data: "NOT ENOUGH DATA" };
  function card(i) {
    return '<div class="post"><span class="board-status">' + esc(LABEL[i.status] || i.status) + "</span> <strong>" + esc(i.kind.replace(/[:_]/g, " ")) + "</strong><br>" +
      esc(i.observation) + '<br><span class="meta">Sample: ' + esc(i.sample_size) + " posts/snapshots · confidence: " + esc(i.confidence) + " · window: " + esc(i.window_label) + "</span>" +
      (i.suggested_action ? '<br><span class="agent-note">Suggested: ' + esc(i.suggested_action) + "</span>" : "") + "</div>";
  }
  async function load() {
    try {
      const data = await request("/api/analytics/report");
      const cov = data.coverage.length ? data.coverage.map(c => esc(c.checkpoint) + ": " + c.posts + " posts").join(" · ") : "no insights collected yet";
      const order = data.insights;
      $("analytics-body").innerHTML = '<p class="meta">Measured posts by checkpoint: ' + cov + "</p>" +
        (order.length ? order.map(card).join("") : '<p class="status">No analysis yet. It runs daily once the monitor has collected data.</p>');
    } catch (error) { $("analytics-body").innerHTML = '<span class="connection-error">' + esc(error.message) + "</span>"; }
  }
  $("analytics-refresh").addEventListener("click", async () => {
    $("analytics-message").textContent = "Requesting recompute…";
    try { const r = await request("/api/analytics/run", {}); $("analytics-message").textContent = r.note; await load(); } catch (e) { $("analytics-message").textContent = e.message; }
  });
  load();
  setInterval(load, 120000);
})();
