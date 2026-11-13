(function () {
  const root = document.getElementById("strategy");
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
  const CLASS = { account_analytics: "YOUR ANALYTICS", ai_hypothesis: "AI IDEA (UNVERIFIED)", external_research: "EXTERNAL RESEARCH", verified_fact: "VERIFIED" };
  const day = value => String(value).slice(0, 10);
  const opportunity = o => '<div class="post"><span class="board-status">' + esc(CLASS[o.source_class] || o.source_class) + "</span> <strong>" + esc(o.title) + "</strong> <span class=\"meta\">" + esc(o.status) + "</span><br>" + esc(o.summary) +
    '<br><span class="meta">confidence: ' + esc(o.confidence) + " · researched " + esc(day(o.researched_at)) + (o.source_urls.length ? " · sources: " + o.source_urls.map(esc).join(", ") : " · no external source") + "</span>" +
    (o.status === "new" || o.status === "accepted" ? '<div class="agent-actions"><button class="secondary" data-opp="' + esc(o.opportunity_id) + '" data-act="accept" type="button">Accept</button><button class="secondary" data-opp="' + esc(o.opportunity_id) + '" data-act="reject" type="button">Reject</button></div>' : "") + "</div>";
  const planItem = p => '<div class="post"><strong>' + esc(day(p.plan_date)) + " · " + esc(p.format) + " · " + esc(p.pillar) + "</strong> <span class=\"meta\">" + esc(p.status) + "</span><br>" +
    '<input data-topic="' + esc(p.item_id) + '" maxlength="300" value="' + esc(p.topic) + '"' + (p.status === "converted" || p.status === "rejected" ? " disabled" : "") + "><br>" + esc(p.rationale) +
    '<br><span class="meta">basis: ' + esc(CLASS[p.evidence_class] || p.evidence_class) + " · confidence: " + esc(p.confidence) + "</span>" +
    (p.status === "converted" ? '<br><span class="agent-note">On the Content Board. Needs media and your approval.</span>' : p.status === "rejected" ? "" :
      '<div class="agent-actions"><button class="secondary" data-save="' + esc(p.item_id) + '" type="button">Save edit</button><button class="secondary" data-board="' + esc(p.item_id) + '" type="button">Send to Content Board</button><button class="secondary" data-draft="' + esc(p.item_id) + '" type="button">Draft caption &amp; prompt</button><button class="secondary" data-rej="' + esc(p.item_id) + '" type="button">Reject</button></div>') + "</div>";
  const pkgCard = k => '<div class="post"><span class="board-status">' + esc(k.status.toUpperCase()) + "</span> <strong>Draft v" + esc(k.version) + "</strong> <span class=\"meta\">" + (k.source === "gemini" ? "written by Gemini (" + esc(k.model) + ")" : "plain template, no AI") + "</span><br>" + esc(k.caption) + "<br>" + esc(k.hashtags.join(" ")) +
    '<br><span class="meta">Media prompt: ' + esc(k.media_prompt) + "</span>" + (k.validation.problems?.length ? '<br><span class="connection-error">' + k.validation.problems.map(esc).join(" ") + "</span>" : "") + (k.validation.warnings?.length ? '<br><span class="agent-note">' + k.validation.warnings.map(esc).join(" ") + "</span>" : "") +
    (["draft", "needs_fixes"].includes(k.status) ? '<div class="agent-actions"><button class="secondary" data-apply="' + esc(k.package_id) + '" type="button">Apply to Content Board card</button><button class="secondary" data-pkgrej="' + esc(k.package_id) + '" type="button">Reject</button></div>' : "") + "</div>";
  async function load() {
    try {
      const d = await request("/api/strategy/overview");
      const pk = await request("/api/creative/packages");
      const s = d.settings;
      if (!$("strategy-niche").value) { $("strategy-niche").value = s.niche; $("strategy-audience").value = s.audience; $("strategy-objective").value = s.objective; $("strategy-pillars").value = s.pillars.join(", "); $("strategy-posts").value = s.postsPerWeek; }
      $("strategy-body").innerHTML = "<h3>Opportunities</h3>" + (d.opportunities.length ? d.opportunities.map(opportunity).join("") : '<p class="status">None yet. Research runs weekly or on request. External web research is not configured, so only your analytics and labelled AI ideas appear.</p>') +
        "<h3>Proposed 7-day plan</h3>" + (d.plan.length ? d.plan.map(planItem).join("") : '<p class="status">No plan yet. Fewer items are proposed when evidence is thin.</p>') +
        (pk.packages.length ? "<h3>Creative drafts (text only, no image is generated automatically)</h3>" + pk.packages.map(pkgCard).join("") : "");
    } catch (error) { $("strategy-body").innerHTML = '<span class="connection-error">' + esc(error.message) + "</span>"; }
  }
  const say = text => { $("strategy-message").textContent = text; };
  const act = async (fn) => { try { await fn(); await load(); } catch (e) { say(e.message); } };
  $("strategy-save").addEventListener("click", () => act(async () => {
    await request("/api/strategy/settings", { niche: $("strategy-niche").value, audience: $("strategy-audience").value, objective: $("strategy-objective").value,
      pillars: $("strategy-pillars").value.split(",").map(v => v.trim()).filter(Boolean), postsPerWeek: Number($("strategy-posts").value) });
    say("Strategy settings saved.");
  }));
  $("strategy-research").addEventListener("click", () => act(async () => say((await request("/api/strategy/research", {})).note)));
  $("strategy-plan").addEventListener("click", () => act(async () => say((await request("/api/strategy/plan", {})).note)));
  $("strategy-body").addEventListener("click", event => {
    const b = event.target.closest("button"); if (!b) return;
    if (b.dataset.opp) act(() => request("/api/strategy/opportunities/" + b.dataset.opp + "/" + b.dataset.act, {}));
    if (b.dataset.save) act(async () => { await request("/api/strategy/plan/" + b.dataset.save, { topic: root.querySelector('[data-topic="' + b.dataset.save + '"]').value }); say("Edit saved."); });
    if (b.dataset.rej) act(() => request("/api/strategy/plan/" + b.dataset.rej, { reject: true }));
    if (b.dataset.draft) act(async () => say((await request("/api/creative/plan/" + b.dataset.draft + "/draft", {})).note));
    if (b.dataset.apply) act(async () => say((await request("/api/creative/packages/" + b.dataset.apply + "/apply", {})).note));
    if (b.dataset.pkgrej) act(() => request("/api/creative/packages/" + b.dataset.pkgrej + "/reject", {}));
    if (b.dataset.board) act(async () => say((await request("/api/strategy/plan/" + b.dataset.board + "/to-board", {})).note + " Reload the Content Board to see it."));
  });
  load();
})();
