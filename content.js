(() => {
  // -----------------------------
  // CONFIG
  // -----------------------------
  const STORAGE_KEY = "cgpt_xp_state_v1";

  // XP per send (random)
  const INC_MIN = 3;
  const INC_MAX = 5;

  // Level system
  const MIN_LEVEL = 1;
  const MAX_LEVEL = 100;

  // Cooldown (avoid double triggers)
  const COOLDOWN_MS = 700;

  // -----------------------------
  // HELPERS
  // -----------------------------
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

  // XP curve:
  // XP needed to go from level L to L+1
  // (tweak this if you want faster/slower leveling)
  function xpNeededForNextLevel(level) {
    // gentle curve that ramps up
    // L=1 -> 25, L=10 -> 70, L=50 -> 325, L=99 -> 619 (approx)
    return Math.round(20 + 5 * level + 0.05 * level * level);
  }

  function computeProgressPercent(level, xpIntoLevel) {
    if (level >= MAX_LEVEL) return 100;
    const need = xpNeededForNextLevel(level);
    return clamp((xpIntoLevel / need) * 100, 0, 100);
  }

  // -----------------------------
  // CHATGPT DETECTION
  // -----------------------------
  function isChatGPTSendButton(btn) {
    if (!btn) return false;

    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    const testid = (btn.getAttribute("data-testid") || "").toLowerCase();
    const type = (btn.getAttribute("type") || "").toLowerCase();

    const ariaLooksLikeSend = aria.includes("send");
    const testidLooksLikeSend = testid.includes("send");
    const typeLooksLikeSubmit = type === "submit";

    if (ariaLooksLikeSend || testidLooksLikeSend) return true;

    // Fallback: submit button near prompt input
    if (typeLooksLikeSubmit) {
      const form = btn.closest("form");
      if (!form) return false;

      const hasTextarea = !!form.querySelector("textarea");
      const hasEditable = !!form.querySelector('[contenteditable="true"]');
      return hasTextarea || hasEditable;
    }

    return false;
  }

  function isChatGPTPromptInput(el) {
  if (!el) return false;

  // textarea path (older UI)
  if (el.tagName === "TEXTAREA") return !!el.closest("form");

  // contenteditable path (newer UI) — IMPORTANT: use closest()
  const editable = el.closest?.('[contenteditable="true"]');
  if (editable) return !!editable.closest("form");

  return false;
}


  // -----------------------------
  // UI
  // -----------------------------
  let ui = null;
  let barFill = null;
  let levelLabel = null;
  let xpLabel = null;
  let resetBtn = null;

  function createUI() {
    if (ui) return;

    ui = document.createElement("div");
    ui.id = "cgpt-xp-widget";
    ui.style.cssText = `
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      width: 240px;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      background: rgba(20,20,20,0.92);
      color: #fff;
      border: 1px solid rgba(21, 16, 16, 0.12);
      border-radius: 14px;
      padding: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      user-select: none;
    `;

    const title = document.createElement("div");
    title.textContent = "Prompt Progress";
    title.style.cssText = `font-size: 13px; font-weight: 700; margin-bottom: 8px;`;

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
    levelLabel.style.cssText = `font-size: 12px; font-weight: 700;`;

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
    hint.textContent = "Send → +XP";
    hint.style.cssText = `font-size: 11px; opacity: 0.6;`;

    resetBtn = document.createElement("button");
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
      await setState({ level: 1, xpIntoLevel: 0, totalXp: 0 });
      await render();
    });

    bottomRow.appendChild(hint);
    bottomRow.appendChild(resetBtn);

    ui.appendChild(title);
    ui.appendChild(topRow);
    ui.appendChild(barOuter);
    ui.appendChild(bottomRow);

    document.documentElement.appendChild(ui);
  }

  // -----------------------------
  // STORAGE STATE
  // -----------------------------
  // state = { level, xpIntoLevel, totalXp }
  function getState() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        const raw = res[STORAGE_KEY];
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

  function setState(state) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: state }, resolve);
    });
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

  setTimeout(() => {
    banner.remove();
  }, 1400);

  // pulse effect on bar
  if (barFill) {
    barFill.style.boxShadow = "0 0 15px gold";
    setTimeout(() => {
      barFill.style.boxShadow = "none";
    }, 1000);
  }
}

  // -----------------------------
  // RENDER
  // -----------------------------
  async function render() {
    createUI();
    const state = await getState();

    const level = state.level;
    const need = level >= MAX_LEVEL ? 0 : xpNeededForNextLevel(level);
    const xpInto = level >= MAX_LEVEL ? need : state.xpIntoLevel;

    // UI text
    if (levelLabel) levelLabel.textContent = `Level ${level}`;

    if (xpLabel) {
      if (level >= MAX_LEVEL) {
        xpLabel.textContent = `MAX`;
      } else {
        xpLabel.textContent = `${xpInto} / ${need} XP`;
      }
    }

    // Bar
    const pct = computeProgressPercent(level, state.xpIntoLevel);
    if (barFill) barFill.style.width = `${pct}%`;
  }

  // -----------------------------
  // XP INCREMENT + LEVEL UP
  // -----------------------------

  function showXpPopup(amount) {
  if (!ui) return;

  const popup = document.createElement("div");
  popup.textContent = `+${amount} XP`;

  popup.style.cssText = `
    position: absolute;
    right: 16px;
    bottom: 70px;
    font-size: 14px;
    font-weight: 700;
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

  setTimeout(() => {
    popup.style.opacity = "0";
  }, 500);

  setTimeout(() => {
    popup.remove();
  }, 700);
}


  async function addXp(amount) {
    const state = await getState();
    if (state.level >= MAX_LEVEL) {
      // already maxed
      await render();
      return;
    }

    state.totalXp += amount;
    state.xpIntoLevel += amount;

    // Level up loop (in case big XP increments later)
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

    await setState(state);
    await render();
  }

  async function bumpXpOnSend() {
  const inc = randInt(INC_MIN, INC_MAX);
  showXpPopup(inc);
  await addXp(inc);
}


  // -----------------------------
  // EVENT DETECTION (CLICK + ENTER)
  // -----------------------------
  let lastTriggerAt = 0;

  function shouldTriggerNow() {
    const now = Date.now();
    if (now - lastTriggerAt < COOLDOWN_MS) return false;
    lastTriggerAt = now;
    return true;
  }

  // -----------------------------
// EVENT DETECTION (CONFIRMED SEND)
// Detect a successful send by observing when a new user message is added.
// Works for click, Enter, Ctrl+Enter, mobile UI, etc.
// -----------------------------
let lastUserMsgCount = 0;
let sendObserverStarted = false;

function getUserMsgCount() {
  // Most common on ChatGPT
  const n1 = document.querySelectorAll('[data-message-author-role="user"]').length;
  if (n1) return n1;

  // Fallback (some builds)
  const n2 = document.querySelectorAll('article[data-testid="conversation-turn"]').length;
  return n2;
}

function startSendObserver() {
  if (sendObserverStarted) return;
  sendObserverStarted = true;

  // Set baseline so we don't count existing history
  lastUserMsgCount = getUserMsgCount();

  const obs = new MutationObserver(() => {
    const now = getUserMsgCount();
    if (now > lastUserMsgCount) {
      lastUserMsgCount = now;

      if (!shouldTriggerNow()) return;
      bumpXpOnSend().catch(() => {});
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
      resetBtn = null;
      render().catch(() => {});
    }
  });

  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
