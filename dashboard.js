(() => {
  const SESSIONS_KEY = "cgpt_sessions_v1";
  const ACTIVE_KEY = "cgpt_active_session_v1";

  const elKpis = document.getElementById("kpis");
  const elKeywords = document.getElementById("keywords");
  const elBestSession = document.getElementById("bestSession");
  const elTable = document.getElementById("sessionsTable").querySelector("tbody");
  const elEmpty = document.getElementById("emptyNote");

  const liveCard = document.getElementById("liveCard");
  const liveKpis = document.getElementById("liveKpis");
  const liveMeta = document.getElementById("liveMeta");
  const liveSummary = document.getElementById("liveSummary");

  const minutesCanvas = document.getElementById("minutesChart");
  const depthCanvas = document.getElementById("depthChart");
  const depthPromptCanvas = document.getElementById("depthPromptChart");

  const exportBtn = document.getElementById("exportBtn");
  const clearBtn = document.getElementById("clearBtn");

  const modal = document.getElementById("modal");
  const modalClose = document.getElementById("modalClose");
  const modalBody = document.getElementById("modalBody");

  function openModal(text) {
    modalBody.textContent = text || "-";
    modal.style.display = "flex";
  }

  function closeModal() {
    modal.style.display = "none";
  }

  modalClose.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  function getSessions() {
    return new Promise((resolve) => {
      chrome.storage.local.get([SESSIONS_KEY], (res) => {
        resolve(Array.isArray(res[SESSIONS_KEY]) ? res[SESSIONS_KEY] : []);
      });
    });
  }

  function getActiveSession() {
    return new Promise((resolve) => {
      chrome.storage.local.get([ACTIVE_KEY], (res) => resolve(res[ACTIVE_KEY] || null));
    });
  }

  function setSessions(arr) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [SESSIONS_KEY]: arr }, resolve);
    });
  }

  function setActiveSession(val) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [ACTIVE_KEY]: val }, resolve);
    });
  }

  function toDayKey(iso) {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function fmtLocal(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function sum(arr) {
    return arr.reduce((a, b) => a + b, 0);
  }

  function avg(arr) {
    if (!arr.length) return 0;
    return sum(arr) / arr.length;
  }

  function lastNDaysKeys(n) {
    const out = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      out.push(toDayKey(d.toISOString()));
    }
    return out;
  }

  function aggregateDaily(sessions) {
    const byDay = {};
    for (const s of sessions) {
      const day = toDayKey(s.start_time);
      byDay[day] ??= { minutes: 0, prompts: 0, depthSum: 0, n: 0 };
      byDay[day].minutes += Number(s.duration_min ?? 0);
      byDay[day].prompts += Number(s.prompt_count ?? 0);
      byDay[day].depthSum += Number(s.depth_score ?? 0);
      byDay[day].n += 1;
    }

    const keys14 = lastNDaysKeys(14);
    const daily14 = keys14.map((day) => {
      const v = byDay[day] ?? { minutes: 0, prompts: 0, depthSum: 0, n: 0 };
      return { day, minutes: v.minutes, prompts: v.prompts, avgDepth: v.n ? v.depthSum / v.n : 0, sessions: v.n };
    });

    const keys7 = lastNDaysKeys(7);
    const daily7 = keys7.map((day) => {
      const v = byDay[day] ?? { minutes: 0, prompts: 0, depthSum: 0, n: 0 };
      return { day, minutes: v.minutes, prompts: v.prompts, avgDepth: v.n ? v.depthSum / v.n : 0, sessions: v.n };
    });

    return { daily14, daily7, keys7 };
  }

  function aggregateKeywords(sessions) {
    const freq = {};
    for (const s of sessions) {
      const kf = s.keyword_freq || {};
      for (const [k, v] of Object.entries(kf)) {
        freq[k] = (freq[k] || 0) + Number(v || 0);
      }
    }
    const entries = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    return entries.slice(0, 20);
  }

  function sessionsInLast7Days(sessions, keys7) {
    const set = new Set(keys7);
    return sessions.filter((s) => set.has(toDayKey(s.start_time)));
  }

  function renderKpis(daily7, sessions7) {
    const totalMinutes = sum(daily7.map((d) => d.minutes));
    const totalPrompts = sum(daily7.map((d) => d.prompts));
    const totalSessions = sum(daily7.map((d) => d.sessions));
    const avgDepth7 = avg(daily7.filter((d) => d.sessions > 0).map((d) => d.avgDepth));
    const totalRefine = sum(sessions7.map((s) => Number(s.refinement_loops ?? 0)));
    const refinementEfficiency = totalPrompts > 0 ? totalRefine / totalPrompts : 0;

    const kpis = [
      { label: "Total Minutes", value: `${totalMinutes}` },
      { label: "Avg Depth", value: `${avgDepth7.toFixed(1)}` },
      { label: "Sessions", value: `${totalSessions}` },
      { label: "Prompts", value: `${totalPrompts}` },
      { label: "Refine / Prompt", value: `${refinementEfficiency.toFixed(2)}` },
      { label: "Active Days", value: `${daily7.filter((d) => d.sessions > 0).length}` }
    ];

    elKpis.innerHTML = "";
    for (const k of kpis) {
      const div = document.createElement("div");
      div.className = "kpi";
      div.innerHTML = `<div class="label">${k.label}</div><div class="value">${k.value}</div>`;
      elKpis.appendChild(div);
    }
  }

  function renderBestSession(sessions7) {
    if (!sessions7.length) {
      elBestSession.textContent = "No sessions in the last 7 days.";
      return;
    }

    const best = sessions7
      .slice()
      .sort((a, b) => Number(b.depth_score ?? 0) - Number(a.depth_score ?? 0))[0];

    const parts = [
      `Start: ${fmtLocal(best.start_time)}`,
      `Depth: ${Number(best.depth_score ?? 0).toFixed(1)}`,
      `Prompts: ${Number(best.prompt_count ?? 0)}`,
      `Minutes: ${Number(best.duration_min ?? 0)}`
    ];

    const summary = (best.summary_one_liner || best.summary || "").trim();
    elBestSession.innerHTML = `${parts.join(" | ")}${summary ? `<br /><br />${summary}` : ""}`;
  }

  function renderLive(active) {
    if (!active) {
      liveCard.style.display = "none";
      return;
    }

    liveCard.style.display = "block";

    const kpis = [
      { label: "Elapsed (min)", value: `${Number(active.duration_min_est ?? 0)}` },
      { label: "Prompts", value: `${Number(active.prompt_count ?? 0)}` },
      { label: "Avg Chars", value: `${Number(active.avg_prompt_chars_est ?? 0)}` },
      { label: "Depth (est)", value: `${Number(active.depth_score_est ?? 0).toFixed(1)}` },
      { label: "Session XP", value: `+${Number(active.session_xp ?? 0)}` }
    ];

    liveKpis.innerHTML = "";
    for (const k of kpis) {
      const div = document.createElement("div");
      div.className = "kpi";
      div.innerHTML = `<div class="label">${k.label}</div><div class="value">${k.value}</div>`;
      liveKpis.appendChild(div);
    }

    const kw =
      Array.isArray(active.topic_keywords_est) && active.topic_keywords_est.length
        ? active.topic_keywords_est.join(", ")
        : "-";

    liveMeta.textContent = `Started: ${fmtLocal(active.start_time)} | Keywords: ${kw}`;
    liveSummary.textContent = active.summary_est || "-";
  }

  function renderKeywords(entries) {
    elKeywords.innerHTML = "";
    if (!entries.length) {
      elKeywords.innerHTML = `<div class="muted">No keywords yet.</div>`;
      return;
    }
    for (const [k, v] of entries) {
      const pill = document.createElement("div");
      pill.className = "pill";
      pill.textContent = `${k} | ${v}`;
      elKeywords.appendChild(pill);
    }
  }

  function shortSummary(s) {
    const t = (s || "").trim();
    if (!t) return "-";
    return t.length <= 80 ? t : `${t.slice(0, 79)}...`;
  }

  function renderTable(sessions) {
    elTable.innerHTML = "";
    const recent = sessions.slice(0, 25);

    if (!recent.length) {
      elEmpty.style.display = "block";
      return;
    }
    elEmpty.style.display = "none";

    for (const s of recent) {
      const tr = document.createElement("tr");
      const keywords = Array.isArray(s.topic_keywords) ? s.topic_keywords.join(", ") : "-";
      const summary = s.summary || s.summary_one_liner || "-";

      tr.innerHTML = `
        <td>${fmtLocal(s.start_time)}</td>
        <td>${Number(s.duration_min ?? 0)}</td>
        <td>${Number(s.prompt_count ?? 0)}</td>
        <td>${Number(s.avg_prompt_chars ?? 0)}</td>
        <td>${Number(s.refinement_loops ?? 0)}</td>
        <td>${Number(s.structured_prompts ?? 0)}</td>
        <td>${Number(s.code_prompts ?? 0)}</td>
        <td>${Number(s.depth_score ?? 0).toFixed(1)}</td>
        <td style="max-width:220px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${keywords}</td>
        <td class="summaryCell" title="Click to view full summary">${shortSummary(summary)}</td>
      `;

      tr.querySelector(".summaryCell").addEventListener("click", () => openModal(summary));
      elTable.appendChild(tr);
    }
  }

  function drawBarChart(canvas, labels, values) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const padL = 34;
    const padR = 12;
    const padT = 14;
    const padB = 28;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;
    const maxV = Math.max(1, ...values);

    for (let i = 0; i <= 4; i++) {
      const y = padT + (chartH * i) / 4;
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
    }

    const n = values.length;
    const gap = 6;
    const barW = Math.max(3, (chartW - gap * (n - 1)) / n);

    for (let i = 0; i < n; i++) {
      const v = values[i];
      const h = (v / maxV) * chartH;
      const x = padL + i * (barW + gap);
      const y = padT + (chartH - h);

      ctx.fillStyle = "rgba(255,255,255,0.80)";
      ctx.fillRect(x, y, barW, h);

      if (i % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = "10px ui-sans-serif, system-ui";
        ctx.fillText(labels[i].slice(5), x, H - 10);
      }
    }
  }

  function drawLineChart(canvas, labels, values, color = "rgba(255,255,255,0.85)", minY = 0, maxY = 10) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const padL = 34;
    const padR = 12;
    const padT = 14;
    const padB = 28;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;

    for (let i = 0; i <= 4; i++) {
      const y = padT + (chartH * i) / 4;
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(W - padR, y);
      ctx.stroke();
    }

    const n = values.length;
    const stepX = n <= 1 ? 0 : chartW / (n - 1);

    const toY = (v) => {
      const t = (v - minY) / (maxY - minY);
      return padT + (1 - Math.max(0, Math.min(1, t))) * chartH;
    };

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = padL + stepX * i;
      const y = toY(values[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const x = padL + stepX * i;
      const y = toY(values[i]);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();

      if (i % 2 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = "10px ui-sans-serif, system-ui";
        ctx.fillText(labels[i].slice(5), x - 6, H - 10);
        ctx.fillStyle = color;
      }
    }
  }

  function drawDepthVsPromptChart(canvas, labels, depthValues, promptValues) {
    const maxPrompt = Math.max(1, ...promptValues);
    const normalizedPrompts = promptValues.map((v) => (v / maxPrompt) * 10);

    drawLineChart(canvas, labels, depthValues, "rgba(255,255,255,0.90)", 0, 10);

    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    const padL = 34;
    const padR = 12;
    const padT = 14;
    const padB = 28;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;
    const n = normalizedPrompts.length;
    const stepX = n <= 1 ? 0 : chartW / (n - 1);
    const toY = (v) => padT + (1 - Math.max(0, Math.min(1, v / 10))) * chartH;

    ctx.strokeStyle = "rgba(96,165,250,0.90)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = padL + stepX * i;
      const y = toY(normalizedPrompts[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  async function renderAll() {
    const [sessions, active] = await Promise.all([getSessions(), getActiveSession()]);

    renderLive(active);

    const { daily14, daily7, keys7 } = aggregateDaily(sessions);
    const sessions7 = sessionsInLast7Days(sessions, keys7);

    renderKpis(daily7, sessions7);
    renderBestSession(sessions7);

    const labels14 = daily14.map((d) => d.day);
    drawBarChart(minutesCanvas, labels14, daily14.map((d) => d.minutes));
    drawLineChart(depthCanvas, labels14, daily14.map((d) => d.avgDepth), "rgba(255,255,255,0.85)", 0, 10);
    drawDepthVsPromptChart(depthPromptCanvas, labels14, daily14.map((d) => d.avgDepth), daily14.map((d) => d.prompts));

    renderTable(sessions);
    renderKeywords(aggregateKeywords(sessions));
  }

  exportBtn.addEventListener("click", async () => {
    const sessions = await getSessions();
    const data = JSON.stringify(sessions, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "prompt-progress-sessions.json";
    a.click();

    URL.revokeObjectURL(url);
  });

  clearBtn.addEventListener("click", async () => {
    const ok = confirm("Clear all local session history AND the current live session? This cannot be undone.");
    if (!ok) return;
    await setSessions([]);
    await setActiveSession(null);
    await renderAll();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[SESSIONS_KEY] || changes[ACTIVE_KEY]) renderAll().catch(() => {});
  });

  renderAll().catch(() => {});
})();
