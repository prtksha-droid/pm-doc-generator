// Floating Chat Widget - The Scrum Book
(function () {
  // Avoid double-inject if script included twice
  if (window.__SSB_CHAT_WIDGET_LOADED__) return;
  window.__SSB_CHAT_WIDGET_LOADED__ = true;

  const STORAGE_KEY = "ssb_chat_history_v1";
  const MODE_KEY = "ssb_chat_mode_v1";

  const widgetHTML = `
    <button class="ssb-chat-btn" id="ssbChatToggle" title="Chat">
      💬
    </button>

    <div class="ssb-chat-panel" id="ssbChatPanel">
      <div class="ssb-chat-header">
        <div class="ssb-chat-title">
          <strong>The Scrum Book</strong>
          <span>Chat assistant</span>
        </div>

        <div class="ssb-chat-actions">
          <select class="ssb-mode" id="ssbChatMode" title="Mode">
            <option value="scrum">Scrum Coach</option>
            <option value="app">Scrum Book Help</option>
          </select>
          <button id="ssbChatClear" title="Clear">Clear</button>
          <button id="ssbChatClose" title="Close">✕</button>
        </div>
      </div>

      <div class="ssb-chat-body" id="ssbChatBody"></div>

      <div class="ssb-chat-footer">
        <textarea id="ssbChatInput" placeholder="Ask anything… (Enter to send, Shift+Enter = new line)"></textarea>
        <button id="ssbChatSend">Send</button>
      </div>
    </div>
  `;

  document.addEventListener("DOMContentLoaded", () => {
    document.body.insertAdjacentHTML("beforeend", widgetHTML);

    const toggleBtn = document.getElementById("ssbChatToggle");
    const panel = document.getElementById("ssbChatPanel");
    const closeBtn = document.getElementById("ssbChatClose");
    const clearBtn = document.getElementById("ssbChatClear");
    const body = document.getElementById("ssbChatBody");
    const input = document.getElementById("ssbChatInput");
    const sendBtn = document.getElementById("ssbChatSend");
    const modeEl = document.getElementById("ssbChatMode");

    // Restore mode
    modeEl.value = localStorage.getItem(MODE_KEY) || "scrum";
    modeEl.addEventListener("change", () => {
      localStorage.setItem(MODE_KEY, modeEl.value);
    });

    // Load history
    let messages = [];
    try {
      messages = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      messages = [];
    }

    function saveHistory() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-30))); // keep last 30 turns
    }

    function addMsg(text, who) {
      const div = document.createElement("div");
      div.className = `ssb-msg ${who === "user" ? "ssb-user" : "ssb-bot"}`;
      div.textContent = text;
      body.appendChild(div);
      body.scrollTop = body.scrollHeight;
    }

    function renderHistory() {
      body.innerHTML = "";
      if (messages.length === 0) {
        addMsg("Hi! Ask me anything about Scrum or how to use The Scrum Book.", "bot");
        return;
      }
      for (const m of messages) {
        if (m.role === "user") addMsg(m.content, "user");
        if (m.role === "assistant") addMsg(m.content, "bot");
      }
    }

    renderHistory();

    function openChat() {
      panel.classList.add("open");
      input.focus();
    }
    function closeChat() {
      panel.classList.remove("open");
    }

    toggleBtn.addEventListener("click", () => {
      panel.classList.contains("open") ? closeChat() : openChat();
    });
    closeBtn.addEventListener("click", closeChat);

    clearBtn.addEventListener("click", () => {
      messages = [];
      saveHistory();
      renderHistory();
    });

    async function send() {
      const text = (input.value || "").trim();
      if (!text) return;

      addMsg(text, "user");
      messages.push({ role: "user", content: text });
      input.value = "";
      saveHistory();

      sendBtn.disabled = true;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: modeEl.value,
            messages: messages.slice(-12) // send last few turns only
          })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Server error");

        const reply = data.reply || "(No reply)";
        addMsg(reply, "bot");
        messages.push({ role: "assistant", content: reply });
        saveHistory();
      } catch (e) {
        addMsg("⚠️ Error: " + e.message, "bot");
      } finally {
        sendBtn.disabled = false;
      }
    }

    sendBtn.addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
  });
})();
