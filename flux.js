/**
 * Flux — SinkOS AI Assistant
 *
 * Usage inside SinkOS:
 *
 *   import { FluxApp } from "./flux.js";
 *
 *   const flux = new FluxApp({
 *     mountEl: someWindowContentElement,   // element to render into
 *     apiBaseUrl: "http://localhost:5001", // where backend/server.py runs
 *     getAuthToken: () => sb.auth.getSession().then(r => r.data.session?.access_token),
 *   });
 *   flux.mount();
 *
 * FluxApp fetches index.html, injects it into mountEl, then wires up events.
 * Conversation history is saved server-side in Supabase (via server.py),
 * scoped to the signed-in SinkOS user, so it survives page reloads, browser
 * resets, and SinkOS restarts, and stays private to that account.
 *
 * Every request to the backend carries the current Supabase access token
 * (Authorization: Bearer <token>) so server.py can verify who's asking —
 * see getAuthToken below. Without it, every call fails with 401.
 */

export class FluxApp {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.mountEl - container to render the Flux window into
   * @param {string} [opts.apiBaseUrl] - base URL of the Flux backend (server.py)
   * @param {string} [opts.htmlUrl] - path to index.html (defaults to sibling file)
   * @param {() => Promise<string|null>} [opts.getAuthToken] - returns the current
   *   Supabase access token for the signed-in SinkOS user. Defaults to reading
   *   it off the shared `window.sb` Supabase client SinkOSAuth already sets up.
   * @param {string} [opts.conversationId] - resume a specific conversation id;
   *   otherwise the most recently updated one loads, or a new one is created.
   */
  constructor(opts = {}) {
    this.mountEl = opts.mountEl;
    this.apiBaseUrl = opts.apiBaseUrl || "http://localhost:5001";
    this.htmlUrl = opts.htmlUrl || new URL("./index.html", import.meta.url).href;
    this.conversationId = opts.conversationId || null;
    this.getAuthToken =
      opts.getAuthToken ||
      (async () => {
        const client = typeof window !== "undefined" ? window.sb : null;
        if (!client) return null;
        const { data } = await client.auth.getSession();
        return data?.session?.access_token || null;
      });

    /** @type {{role: "user"|"assistant", content: string}[]} */
    this.messages = [];
    this.isSending = false;

    // DOM refs, set after mount()
    this.el = {};
  }

  async mount() {
    if (!this.mountEl) {
      throw new Error("FluxApp: mountEl is required");
    }

    const template = await this._getTemplate();
    this.mountEl.appendChild(template.content.cloneNode(true));

    this._bindDom();
    this._bindEvents();

    if (this.conversationId) {
      await this._restoreHistory();
    } else {
      // No specific conversation requested — pick up wherever this user
      // left off, or start fresh if they've never used Flux before.
      await this._resumeMostRecentOrStartNew();
    }
    await this._loadConversationList();
  }

