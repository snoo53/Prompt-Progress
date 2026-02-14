(() => {
  // ============================================================
  // Prompt Progress ??Phase 1 + Phase 2 + Phase 2.5
  // - Live session snapshot (cgpt_active_session_v1)
  // - Final sessions history (cgpt_sessions_v1)
  // - Local transcript capture (user prompts, capped)
  // - Heuristic session summary: generateSessionSummary(session)
  //   (swap later to real AI in Phase 3 via same interface)
  // ============================================================

  // Zombie-script guard
  try {
    if (!chrome?.runtime?.id) return;
  } catch (_) {
    return;
  }

  // -----------------------------
  // CONFIG
  // -----------------------------
  const STORAGE_KEY_XP = "cgpt_xp_state_v1";
  const STORAGE_KEY_SESSIONS = "cgpt_sessions_v1";
  const STORAGE_KEY_ACTIVE = "cgpt_active_session_v1";

  const INC_MIN = 3;
  const INC_MAX = 5;

  const MIN_LEVEL = 1;
  const MAX_LEVEL = 100;

  const COOLDOWN_MS = 700;

  const SESSION_INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes
  const PROMPT_CAPTURE_WINDOW_MS = 3500;

  // Transcript capture
  const TRANSCRIPT_MAX_TURNS = 20; // store last 20 user prompts for session summary

  const NORM = {
    avgCharsMin: 80,
    avgCharsMax: 1200,
    durationMinMin: 3,
    durationMaxMin: 60,
    turnDepthMin: 1,
    turnDepthMax: 12,
    refineMin: 0,
    refineMax: 8,
    codeMin: 0,
    codeMax: 4
  };

  const STOPWORDS = new Set([
    "a","an","the","and","or","but","if","then","else","so","to","of","in","on","for","with","at","by","from",
    "is","are","was","were","be","been","being","it","this","that","these","those","i","you","we","they","he",
    "she","my","your","our","their","me","him","her","them","as","not","do","does","did","can","could","would",
    "should","will","just","about","into","over","under","than","also","very","more","most","some","any"
  ]);

  // Helps reduce meaningless keyword noise (optional but recommended)
  const FILLER_WORDS = new Set([
    "ok","okay","k","yeah","yep","nope","sure","thanks","thank","thx","pls","please",
    "hi","hello","hey","bye","good","great","nice",
    "got","get","getting","works","worked","working","done",
    "now","then","also","still","really","maybe",
    "tell","show","make","help","need","want","think","feel",
    "thing","things","stuff","something","anything","everything",
  ]);

  const REFINEMENT_REGEX =
    /\b(refine|improve|expand|rewrite|clarify|optimize|fix|revise|edit|again|better|polish|tighten)\b/gi;

  // -----------------------------
  // HELPERS
  // -----------------------------
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

  function xpNeededForNextLevel(level) {
    return Math.round(20 + 5 * level + 0.05 * level * level);
  }

  function computeProgressPercent(level, xpIntoLevel) {
    if (level >= MAX_LEVEL) return 100;
    const need = xpNeededForNextLevel(level);
    return clamp((xpIntoLevel / need) * 100, 0, 100);
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function safeNumber(n, fallback = 0) {
    const x = Number(n);
    return Number.isFinite(x) ? x : fallback;
  }

  function normalizeLinear(x, min, max) {
    if (max <= min) return 0;
    return clamp((x - min) / (max - min), 0, 1);
  }

  function uuid() {
    return "sess_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
  }

  function clip(s, n = 240) {
    const t = (s || "").trim();
    if (t.length <= n) return t;
    return t.slice(0, n - 1) + "...";
  }

  // -----------------------------
  // UI (Widget + Overlay)
  // -----------------------------
  let ui = null;
  let barFill = null;
  let levelLabel = null;
  let xpLabel = null;
  let sessionOverlay = null;

  function createUI() {
    if (ui) return;

    ui = document.createElement("div");
    ui.id = "cgpt-xp-widget";
    ui.style.cssText = `
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      width: 260px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      background: rgba(20,20,20,0.92);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 14px;
      padding: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      user-select: none;
    `;

    const title = document.createElement("div");
    title.textContent = "Prompt Progress";
    title.style.cssText = `font-size: 13px; font-weight: 800; margin-bottom: 8px;`;

    const topRow = document.createElement("div");
    topRow.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 8px;
    `;

    levelLabel = document.createElement("div");
    levelLabel.textContent = "Level 1";
    levelLabel.style.cssText = `font-size: 12px; font-weight: 800;`;

    xpLabel = document.createElement("div");
    xpLabel.textContent = "0 / 0 XP";
    xpLabel.style.cssText = `font-size: 11px; opacity: 0.8;`;

    topRow.appendChild(levelLabel);
    topRow.appendChild(xpLabel);

    const barOuter = document.createElement("div");
    barOuter.style.cssText = `
      width: 100%;
      height: 10px;
      background: rgba(255,255,255,0.14);
      border-radius: 999px;
      overflow: hidden;
    `;

    barFill = document.createElement("div");
    barFill.style.cssText = `
      height: 100%;
      width: 0%;
      background: rgba(255,255,255,0.85);
      border-radius: 999px;
      transition: width 180ms ease;
    `;
    barOuter.appendChild(barFill);

    const bottomRow = document.createElement("div");
    bottomRow.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 10px;
      gap: 10px;
    `;

    const hint = document.createElement("div");
    hint.textContent = "Send -> +XP";
    hint.style.cssText = `font-size: 11px; opacity: 0.6;`;

    const btnGroup = document.createElement("div");
    btnGroup.style.cssText = `display:flex; gap:8px;`;

    const dashBtn = document.createElement("button");
    dashBtn.type = "button";
    dashBtn.textContent = "Dashboard";
    dashBtn.style.cssText = `
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.10);
      color: #fff;
      cursor: pointer;
    `;
    // Robust: open dashboard through background SW (you already implemented B)
    dashBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
      } catch (err) {
        console.warn("[Prompt Progress] Dashboard open failed. Refresh the page.", err);
      }
    });

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.textContent = "Reset";
    resetBtn.style.cssText = `
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.10);
      color: #fff;
      cursor: pointer;
    `;
    resetBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await setXpState({ level: 1, xpIntoLevel: 0, totalXp: 0 });
      await render();
    });

    btnGroup.appendChild(dashBtn);
    btnGroup.appendChild(resetBtn);

    bottomRow.appendChild(hint);
    bottomRow.appendChild(btnGroup);

    ui.appendChild(title);
    ui.appendChild(topRow);
    ui.appendChild(barOuter);
    ui.appendChild(bottomRow);

    document.documentElement.appendChild(ui);
  }

  function showXpPopup(amount) {
    if (!ui) return;
    const popup = document.createElement("div");
    popup.textContent = `+${amount} XP`;
    popup.style.cssText = `
      position: absolute;
      right: 16px;
      bottom: 70px;
      font-size: 14px;
      font-weight: 800;
      color: #93C5FD;
      opacity: 0;
      transform: translateY(0px);
      transition: all 600ms ease;
      pointer-events: none;
    `;
    ui.appendChild(popup);

    requestAnimationFrame(() => {
      popup.style.opacity = "1";
      popup.style.transform = "translateY(-30px)";
    });

    setTimeout(() => (popup.style.opacity = "0"), 500);
    setTimeout(() => popup.remove(), 700);
  }

  function showLevelUpAnimation(level) {
    if (!ui) return;
    const banner = document.createElement("div");
    banner.textContent = `LEVEL ${level}!`;
    banner.style.cssText = `
      position: absolute;
      right: 16px;
      bottom: 100px;
      font-size: 16px;
      font-weight: 900;
      color: gold;
      text-shadow: 0 0 10px gold;
      opacity: 0;
      transform: scale(0.8);
      transition: all 500ms ease;
      pointer-events: none;
    `;
    ui.appendChild(banner);

    requestAnimationFrame(() => {
      banner.style.opacity = "1";
      banner.style.transform = "scale(1.2)";
    });

    setTimeout(() => {
      banner.style.opacity = "0";
      banner.style.transform = "scale(0.9)";
    }, 900);

    setTimeout(() => banner.remove(), 1400);

    if (barFill) {
      barFill.style.boxShadow = "0 0 15px gold";
      setTimeout(() => (barFill.style.boxShadow = "none"), 1000);
    }
  }

  function renderSessionOverlay(summary) {
    if (sessionOverlay) {
      sessionOverlay.remove();
      sessionOverlay = null;
    }

    sessionOverlay = document.createElement("div");
    sessionOverlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.55);
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      width: 520px;
      max-width: calc(100vw - 32px);
      background: rgba(20,20,20,0.95);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      padding: 16px;
    `;

    const title = document.createElement("div");
    title.textContent = "Session Summary";
    title.style.cssText = `font-size: 16px; font-weight: 900; margin-bottom: 10px;`;

    const body = document.createElement("div");
    body.style.cssText = `font-size: 13px; line-height: 1.55; opacity: 0.95;`;

    const rows = [
      ["Duration", `${summary.durationMin} min`],
      ["Prompts", `${summary.promptCount}`],
      ["Avg Prompt Length", `${summary.avgPromptChars} chars`],
      ["Refinement Loops", `${summary.refinementLoops}`],
      ["Structured Prompts", `${summary.structuredPrompts}`],
      ["Code Prompts", `${summary.codePrompts}`],
      ["Topic Keywords", summary.topicKeywords.length ? summary.topicKeywords.join(", ") : "-"],
      ["Cognitive Depth Score", `${summary.depthScore.toFixed(1)} / 10`],
      ["XP Earned", `+${summary.sessionXp}`]
    ];

    const metaHtml = rows
      .map(
        ([k, v]) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
          <div style="opacity:0.75;">${k}</div>
          <div style="font-weight:700;">${v}</div>
        </div>`
      )
      .join("");

    const summaryBlock = `
      <div style="margin-top:12px;padding:10px;border:1px solid rgba(255,255,255,0.10);border-radius:12px;background:rgba(255,255,255,0.06);">
        <div style="font-weight:900;margin-bottom:6px;">Recap</div>
        <div style="white-space:pre-wrap;opacity:0.95;">${(summary.summaryText || "-").replace(/</g, "&lt;")}</div>
      </div>
    `;

    body.innerHTML = metaHtml + summaryBlock;

    const btnRow = document.createElement("div");
    btnRow.style.cssText = `display:flex;justify-content:flex-end;gap:10px;margin-top:12px;`;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.style.cssText = `
      font-size: 13px;
      padding: 8px 12px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(255,255,255,0.10);
      color: #fff;
      cursor: pointer;
    `;
    closeBtn.addEventListener("click", () => {
      if (sessionOverlay) {
        sessionOverlay.remove();
        sessionOverlay = null;
      }
    });

    btnRow.appendChild(closeBtn);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(btnRow);
    sessionOverlay.appendChild(card);

    sessionOverlay.addEventListener("click", (e) => {
      if (e.target === sessionOverlay) closeBtn.click();
    });

    document.documentElement.appendChild(sessionOverlay);
  }

  // -----------------------------
  // STORAGE: XP STATE
  // -----------------------------
  function getXpState() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY_XP], (res) => {
        const raw = res[STORAGE_KEY_XP];
        const state = {
          level: raw?.level ?? 1,
          xpIntoLevel: raw?.xpIntoLevel ?? 0,
          totalXp: raw?.totalXp ?? 0
        };
        state.level = clamp(Number(state.level) || 1, MIN_LEVEL, MAX_LEVEL);
        state.xpIntoLevel = Math.max(0, Number(state.xpIntoLevel) || 0);
        state.totalXp = Math.max(0, Number(state.totalXp) || 0);
        resolve(state);
      });
    });
  }

  function setXpState(state) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY_XP]: state }, resolve);
    });
  }

  // -----------------------------
  // STORAGE: SESSION HISTORY
  // -----------------------------
  function getSessionHistory() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY_SESSIONS], (res) => {
        const arr = res[STORAGE_KEY_SESSIONS];
        resolve(Array.isArray(arr) ? arr : []);
      });
    });
  }

  async function appendSessionHistory(sessionObj) {
    const hist = await getSessionHistory();
    hist.unshift(sessionObj);
    const trimmed = hist.slice(0, 100);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY_SESSIONS]: trimmed }, resolve);
    });
  }

  // -----------------------------
  // STORAGE: ACTIVE SESSION (LIVE)
  // -----------------------------
  function setActiveSessionState(stateOrNull) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY_ACTIVE]: stateOrNull }, resolve);
    });
  }


  // -----------------------------
  // RENDER XP WIDGET
  // -----------------------------
  async function render() {
    createUI();
    const state = await getXpState();

    const level = state.level;
    const need = level >= MAX_LEVEL ? 0 : xpNeededForNextLevel(level);
    const xpInto = level >= MAX_LEVEL ? need : state.xpIntoLevel;

    if (levelLabel) levelLabel.textContent = `Level ${level}`;
    if (xpLabel) xpLabel.textContent = level >= MAX_LEVEL ? `MAX` : `${xpInto} / ${need} XP`;

    const pct = computeProgressPercent(level, state.xpIntoLevel);
    if (barFill) barFill.style.width = `${pct}%`;
  }

  // -----------------------------
  // XP ENGINE
  // -----------------------------
  async function addXp(amount) {
    const state = await getXpState();
    if (state.level >= MAX_LEVEL) {
      await render();
      return;
    }

    state.totalXp += amount;
    state.xpIntoLevel += amount;

    while (state.level < MAX_LEVEL) {
      const need = xpNeededForNextLevel(state.level);
      if (state.xpIntoLevel < need) break;

      state.xpIntoLevel -= need;
      state.level += 1;
      showLevelUpAnimation(state.level);

      if (state.level >= MAX_LEVEL) {
        state.level = MAX_LEVEL;
        state.xpIntoLevel = 0;
        break;
      }
    }

    await setXpState(state);
    await render();
  }

  // -----------------------------
  // PROMPT CAPTURE (best effort)
  // -----------------------------
  let lastCapturedPrompt = "";
  let lastCapturedAt = 0;

  function getActivePromptElement() {
    const ta = document.querySelector("form textarea");
    if (ta) return ta;
    const ce = document.querySelector('form [contenteditable="true"]');
    if (ce) return ce;
    return null;
  }

  function readPromptText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA") return (el.value || "").trim();
    return (el.innerText || "").trim();
  }

  function capturePromptNow() {
    const el = getActivePromptElement();
    const text = readPromptText(el);
    if (!text) return;
    lastCapturedPrompt = text;
    lastCapturedAt = Date.now();
  }

  document.addEventListener(
    "keydown",
    (e) => {
      const active = document.activeElement;
      const inPrompt =
        active &&
        (active.closest?.("form") || active.closest?.('[contenteditable="true"]')?.closest?.("form"));
      if (!inPrompt) return;
      if (e.key !== "Enter") return;
      if (e.shiftKey) return;
      capturePromptNow();
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target?.closest?.("button");
      if (!btn) return;

      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      const testid = (btn.getAttribute("data-testid") || "").toLowerCase();
      const type = (btn.getAttribute("type") || "").toLowerCase();

      const looksLikeSend = aria.includes("send") || testid.includes("send") || type === "submit";
      if (!looksLikeSend) return;

      capturePromptNow();
    },
    true
  );

  // Fallback: DOM-confirmed last user bubble
  function getLastUserMessageText() {
    const nodes = document.querySelectorAll('[data-message-author-role="user"]');
    const last = nodes[nodes.length - 1];
    if (!last) return "";
    return (last.innerText || last.textContent || "").trim();
  }

  // -----------------------------
  // SESSION ENGINE
  // -----------------------------
  let activeSession = null;
  let inactivityTimer = null;

  function startSessionIfNeeded() {
    if (activeSession) return;

    activeSession = {
      session_id: uuid(),
      start_time: nowISO(),
      end_time: null,

      prompt_count: 0,
      total_prompt_chars: 0,
      total_prompt_words: 0,

      refinement_loops: 0,
      structured_prompts: 0,
      code_prompts: 0,

      max_turn_depth: 1,

      keyword_freq: {},

      // Phase 2.5 transcript
      transcript_user: [], // array of {t, text} (user-only)

      session_xp: 0
    };
  }

  function resetInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      endSession("inactivity").catch(() => {});
    }, SESSION_INACTIVITY_MS);
  }

  function isStructuredPrompt(text) {
    const hasBullets = /\n\s*[-*]\s+/.test(text);
    const hasNumbered = /\n\s*\d+\.\s+/.test(text);
    const hasHeaders = /\n\s{0,3}#{1,6}\s+/.test(text);
    const hasColonSections = /(^|\n)[A-Za-z][A-Za-z \t]{2,}:\s+/.test(text);
    return hasBullets || hasNumbered || hasHeaders || hasColonSections;
  }

  function isCodePrompt(text) {
    if (/```/.test(text)) return true;
    const tokens = ["import ", "from ", "class ", "function ", "const ", "let ", "var ", "def ", "return ", "{", "}", "=>"];
    let hits = 0;
    for (const t of tokens) if (text.includes(t)) hits++;
    return hits >= 2;
  }

  function countWords(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function updateKeywords(text) {
    const cleaned = text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) return;

    const words = cleaned.split(" ");
    for (const w of words) {
      if (!w) continue;
      if (w.length < 3) continue;
      if (STOPWORDS.has(w)) continue;
      if (FILLER_WORDS.has(w)) continue;

      activeSession.keyword_freq[w] = (activeSession.keyword_freq[w] || 0) + 1;
    }
  }

  function topKeywords(freqMap, k = 6) {
    const entries = Object.entries(freqMap || {})
      .filter(([, c]) => (c || 0) >= 2); // require at least 2 hits to be ?쐊eyword??
    entries.sort((a, b) => b[1] - a[1]);
    return entries.slice(0, k).map(([w]) => w);
  }

  function computeDepthScore(sessionObj, durationMin) {
    const promptCount = Math.max(1, sessionObj.prompt_count);
    const avgChars = sessionObj.total_prompt_chars / promptCount;

    const L = normalizeLinear(avgChars, NORM.avgCharsMin, NORM.avgCharsMax);
    const R = normalizeLinear(sessionObj.refinement_loops, NORM.refineMin, NORM.refineMax);
    const T = normalizeLinear(sessionObj.max_turn_depth, NORM.turnDepthMin, NORM.turnDepthMax);

    const S = clamp(sessionObj.structured_prompts / promptCount, 0, 1);
    const D = normalizeLinear(durationMin, NORM.durationMinMin, NORM.durationMaxMin);
    const C = normalizeLinear(sessionObj.code_prompts, NORM.codeMin, NORM.codeMax);

    const depth01 = 0.25 * L + 0.2 * R + 0.2 * T + 0.15 * S + 0.1 * D + 0.1 * C;
    return clamp(depth01 * 10, 0, 10);
  }

  function recordUserTurn(text) {
    const t = (text || "").trim();
    if (!t) return;
    activeSession.transcript_user.push({ t: nowISO(), text: clip(t, 600) });
    if (activeSession.transcript_user.length > TRANSCRIPT_MAX_TURNS) {
      activeSession.transcript_user.splice(0, activeSession.transcript_user.length - TRANSCRIPT_MAX_TURNS);
    }
  }

  function updateSessionWithPrompt(text) {
    if (!activeSession) return;
    const t = (text || "").trim();
    if (!t) return;

    activeSession.prompt_count += 1;
    activeSession.total_prompt_chars += t.length;
    activeSession.total_prompt_words += countWords(t);

    const refineHits = (t.match(REFINEMENT_REGEX) || []).length;
    activeSession.refinement_loops += refineHits;

    if (isStructuredPrompt(t)) activeSession.structured_prompts += 1;
    if (isCodePrompt(t)) activeSession.code_prompts += 1;

    updateKeywords(t);

    // Phase 2.5 transcript capture
    recordUserTurn(t);
  }

  function getTurnDepthEstimate() {
    const turns = document.querySelectorAll('article[data-testid="conversation-turn"]').length;
    if (turns) return turns;
    const user = document.querySelectorAll('[data-message-author-role="user"]').length;
    return user ? user * 2 : 1;
  }

  function estimateElapsedMinutes(sessionObj) {
    const start = new Date(sessionObj.start_time).getTime();
    const now = Date.now();
    return Math.max(1, Math.round((now - start) / 60000));
  }

  // -----------------------------
  // Phase 2.5 Summary Engine (heuristic)
  // -----------------------------
  function generateSessionSummary(sessionObj) {
    const turns = sessionObj.transcript_user || [];
    const last = turns.length ? turns[turns.length - 1].text : "";
    const fullText = turns.map((x) => x.text).join("\n");

    const kws = topKeywords(sessionObj.keyword_freq, 8);
    const kwText = kws.length ? kws.join(", ") : "";

    // Detect ?쐗hat happened??
    const hadError = /\b(error|failed|fail|blocked|invalid|bug|issue|problem)\b/i.test(fullText);
    const resolved = /\b(fixed|works now|now it works|resolved|working now|solved)\b/i.test(fullText);

    // Lightweight intent/focus classifier
    const focus =
      /\b(manifest|service_worker|background|chrome extension|content\.js|dashboard)\b/i.test(fullText)
        ? "Chrome extension development / debugging"
        : /\b(essay|draft|rewrite|transfer)\b/i.test(fullText)
          ? "Writing / revision"
          : /\b(train|model|gnn|vae|tensor)\b/i.test(fullText)
            ? "ML / research work"
            : "General problem solving";

    // Next-step guess from last prompt
    let next = "";
    if (/\b(add|implement|build|create)\b/i.test(last)) next = "Implement the next requested feature and verify stats update correctly.";
    else if (/\b(debug|fix|error)\b/i.test(last)) next = "Reproduce the bug with a minimal test case and patch the failing step.";
    else next = "Continue from the last unresolved request and validate with a real session.";

    const bullets = [];
    bullets.push(`Focus: ${focus}`);
    if (kwText) bullets.push(`Key themes: ${kwText}`);
    if (hadError && !resolved) bullets.push(`Blocker: You hit an error that wasn?셳 fully resolved yet.`);
    if (resolved) bullets.push(`Progress: You resolved a blocking issue and confirmed things work.`);
    bullets.push(`Next step: ${next}`);

    // A compact one-liner (useful for table)
    const oneLiner = resolved
      ? `Resolved a blocker; session focused on ${focus.toLowerCase()}.`
      : `Worked on ${focus.toLowerCase()}${hadError ? " with blockers encountered." : "."}`;

    return {
      one_liner: oneLiner,
      text: bullets.join("\n")
    };
  }

  async function persistActiveSnapshot() {
    if (!activeSession) return;

    const elapsedMin = estimateElapsedMinutes(activeSession);
    const liveDepth = computeDepthScore(activeSession, elapsedMin);
    const avgPromptChars = Math.round(activeSession.total_prompt_chars / Math.max(1, activeSession.prompt_count));
    const keywords = topKeywords(activeSession.keyword_freq, 6);

    const summary = generateSessionSummary(activeSession);

    await setActiveSessionState({
      ...activeSession,
      duration_min_est: elapsedMin,
      avg_prompt_chars_est: avgPromptChars,
      depth_score_est: liveDepth,
      topic_keywords_est: keywords,
      summary_est: summary.text,
      summary_one_liner_est: summary.one_liner,
      last_updated: nowISO()
    });
  }

  async function endSession(reason = "unknown") {
    if (!activeSession) return;

    if (activeSession.prompt_count <= 0) activeSession.prompt_count = 1;

    activeSession.end_time = nowISO();

    const start = new Date(activeSession.start_time).getTime();
    const end = new Date(activeSession.end_time).getTime();
    const durationMin = Math.max(1, Math.round((end - start) / 60000));

    const depthScore = computeDepthScore(activeSession, durationMin);
    const avgPromptChars = Math.round(activeSession.total_prompt_chars / Math.max(1, activeSession.prompt_count));
    const keywords = topKeywords(activeSession.keyword_freq, 6);

    const summary = generateSessionSummary(activeSession);

    const sessionRecord = {
      ...activeSession,
      duration_min: durationMin,
      avg_prompt_chars: avgPromptChars,
      topic_keywords: keywords,
      depth_score: depthScore,
      summary: summary.text,
      summary_one_liner: summary.one_liner,
      end_reason: reason
    };

    await appendSessionHistory(sessionRecord);
    await setActiveSessionState(null);

    renderSessionOverlay({
      durationMin,
      promptCount: activeSession.prompt_count,
      avgPromptChars,
      refinementLoops: activeSession.refinement_loops,
      structuredPrompts: activeSession.structured_prompts,
      codePrompts: activeSession.code_prompts,
      topicKeywords: keywords,
      depthScore,
      sessionXp: activeSession.session_xp,
      summaryText: summary.text
    });

    activeSession = null;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }

  // -----------------------------
  // CONFIRMED SEND DETECTION
  // -----------------------------
  let lastTriggerAt = 0;
  function shouldTriggerNow() {
    const now = Date.now();
    if (now - lastTriggerAt < COOLDOWN_MS) return false;
    lastTriggerAt = now;
    return true;
  }

  let lastUserMsgCount = 0;
  let sendObserverStarted = false;

  function getUserMsgCount() {
    const n1 = document.querySelectorAll('[data-message-author-role="user"]').length;
    if (n1) return n1;
    const n2 = document.querySelectorAll('article[data-testid="conversation-turn"]').length;
    return n2;
  }

  async function bumpXpOnConfirmedSend() {
    const age = Date.now() - lastCapturedAt;
    let promptText = lastCapturedPrompt && age <= PROMPT_CAPTURE_WINDOW_MS ? lastCapturedPrompt : "";

    if (!promptText) promptText = getLastUserMessageText();
    if (!promptText) promptText = "Prompt sent";

    startSessionIfNeeded();
    updateSessionWithPrompt(promptText);

    if (activeSession) {
      const depth = safeNumber(getTurnDepthEstimate(), 1);
      activeSession.max_turn_depth = Math.max(activeSession.max_turn_depth || 1, depth);
    }

    const inc = randInt(INC_MIN, INC_MAX);
    showXpPopup(inc);
    await addXp(inc);

    if (activeSession) activeSession.session_xp += inc;

    await persistActiveSnapshot();
    resetInactivityTimer();

    lastCapturedPrompt = "";
    lastCapturedAt = 0;
  }

  function startSendObserver() {
    if (sendObserverStarted) return;
    sendObserverStarted = true;

    lastUserMsgCount = getUserMsgCount();

    const obs = new MutationObserver(() => {
      const nowCount = getUserMsgCount();
      if (nowCount > lastUserMsgCount) {
        lastUserMsgCount = nowCount;
        if (!shouldTriggerNow()) return;
        bumpXpOnConfirmedSend().catch(() => {});
      }
    });

    obs.observe(document.body, { childList: true, subtree: true });
  }

  startSendObserver();

  // -----------------------------
  // INIT + SPA SAFETY
  // -----------------------------
  render().catch(() => {});

  const mo = new MutationObserver(() => {
    if (!document.getElementById("cgpt-xp-widget")) {
      ui = null;
      barFill = null;
      levelLabel = null;
      xpLabel = null;
      render().catch(() => {});
    }
  });

  mo.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      setTimeout(() => {
        if (document.visibilityState === "hidden") endSession("tab_hidden").catch(() => {});
      }, 60 * 1000);
    }
  });
})();

