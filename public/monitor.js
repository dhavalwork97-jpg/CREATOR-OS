(function () {
  const root = document.getElementById("monitor");
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
  const num = value => (value === null || value === undefined ? "not available" : Number(value).toLocaleString());
  const when = value => (value ? new Date(value).toLocaleString() : "never");
  const METRICS = ["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "saves", "shares"];

  function health(data) {
    const a = data.account || {};
    const token = a.token_status === "valid" ? "Valid" : a.token_status === "invalid" ? "INVALID. Reconnect the Instagram token" : "Not checked yet";
    const latest = data.profile[data.profile.length - 1];
    const prev = data.profile.length > 1 ? data.profile[data.profile.length - 2] : null;
    const delta = latest && prev && latest.followers !== null && prev.followers !== null ? latest.followers - prev.followers : null;
    return '<p><strong>' + esc(a.username ? "@" + a.username : "Account " + a.ig_user_id) + "</strong> · connection: " + esc(a.connection_status) +
      " · token: " + esc(token) + '<br><span class="meta">Last health check: ' + esc(when(a.token_checked_at)) + "</span>" +
      (a.last_error ? '<br><span class="connection-error">' + esc(a.last_error) + "</span>" : "") + "</p>" +
      '<p>Followers: <strong>' + esc(num(latest?.followers)) + "</strong>" + (delta === null ? "" : " (" + (delta >= 0 ? "+" : "") + delta + " since previous check)") +
      " · Following: " + esc(num(latest?.following)) + " · Media: " + esc(num(latest?.media_count)) +
      '<br><span class="meta">' + (latest ? "Snapshot " + esc(when(latest.collected_at)) + " · " + data.profile.length + " stored snapshot(s)" : "No snapshot collected yet. The worker collects the first one on its next run.") + "</span></p>";
  }
  function insights(data) {
    const i = data.insights;
    if (!i) return '<p class="status">No account insights collected yet.</p>';
    const rows = METRICS.map(name => {
      const reason = i.unavailable?.[name];
      const value = i.metrics?.[name];
      return "<tr><td>" + esc(name.replace(/_/g, " ")) + "</td><td>" + (value === undefined ? '<span class="meta">not available' + (reason?.code ? " (" + esc(reason.code.replace(/_/g, " ")) + ")" : "") + "</span>" : esc(num(value))) + "</td></tr>";
    }).join("");
    return '<p class="meta">Daily totals for ' + esc(when(i.window_start)) + " to " + esc(when(i.window_end)) + ". Collected " + esc(when(i.collected_at)) + '. Values come from Meta; missing values were not returned by Meta.</p><table style="width:100%;font-size:13px">' + rows + "</table>";
  }
  function media(data) {
    if (!data.media.length) return '<p class="status">No media synchronised yet.</p>';
    return data.media.map(m => {
      const metrics = m.metrics ? Object.entries(m.metrics).map(([k, v]) => esc(k.replace(/_/g, " ")) + " " + esc(num(v))).join(" · ") : "";
      const missing = m.unavailable ? Object.keys(m.unavailable).length : 0;
      return '<div class="post"><strong>' + esc((m.caption || "(no caption)").slice(0, 80)) + '</strong> <span class="board-status">' + esc(m.product_type || m.media_type || "") + "</span><br>" +
        '<span class="meta">' + esc(when(m.posted_at)) + (m.permalink ? ' · <a href="' + esc(m.permalink) + '" target="_blank" rel="noopener noreferrer">open</a>' : "") + "</span><br>" +
        (m.metrics ? '<span class="meta">Insights (' + esc(m.checkpoint) + ", age " + esc(Math.round(m.age_hours)) + " h): " + (metrics || "none returned") + (missing ? " · " + missing + " metric(s) unavailable" : "") + "</span>"
          : '<span class="meta">Insights not collected yet. Likes ' + esc(num(m.like_count)) + " · comments " + esc(num(m.comments_count)) + "</span>") + "</div>";
    }).join("");
  }
  function jobs(data) {
    if (!data.tasks.length) return '<p class="status">No monitoring tasks have run yet.</p>';
    return data.tasks.map(t => '<div class="audit">' + esc(t.task_type.replace(/_/g, " ")) + ": <strong>" + esc(t.status) + "</strong>" +
      (t.error?.message ? ' <span class="connection-error">' + esc(t.error.message) + "</span>" : "") + '<br><span class="meta">' + (t.completed_at ? "finished " + esc(when(t.completed_at)) : "next run " + esc(when(t.run_after))) + "</span></div>").join("");
  }
  async function load() {
    try {
      const data = await request("/api/monitor/overview");
      $("monitor-body").innerHTML = health(data) + "<h3>Account insights</h3>" + insights(data) + "<h3>Recent posts</h3>" + media(data) + "<h3>Monitoring jobs</h3>" + jobs(data);
      $("monitor-interval").value = String(data.settings.accountHealthMinutes);
      $("monitor-enabled").checked = data.settings.enabled !== false;
    } catch (error) { $("monitor-body").innerHTML = '<span class="connection-error">' + esc(error.message) + "</span>"; }
  }
  $("monitor-refresh").addEventListener("click", async () => {
    $("monitor-message").textContent = "Requesting refresh…";
    try { const r = await request("/api/monitor/run", {}); $("monitor-message").textContent = r.note; await load(); } catch (e) { $("monitor-message").textContent = e.message; }
  });
  $("monitor-save").addEventListener("click", async () => {
    try {
      const minutes = Number($("monitor-interval").value);
      await request("/api/monitor/settings", { enabled: $("monitor-enabled").checked, accountHealthMinutes: minutes, mediaSyncMinutes: Math.max(60, minutes) });
      $("monitor-message").textContent = "Monitoring settings saved."; await load();
    } catch (e) { $("monitor-message").textContent = e.message; }
  });
  load();
  setInterval(load, 60000);
})();