  /**
   * Builds fetch() headers carrying the caller's Supabase session token.
   * Every authenticated backend call goes through this.
   */
  async _authHeaders(extra = {}) {
    const token = await this.getAuthToken();
    if (!token) {
      throw new Error("Not signed in — no Supabase session available for Flux.");
    }
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  async _resumeMostRecentOrStartNew() {
    let conversations = [];
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/flux/conversations`, {
        headers: await this._authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        conversations = data.conversations || [];
      }
    } catch (err) {
      console.warn("Flux: couldn't check for existing conversations", err);
    }

    if (conversations.length > 0) {
      this.conversationId = conversations[0].id;
      await this._restoreHistory();
    } else {
      // Brand new user — create their first conversation, but leave the
      // template's static greeting in the DOM as-is rather than wiping it.
      try {
        const res = await fetch(`${this.apiBaseUrl}/api/flux/conversations`, {
          method: "POST",
          headers: await this._authHeaders(),
        });
        const data = await res.json();
        this.conversationId = data.id;
      } catch (err) {
        console.warn("Flux: couldn't create an initial conversation", err);
      }
    }
  }

  /**
   * Returns the <template id="flux-window-template"> element, whether it's
   * already in the current document (standalone index.html) or needs to be
   * fetched from htmlUrl (embedded-in-SinkOS case).
   */
  async _getTemplate() {
    const inline = document.getElementById("flux-window-template");
    if (inline) return inline;

    const res = await fetch(this.htmlUrl);
    if (!res.ok) {
      throw new Error(`FluxApp: failed to load index.html (${res.status})`);
    }
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, "text/html");
    const template = doc.getElementById("flux-window-template");
    if (!template) {
      throw new Error("FluxApp: index.html has no #flux-window-template");
    }
    return template;
  }

  destroy() {
    if (this.mountEl) this.mountEl.innerHTML = "";
  }

  // ---- internal ----------------------------------------------------

  _bindDom() {
    const root = this.mountEl;
    this.el.window = root.querySelector("#flux-window");
    this.el.messages = root.querySelector("#flux-messages");
    this.el.form = root.querySelector("#flux-input-form");
    this.el.input = root.querySelector("#flux-input");
    this.el.sendBtn = root.querySelector("#flux-send-btn");
    this.el.clearBtn = root.querySelector("#flux-clear-btn");
    this.el.settingsBtn = root.querySelector("#flux-settings-btn");
    this.el.settingsPanel = root.querySelector("#flux-settings-panel");
    this.el.apiBaseInput = root.querySelector("#flux-api-base");
    this.el.settingsSave = root.querySelector("#flux-settings-save");
    this.el.settingsClose = root.querySelector("#flux-settings-close");
    this.el.sidebarToggle = root.querySelector("#flux-sidebar-toggle");
    this.el.newChatBtn = root.querySelector("#flux-new-chat-btn");
    this.el.conversationList = root.querySelector("#flux-conversation-list");
    this.el.micBtn = root.querySelector("#flux-mic-btn");

    this.el.apiBaseInput.value = this.apiBaseUrl;
  }

  _bindEvents() {
    this.el.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this._handleSend();
    });

    // Enter sends, Shift+Enter makes a newline
    this.el.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._handleSend();
      }
    });

    // Auto-grow the textarea
    this.el.input.addEventListener("input", () => {
      this.el.input.style.height = "auto";
      this.el.input.style.height = `${this.el.input.scrollHeight}px`;
    });

    this.el.clearBtn.addEventListener("click", () => this._clearConversation());

    this.el.settingsBtn.addEventListener("click", () => {
      this.el.settingsPanel.hidden = !this.el.settingsPanel.hidden;
    });
    this.el.settingsClose.addEventListener("click", () => {
      this.el.settingsPanel.hidden = true;
    });
    this.el.settingsSave.addEventListener("click", () => {
      this.apiBaseUrl = this.el.apiBaseInput.value.trim() || this.apiBaseUrl;
      this.el.settingsPanel.hidden = true;
    });

    this.el.sidebarToggle.addEventListener("click", () => {
      this.el.window.classList.toggle("flux-sidebar-collapsed");
    });

    this.el.newChatBtn.addEventListener("click", () => this._startNewChat());

    // One delegated listener handles clicks on any conversation item or its
    // delete button, since the list is re-rendered from scratch each time.
    this.el.conversationList.addEventListener("click", (e) => {
      const deleteBtn = e.target.closest(".flux-conversation-delete");
      if (deleteBtn) {
        e.stopPropagation();
        this._deleteConversation(deleteBtn.dataset.id);
        return;
      }
      const item = e.target.closest(".flux-conversation-item");
      if (item) {
        this._switchConversation(item.dataset.id);
      }
    });

    this._initSpeechRecognition();
  }

  /**
   * Push-to-talk voice input via the browser's built-in Web Speech API.
   * Hold the mic button to dictate; releasing it stops listening and
   * automatically sends whatever was transcribed.
   *
   * Note: this runs entirely in the browser (Chrome/Edge/Safari only —
   * Firefox has no support) and the audio is processed by the browser
   * vendor's own speech service, not by server.py/Gemini.
   */
  _initSpeechRecognition() {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      this.el.micBtn.hidden = true; // no support in this browser — hide the button
      return;
    }

    this.isListening = false;
    this.recognition = new SpeechRecognitionCtor();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = navigator.language || "en-US";

    this.recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          this._voiceFinalTranscript += transcript;
        } else {
          interim += transcript;
        }
      }
      this.el.input.value = (this._voiceFinalTranscript + interim).trim();
      this.el.input.style.height = "auto";
      this.el.input.style.height = `${this.el.input.scrollHeight}px`;
    };

    this.recognition.onerror = (event) => {
      console.warn("Flux: speech recognition error", event.error);
      this.el.micBtn.classList.remove("flux-mic-listening");
      this.isListening = false;

      const messages = {
        "not-allowed": "Mic access is blocked — check your browser's site permissions and macOS's microphone settings.",
        "service-not-allowed": "Mic access is blocked — check your browser's site permissions and macOS's microphone settings.",
        "no-speech": null, // not worth interrupting the user over — just didn't catch anything
        "audio-capture": "No microphone found — check that one's connected and selected.",
      };
      const text = messages[event.error] !== undefined ? messages[event.error] : `Voice input error: ${event.error}`;
      if (text) {
        this._appendMessage("assistant", text, { thinking: false });
        this.el.messages.lastElementChild.querySelector(".flux-msg-content").classList.add("flux-error");
      }
    };

    this.recognition.onend = () => {
      this.isListening = false;
      this.el.micBtn.classList.remove("flux-mic-listening");
      // Recognition has fully stopped and any final transcript has already
      // landed in the input via onresult — safe to send now.
      if (this.el.input.value.trim()) {
        this._handleSend();
      }
    };

    const start = (e) => {
      e.preventDefault();
      if (this.isListening) return;
      this.isListening = true;
      this._voiceFinalTranscript = "";
      this.el.input.value = "";
      this.el.micBtn.classList.add("flux-mic-listening");
      try {
        this.recognition.start();
      } catch (err) {
        // start() throws if called while already running — safe to ignore
        console.warn("Flux: couldn't start listening", err);
      }
    };

    const stop = () => {
      if (!this.isListening) return;
      this.recognition.stop(); // onend fires shortly after, which triggers send
    };

    this.el.micBtn.addEventListener("pointerdown", start);
    // Listen on the whole document for release, in case the pointer drifts
    // off the button before it's lifted — still counts as "let go".
    document.addEventListener("pointerup", stop);
    this.el.micBtn.addEventListener("pointercancel", stop);
  }

  async _handleSend() {
    const text = this.el.input.value.trim();
    if (!text || this.isSending) return;

    this._appendMessage("user", text);
    this.messages.push({ role: "user", content: text });

    this.el.input.value = "";
    this.el.input.style.height = "auto";

    const thinkingEl = this._appendMessage("assistant", "…", { thinking: true });
    this._setSending(true);

    try {
      const reply = await this._fetchReply();
      thinkingEl.classList.remove("flux-thinking");
      thinkingEl.textContent = reply;
      this.messages.push({ role: "assistant", content: reply });
      // Note: server.py saves both this user message and the reply to
      // Supabase as part of handling /api/flux/chat — no extra call needed here.
      this._loadConversationList();
    } catch (err) {
      thinkingEl.classList.remove("flux-thinking");
      thinkingEl.classList.add("flux-error");
      thinkingEl.textContent = `Can't reach the backend right now: ${err.message}`;
    } finally {
      this._setSending(false);
    }
  }

