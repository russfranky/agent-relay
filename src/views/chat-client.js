// Chat client for /c/:box_id. No build step, no dependencies.
// Reads the share grant from the URL fragment (#g=...), so the secret
// never reaches server logs. One fetch stream stays open; the server
// pushes new messages as newline-delimited JSON. Reconnects with backoff.
(function () {
  "use strict";

  var boxId = document.body.getAttribute("data-box-id");
  var grant = null;
  var frag = location.hash.match(/[#&]g=([^&]+)/);
  if (frag) {
    try {
      grant = decodeURIComponent(frag[1]);
    } catch (e) {
      grant = frag[1];
    }
  }

  function $(id) {
    return document.getElementById(id);
  }

  var gate = $("gate");
  var chat = $("chat");
  var fatal = $("fatal");
  var linkError = $("link-error");
  var messagesEl = $("messages");
  var form = $("composer");
  var input = $("msg-input");
  var statusDot = $("status-dot");
  var statusText = $("status-text");
  var titleEl = $("chat-title");

  var seen = Object.create(null);
  var cursor = 0;
  var myName = null;
  var sending = false;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (e) {
      return "";
    }
  }

  function setStatus(mode, text) {
    statusDot.className = "dot " + mode;
    statusText.textContent = text;
  }

  function showFatal(msg) {
    fatal.hidden = false;
    fatal.textContent = msg;
    gate.hidden = true;
    chat.hidden = true;
  }

  function authHeaders(json) {
    var h = { Authorization: "Bearer " + grant };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async function api(path, opts) {
    var res = await fetch(path, opts);
    if (res.status === 401 || res.status === 410) {
      var err = new Error("gone");
      err.gone = true;
      throw err;
    }
    if (!res.ok) throw new Error("request failed: " + res.status);
    return res;
  }

  function bubble(msg) {
    var mine = msg.sender === myName;
    var div = document.createElement("div");
    div.className = "msg" + (mine ? " mine" : "");
    var html = "";
    if (!mine) html += '<div class="who">' + esc(msg.sender) + "</div>";
    html += '<div class="bubble">' + esc(msg.body) + "</div>";
    html += '<div class="when">' + esc(fmtTime(msg.created_at)) + "</div>";
    div.innerHTML = html;
    return div;
  }

  function appendMsg(msg) {
    if (!msg || seen[msg.id]) return;
    seen[msg.id] = true;
    if (msg.id > cursor) cursor = msg.id;
    var nearBottom =
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
      140;
    messagesEl.appendChild(bubble(msg));
    if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function loadHistory() {
    var res = await api(
      "/v1/boxes/" + encodeURIComponent(boxId) + "/messages?since=0&limit=50",
      { headers: authHeaders() }
    );
    var data = await res.json();
    (data.messages || []).forEach(appendMsg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function onSend(ev) {
    ev.preventDefault();
    var text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    try {
      var res = await api(
        "/v1/boxes/" + encodeURIComponent(boxId) + "/messages",
        {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({ sender: myName, body: text }),
        }
      );
      var msg = await res.json();
      input.value = "";
      appendMsg(msg);
    } catch (e) {
      if (e && e.gone) {
        showFatal("This chat link is wrong, or the chat was deleted.");
      } else {
        setStatus("reconnecting", "Send failed. Try again.");
      }
    } finally {
      sending = false;
      input.focus();
    }
  }

  var backoffMs = 1000;

  async function streamForever() {
    for (;;) {
      try {
        setStatus("connecting", "Connecting…");
        var res = await fetch(
          "/v1/boxes/" +
            encodeURIComponent(boxId) +
            "/stream?since=" +
            cursor,
          { headers: { Authorization: "Bearer " + grant } }
        );
        if (res.status === 401 || res.status === 410) {
          showFatal("This chat link is wrong, or the chat was deleted.");
          return;
        }
        if (!res.ok || !res.body) throw new Error("stream failed");
        setStatus("live", "Live");
        backoffMs = 1000;
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = "";
        for (;;) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf("\n")) !== -1) {
            var line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              appendMsg(JSON.parse(line));
            } catch (e) {
              // ignore malformed line
            }
          }
        }
      } catch (e) {
        // fall through to reconnect
      }
      setStatus("reconnecting", "Reconnecting…");
      await new Promise(function (r) {
        setTimeout(r, backoffMs);
      });
      backoffMs = Math.min(backoffMs * 2, 10000);
    }
  }

  function loadTitle() {
    fetch("/c/" + encodeURIComponent(boxId) + "/info", {
      headers: { Authorization: "Bearer " + grant },
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (info) {
        if (info && info.title) titleEl.textContent = info.title;
        else titleEl.textContent = "chat · " + boxId;
        document.title = titleEl.textContent + " · agent-relay";
      })
      .catch(function () {
        titleEl.textContent = "chat · " + boxId;
      });
  }

  function start(name) {
    myName = name;
    gate.hidden = true;
    chat.hidden = false;
    loadTitle();
    loadHistory()
      .then(function () {
        form.addEventListener("submit", onSend);
        streamForever();
      })
      .catch(function (e) {
        if (e && e.gone) {
          showFatal("This chat link is wrong, or the chat was deleted.");
        } else {
          showFatal(
            "Could not load this chat. Check your connection and reload the page."
          );
        }
      });
  }

  if (!grant) {
    linkError.hidden = false;
    return;
  }

  var stored = null;
  try {
    stored = localStorage.getItem("relay-name:" + boxId);
  } catch (e) {
    // private mode etc.
  }
  if (stored) {
    start(stored);
  } else {
    gate.hidden = false;
    $("name-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var v = $("name").value.trim().slice(0, 40);
      if (!v) return;
      try {
        localStorage.setItem("relay-name:" + boxId, v);
      } catch (e) {
        // private mode etc.
      }
      start(v);
    });
    $("name").focus();
  }
})();