  async _fetchReply() {
    const res = await fetch(`${this.apiBaseUrl}/api/flux/chat`, {
      method: "POST",
      headers: await this._authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        messages: this.messages,
        conversation_id: this.conversationId, // may be null on the very first message
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    // The backend creates a conversation on the fly if none was passed.
    if (data.conversation_id) this.conversationId = data.conversation_id;
    return data.reply;
  }

  _appendMessage(role, content, { thinking = false } = {}) {
    const wrapper = document.createElement("div");
    wrapper.className = `flux-msg flux-msg-${role}`;

    const roleEl = document.createElement("div");
    roleEl.className = "flux-msg-role";
    roleEl.textContent = role === "user" ? "You" : "Flux";

    const contentEl = document.createElement("div");
    contentEl.className = "flux-msg-content" + (thinking ? " flux-thinking" : "");
    contentEl.textContent = content;

    wrapper.appendChild(roleEl);
    wrapper.appendChild(contentEl);
    this.el.messages.appendChild(wrapper);
    this.el.messages.scrollTop = this.el.messages.scrollHeight;

    return contentEl;
  }

  _setSending(sending) {
    this.isSending = sending;
    this.el.sendBtn.disabled = sending;
  }

  async _clearConversation() {
    this.messages = [];
    this.el.messages.innerHTML = "";
    this._appendMessage("assistant", "Clean slate — what's next?");
    try {
      await fetch(
        `${this.apiBaseUrl}/api/flux/history?conversation_id=${encodeURIComponent(this.conversationId)}`,
        { method: "DELETE", headers: await this._authHeaders() }
      );
    } catch (err) {
      console.warn("Flux: couldn't clear saved history on the server", err);
    }
    await this._loadConversationList();
  }

  // ---- persistence (Supabase, via server.py) ---------------------------

  async _restoreHistory() {
    if (!this.conversationId) return;
    let saved;
    try {
      const res = await fetch(
        `${this.apiBaseUrl}/api/flux/history?conversation_id=${encodeURIComponent(this.conversationId)}`,
        { headers: await this._authHeaders() }
      );
      if (!res.ok) return;
      const data = await res.json();
      saved = data.messages;
    } catch (err) {
      // Backend not reachable yet (e.g. not started) — just start with the
      // default greeting already in the template. No hard failure.
      console.warn("Flux: couldn't load saved history", err);
      return;
    }

    if (!saved || saved.length === 0) return;

    this.messages = saved;
    this.el.messages.innerHTML = "";
    for (const msg of saved) {
      this._appendMessage(msg.role, msg.content);
    }
  }

  // ---- sidebar / conversation list ------------------------------------

  async _loadConversationList() {
    let conversations;
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/flux/conversations`, {
        headers: await this._authHeaders(),
      });
      if (!res.ok) return;
      const data = await res.json();
      conversations = data.conversations || [];
    } catch (err) {
      console.warn("Flux: couldn't load conversation list", err);
      return;
    }
    this._renderConversationList(conversations);
  }

  _renderConversationList(conversations) {
    this.el.conversationList.innerHTML = "";

    for (const convo of conversations) {
      const item = document.createElement("div");
      item.className = "flux-conversation-item";
      if (convo.id === this.conversationId) item.classList.add("flux-active");
      item.dataset.id = convo.id;

      const title = document.createElement("span");
      title.className = "flux-conversation-title";
      title.textContent = convo.title || "New chat";

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "flux-conversation-delete";
      deleteBtn.dataset.id = convo.id;
      deleteBtn.title = "Delete conversation";
      deleteBtn.textContent = "✕";

      item.appendChild(title);
      item.appendChild(deleteBtn);
      this.el.conversationList.appendChild(item);
    }
  }

  async _switchConversation(id) {
    if (!id || id === this.conversationId) return;
    this.conversationId = id;
    this.messages = [];
    this.el.messages.innerHTML = "";
    await this._restoreHistory();
    if (this.messages.length === 0) {
      this._appendMessage("assistant", "Hey — I'm Flux. What are we working on?");
    }
    await this._loadConversationList();
  }

  async _startNewChat({ renderGreeting = true } = {}) {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/flux/conversations`, {
        method: "POST",
        headers: await this._authHeaders(),
      });
      const data = await res.json();
      this.conversationId = data.id;
    } catch (err) {
      console.warn("Flux: couldn't create a new conversation", err);
      return;
    }
    this.messages = [];
    this.el.messages.innerHTML = "";
    if (renderGreeting) {
      this._appendMessage("assistant", "Hey — I'm Flux. What are we working on?");
    }
    await this._loadConversationList();
  }

  async _deleteConversation(id) {
    const wasActive = id === this.conversationId;
    try {
      await fetch(`${this.apiBaseUrl}/api/flux/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: await this._authHeaders(),
      });
    } catch (err) {
      console.warn("Flux: couldn't delete conversation", err);
      return;
    }

    if (wasActive) {
      // Deleted the conversation we were looking at — fall back to a fresh one.
      await this._startNewChat();
    } else {
      await this._loadConversationList();
    }
  }
}

// ---- Standalone preview bootstrap ---------------------------------
// If index.html is opened directly (not embedded inside SinkOS), self-mount
// into #flux-standalone-mount. Since every backend request now needs a real
// Supabase session, this also handles signing in first — same project every
// other SinkOS module uses. Inside SinkOS, none of this runs (SinkOS embeds
// FluxApp itself via mount() with its own getAuthToken), so this only
// matters when someone opens this file's URL directly.
if (typeof document !== "undefined") {
  const standaloneMount = document.getElementById("flux-standalone-mount");
  if (standaloneMount) {
    const SUPABASE_URL = "https://okknkixdbjsnqrwlfgzn.supabase.co";
    const SUPABASE_ANON_KEY =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ra25raXhkYmpzbnFyd2xmZ3puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NzgwNzQsImV4cCI6MjA5ODE1NDA3NH0.L2QDUnez8KjIM8yg9cB9cs-tTq6nedk3CCpuJBjWBEg";

    const mountFluxStandalone = async () => {
      const app = new FluxApp({ mountEl: standaloneMount });
      await app.mount();
      window.flux = app; // handy for poking at from devtools
    };

    const renderSigninForm = (client) => {
      standaloneMount.innerHTML = `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;background:#05070f;font-family:-apple-system,'Segoe UI',sans-serif;">
          <div style="background:#10142b;border:1px solid rgba(120,150,255,0.16);border-radius:10px;padding:28px;width:280px;color:#dce4ff;">
            <h2 style="margin:0 0 16px;font-size:15px;letter-spacing:0.05em;">Sign in to talk to Flux</h2>
            <input id="flux-standalone-email" type="email" placeholder="Email" autocomplete="username"
              style="width:100%;box-sizing:border-box;margin-bottom:10px;padding:8px 10px;background:rgba(10,14,28,0.6);border:1px solid rgba(120,150,255,0.16);border-radius:6px;color:#dce4ff;font-size:13px;" />
            <input id="flux-standalone-password" type="password" placeholder="Password" autocomplete="current-password"
              style="width:100%;box-sizing:border-box;margin-bottom:10px;padding:8px 10px;background:rgba(10,14,28,0.6);border:1px solid rgba(120,150,255,0.16);border-radius:6px;color:#dce4ff;font-size:13px;" />
            <button id="flux-standalone-signin-btn"
              style="width:100%;padding:9px;border:none;border-radius:7px;cursor:pointer;background:linear-gradient(120deg,#4f7fee,#9b7cf5);color:#f4f7ff;font-weight:600;letter-spacing:0.04em;font-size:12px;">Sign in</button>
            <div id="flux-standalone-signin-error" style="color:#f2a9a9;font-size:12px;margin-top:10px;min-height:16px;"></div>
          </div>
        </div>
      `;
      const errorEl = document.getElementById("flux-standalone-signin-error");
      document.getElementById("flux-standalone-signin-btn").addEventListener("click", async () => {
        errorEl.textContent = "";
        const email = document.getElementById("flux-standalone-email").value.trim();
        const password = document.getElementById("flux-standalone-password").value;
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) {
          errorEl.textContent = error.message;
          return;
        }
        standaloneMount.innerHTML = "";
        mountFluxStandalone().catch((err) => {
          standaloneMount.textContent = `Flux failed to mount: ${err.message}`;
        });
      });
    };

    (async () => {
      try {
        const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
        const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        window.sb = client; // FluxApp's default getAuthToken() reads this

        const { data: { session } } = await client.auth.getSession();
        if (session) {
          await mountFluxStandalone();
        } else {
          renderSigninForm(client);
        }
      } catch (err) {
        standaloneMount.textContent = `Flux failed to mount: ${err.message}`;
      }
    })();
  }
}
