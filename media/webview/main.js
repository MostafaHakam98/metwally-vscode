/* =============================================================================
   Metwally webview — application shell.
   Plain ES2020 JavaScript: this file is served to the webview verbatim, so it
   must never contain TypeScript syntax.
   ========================================================================== */
(function () {
    "use strict";

    var vscode = acquireVsCodeApi();
    var MD = window.MtwMarkdown;

    /* ------------------------------------------------------------------ dom */
    var $ = function (id) { return document.getElementById(id); };
    var chat = $("chat");
    var stream = $("stream");
    var input = $("input");
    var composer = $("composer");
    var btnSend = $("btn-send");
    var jump = $("jump");
    var dot = $("state-dot");
    var progress = $("progress");
    var attachBar = $("attachments");
    var charCount = $("char-count");

    /* ---------------------------------------------------------------- state */
    var S = {
        streaming: false,
        effort: "high",
        temp: 0,
        focus: false,
        model: "",
        provider: "",
        contextWindow: 0,
        cwd: "",
        workspace: "",
        attachments: [],
        transcript: [],      // [{role, text, attachments?}] — for export + restore
        usage: null,
        turnStart: 0,
        turnTokens: 0,
        stick: true,
        pop: null,
        lastPrompt: ""
    };

    var el = {
        bot: null,           // current assistant turn container
        text: null,          // current streaming markdown node
        raw: "",             // raw markdown accumulated
        think: null,
        thinkRaw: "",
        thinkStart: 0,
        tool: null,
        toolStart: 0,
        tools: 0
    };

    var timers = { turn: null, think: null, tool: null };

    /* --------------------------------------------------------------- helpers */

    function svg(id, cls) {
        return '<svg' + (cls ? ' class="' + cls + '"' : "") + '><use href="#' + id + '"/></svg>';
    }

    function esc(s) { return MD.esc(s); }

    function fmtNum(n) {
        if (n == null) return "0";
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
        if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
        return String(Math.round(n));
    }

    function fmtDur(ms) {
        if (ms < 1000) return ms + "ms";
        var s = ms / 1000;
        if (s < 60) return s.toFixed(1) + "s";
        var m = Math.floor(s / 60);
        return m + "m " + Math.round(s - m * 60) + "s";
    }

    function post(type, extra) {
        var m = { type: type };
        if (extra) for (var k in extra) m[k] = extra[k];
        vscode.postMessage(m);
    }

    /* ------------------------------------------------------------- scrolling */

    function atBottom() {
        return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
    }

    function scroll(force) {
        if (!force && !S.stick) return;
        chat.scrollTop = chat.scrollHeight;
    }

    chat.addEventListener("scroll", function () {
        S.stick = atBottom();
        jump.classList.toggle("show", !S.stick);
    }, { passive: true });

    jump.addEventListener("click", function () { S.stick = true; scroll(true); });

    /* ---------------------------------------------------------------- toasts */

    function toast(text, kind) {
        var t = document.createElement("div");
        t.className = "toast" + (kind === "err" ? " err" : "");
        t.innerHTML = svg(kind === "err" ? "i-alert" : "i-check") + "<span></span>";
        t.lastChild.textContent = text;
        $("toasts").appendChild(t);
        setTimeout(function () {
            t.classList.add("out");
            setTimeout(function () { t.remove(); }, 200);
        }, 2000);
    }

    /* ================================================================ welcome */

    var CARDS = [
        { icon: "i-folder",   title: "Explore this project",  desc: "Map the layout and entry points", prompt: "Give me a tour of this project: the layout, entry points and how the pieces fit together." },
        { icon: "i-flask",    title: "Run & fix tests",       desc: "Execute the suite, repair failures", prompt: "Run the test suite. If anything fails, diagnose the first real error and fix it." },
        { icon: "i-layers",   title: "Explain the architecture", desc: "Modules, data flow, boundaries", prompt: "Explain this codebase's architecture: modules, data flow and the boundaries between them." },
        { icon: "i-bug",      title: "Hunt for bugs",         desc: "Review recent changes critically", prompt: "Review the most recent changes in this repo and point out real bugs, ranked by severity." },
        { icon: "i-git",      title: "Review my diff",        desc: "Correctness, design, CI impact",  prompt: "Review my uncommitted changes for correctness, maintainability and CI impact." },
        { icon: "i-wand",     title: "Refactor something",    desc: "Simplify without changing behaviour", prompt: "Find the messiest module here and propose a concrete, behaviour-preserving refactor." }
    ];

    function welcome() {
        var ctx = S.contextWindow ? fmtNum(S.contextWindow) + " context" : "";
        var bits = [S.model || "model unset", "self-hosted", ctx].filter(Boolean);
        var html =
            '<div class="welcome">' +
                '<div class="hero-mark">' +
                    '<svg viewBox="0 0 24 24"><use href="#i-bolt" fill="none" stroke="url(#g-brand)" stroke-width="1.8"/></svg>' +
                '</div>' +
                "<h1>Metwally Coding Agent</h1>" +
                '<div class="sub">' + bits.map(function (b, i) {
                    return (i ? '<span class="dot"></span>' : "") + "<span>" + esc(b) + "</span>";
                }).join("") + "</div>" +
                (S.cwd ? '<div class="cwd" title="' + esc(S.cwd) + '">' + svg("i-folder") + esc(S.workspace || S.cwd) + "</div>" : "") +
                '<div class="cards">' +
                    CARDS.map(function (c) {
                        return '<button class="card" data-prompt="' + esc(c.prompt) + '">' +
                            '<span class="card-icon">' + svg(c.icon) + "</span>" +
                            '<span class="card-text">' +
                                '<span class="card-title">' + esc(c.title) + "</span>" +
                                '<span class="card-desc">' + esc(c.desc) + "</span>" +
                            "</span></button>";
                    }).join("") +
                "</div>" +
                '<div class="hints">' +
                    "<span><kbd>/</kbd> commands</span>" +
                    "<span><kbd>@</kbd> file context</span>" +
                    "<span><kbd>Shift</kbd><kbd>Enter</kbd> newline</span>" +
                    "<span><kbd>Esc</kbd> stop</span>" +
                "</div>" +
            "</div>";
        stream.innerHTML = html;
    }

    function clearWelcome() {
        var w = stream.querySelector(".welcome");
        if (w) w.remove();
    }

    /* ================================================================ turns */

    function addUser(text, atts) {
        clearWelcome();
        var d = document.createElement("div");
        d.className = "turn msg-user";
        var tags = (atts && atts.length)
            ? '<div class="att-row">' + atts.map(function (a) {
                  return '<span class="att-tag">' + svg(a.kind === "image" ? "i-image" : "i-file") + esc(a.name) + "</span>";
              }).join("") + "</div>"
            : "";
        d.innerHTML = '<div class="bubble">' + tags + '<span class="ut"></span></div>';
        d.querySelector(".bubble > .ut").textContent = text;
        stream.appendChild(d);
        S.stick = true;
        scroll(true);
    }

    function botTurn() {
        if (el.bot) return el.bot;
        clearWelcome();
        var d = document.createElement("div");
        d.className = "turn msg-bot";
        d.innerHTML =
            '<div class="avatar">' + svg("i-bolt") + "</div>" +
            '<div class="body"></div>';
        stream.appendChild(d);
        el.bot = d;
        return d;
    }

    function body() { return botTurn().querySelector(".body"); }

    function endTurn() {
        if (el.text) {
            el.text.innerHTML = MD.render(el.raw);
            if (el.raw.trim()) {
                S.transcript.push({ role: "assistant", text: el.raw });
                addTurnActions(el.text.parentNode, el.raw);
            }
        }
        el.text = null;
        el.raw = "";
        el.bot = null;
        persist();
    }

    function addTurnActions(container, raw) {
        if (!container || container.querySelector(".msg-actions")) return;
        var bar = document.createElement("div");
        bar.className = "msg-actions";
        bar.innerHTML =
            '<button class="mini-btn" data-act="copy-msg">' + svg("i-copy") + "Copy</button>" +
            '<button class="mini-btn" data-act="retry">' + svg("i-refresh") + "Retry</button>";
        bar.dataset.raw = raw;
        container.appendChild(bar);
    }

    /* ------------------------------------------------------------- thinking */

    function thinkBlock() {
        if (el.think) return el.think;
        var d = document.createElement("div");
        d.className = "think live";
        d.innerHTML =
            '<button class="think-hd">' +
                svg("i-brain") +
                '<span class="think-label">Thinking</span>' +
                '<span class="think-meta"></span>' +
                svg("i-chevron", "caret") +
            "</button>" +
            '<div class="think-body-wrap"><div><div class="think-body scroll"></div></div></div>';
        body().appendChild(d);
        el.think = d;
        el.thinkRaw = "";
        el.thinkStart = Date.now();
        clearInterval(timers.think);
        timers.think = setInterval(function () {
            var meta = d.querySelector(".think-meta");
            if (meta) meta.textContent = fmtDur(Date.now() - el.thinkStart);
        }, 200);
        return d;
    }

    function endThink() {
        clearInterval(timers.think);
        if (el.think) {
            el.think.classList.remove("live");
            var meta = el.think.querySelector(".think-meta");
            var words = el.thinkRaw.trim() ? el.thinkRaw.trim().split(/\s+/).length : 0;
            if (meta) meta.textContent = fmtDur(Date.now() - el.thinkStart) + " · " + fmtNum(words) + " words";
            var label = el.think.querySelector(".think-label");
            if (label) label.textContent = "Thought";
        }
        el.think = null;
        el.thinkRaw = "";
    }

    /* ----------------------------------------------------------------- tools */

    var TOOL_ICON = {
        bash: "i-terminal", shell: "i-terminal", run: "i-terminal", exec: "i-terminal",
        read: "i-book", read_file: "i-book", cat: "i-book", view: "i-book",
        write: "i-pencil", write_file: "i-pencil", create: "i-pencil",
        edit: "i-pencil", str_replace: "i-pencil", apply_patch: "i-pencil", multiedit: "i-pencil",
        grep: "i-search", search: "i-search", rg: "i-search", glob: "i-search", find: "i-search",
        ls: "i-folder", list: "i-folder", list_dir: "i-folder", tree: "i-folder",
        git: "i-git", todo: "i-check", task: "i-layers", agent: "i-cpu",
        fetch: "i-openfile", web: "i-openfile", browser: "i-openfile"
    };

    function toolIcon(name) {
        var n = String(name || "").toLowerCase();
        if (TOOL_ICON[n]) return TOOL_ICON[n];
        for (var k in TOOL_ICON) if (n.indexOf(k) !== -1) return TOOL_ICON[k];
        return "i-cpu";
    }

    function summarizeArgs(name, args) {
        if (!args || typeof args !== "object") return "";
        var pick = ["command", "cmd", "path", "file_path", "filePath", "file", "pattern", "query", "url", "description"];
        for (var i = 0; i < pick.length; i++) {
            var v = args[pick[i]];
            if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").slice(0, 220);
        }
        try {
            var j = JSON.stringify(args);
            return j.length > 160 ? j.slice(0, 160) + "…" : j;
        } catch (e) { return ""; }
    }

    function startTool(name, args) {
        var d = document.createElement("div");
        d.className = "tool live";
        d.innerHTML =
            '<button class="tool-hd">' +
                '<span class="tool-glyph">' + svg(toolIcon(name)) + "</span>" +
                '<span class="tool-name"></span>' +
                '<span class="tool-args"><span></span></span>' +
                '<span class="tool-time"></span>' +
                '<span class="state"></span>' +
                svg("i-chevron", "caret") +
            "</button>" +
            '<div class="tool-body"><div><pre class="tool-out scroll"></pre></div></div>';
        d.querySelector(".tool-name").textContent = name || "tool";
        var summary = summarizeArgs(name, args);
        var argsEl = d.querySelector(".tool-args");
        if (!/\s/.test(summary) && /[/.]/.test(summary)) argsEl.classList.add("path");
        argsEl.firstChild.textContent = summary;
        argsEl.title = summary;
        d.dataset.args = (function () { try { return JSON.stringify(args || {}); } catch (e) { return "{}"; } })();
        body().appendChild(d);
        el.tool = d;
        el.toolStart = Date.now();
        el.tools++;
        clearInterval(timers.tool);
        timers.tool = setInterval(function () {
            var t = d.querySelector(".tool-time");
            if (t) t.textContent = fmtDur(Date.now() - el.toolStart);
        }, 200);
        scroll();
    }

    function endTool(output, isError) {
        clearInterval(timers.tool);
        var d = el.tool;
        el.tool = null;
        if (!d) return;
        d.classList.remove("live");
        if (isError) d.classList.add("err");
        var t = d.querySelector(".tool-time");
        if (t) t.textContent = fmtDur(Date.now() - el.toolStart);
        var st = d.querySelector(".state");
        if (st) {
            st.className = "state " + (isError ? "err" : "ok");
            st.innerHTML = svg(isError ? "i-x" : "i-check");
        }
        renderToolOutput(d, output || "", isError);
        if (isError) d.classList.add("open");
        scroll();
    }

    function looksLikeDiff(text) {
        return /^(@@ |\+\+\+ |--- )/m.test(text) && /^[+-]/m.test(text);
    }

    function renderToolOutput(d, output, isError) {
        var host = d.querySelector(".tool-body > div");
        if (!host) return;
        var capped = output.length > 40000 ? output.slice(0, 40000) + "\n… (truncated)" : output;
        if (!isError && looksLikeDiff(capped)) {
            var lines = capped.split("\n").map(function (l) {
                var cls = l[0] === "+" ? "add" : l[0] === "-" ? "del" : l.slice(0, 2) === "@@" ? "hunk" : "ctx";
                var txt = (cls === "add" || cls === "del") ? l.slice(1) : l;
                return '<span class="dl ' + cls + '">' + esc(txt) + "</span>";
            }).join("");
            host.innerHTML = '<div class="diff scroll">' + lines + "</div>";
        } else {
            var pre = document.createElement("pre");
            pre.className = "tool-out scroll";
            pre.textContent = capped || "(no output)";
            host.innerHTML = "";
            host.appendChild(pre);
        }
    }

    /* ---------------------------------------------------------------- notice */

    function notice(text, kind, title) {
        clearWelcome();
        var d = document.createElement("div");
        d.className = "notice turn" + (kind === "info" ? " info" : "");
        d.innerHTML = svg(kind === "info" ? "i-info" : "i-alert") +
            '<div class="n-body">' + (title ? '<div class="n-title">' + esc(title) + "</div>" : "") + "<div></div></div>";
        d.querySelector(".n-body div:last-child").textContent = text;
        stream.appendChild(d);
        scroll();
    }

    /* =============================================================== composer */

    function autosize() {
        input.style.height = "auto";
        input.style.height = Math.min(input.scrollHeight, 200) + "px";
    }

    function updateSendState() {
        if (S.streaming) {
            btnSend.disabled = false;
            btnSend.classList.add("stop");
            btnSend.title = "Stop — Esc";
            btnSend.innerHTML = svg("i-stop");
        } else {
            btnSend.classList.remove("stop");
            btnSend.title = "Send — Enter";
            btnSend.innerHTML = svg("i-send");
            btnSend.disabled = !input.value.trim() && !S.attachments.length;
        }
    }

    function updateCount() {
        var n = input.value.length;
        charCount.textContent = n > 400 ? "~" + fmtNum(Math.round(n / 3.6)) + " tok" : "";
    }

    input.addEventListener("input", function () {
        autosize();
        updateSendState();
        updateCount();
        maybePopover();
    });

    input.addEventListener("focus", function () { composer.classList.add("focused"); });
    input.addEventListener("blur", function () { composer.classList.remove("focused"); });

    input.addEventListener("keydown", function (e) {
        if (S.pop && handlePopKey(e)) return;
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            send();
        } else if (e.key === "ArrowUp" && !input.value && S.lastPrompt) {
            e.preventDefault();
            input.value = S.lastPrompt;
            autosize();
            updateSendState();
        }
    });

    btnSend.addEventListener("click", function () {
        if (S.streaming) post("abort");
        else send();
    });

    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
            if (S.pop) { closePop(); return; }
            var ov = document.querySelector(".overlay");
            if (ov) { ov.remove(); return; }
            if (S.streaming) post("abort");
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
            e.preventDefault();
            post("new-session");
        }
    });

    function send() {
        var text = input.value.trim();
        if (!text && !S.attachments.length) return;
        if (S.streaming) return;

        if (text.charAt(0) === "/") {
            var handled = runSlash(text);
            if (handled) {
                input.value = "";
                autosize();
                updateSendState();
                updateCount();
                return;
            }
        }

        S.lastPrompt = text;
        input.value = "";
        autosize();
        updateCount();

        var atts = S.attachments.slice();
        S.attachments = [];
        renderAttachments();

        post("prompt", {
            text: text,
            effort: S.effort,
            temperature: S.temp,
            attachments: atts.map(function (a) {
                return { kind: a.kind, name: a.name, data: a.data, mimeType: a.mimeType, content: a.content, path: a.path };
            })
        });
    }

    /* --------------------------------------------------------- effort / temp */

    Array.prototype.forEach.call($("effort").children, function (b) {
        b.addEventListener("click", function () {
            Array.prototype.forEach.call($("effort").children, function (x) { x.classList.remove("on"); });
            b.classList.add("on");
            S.effort = b.dataset.v;
            persist();
        });
    });

    $("temp").addEventListener("change", function (e) {
        S.temp = parseFloat(e.target.value);
        persist();
    });

    /* ----------------------------------------------------------- attachments */

    function renderAttachments() {
        attachBar.innerHTML = S.attachments.map(function (a, i) {
            var thumb = a.kind === "image" && a.data
                ? '<img src="data:' + esc(a.mimeType || "image/png") + ";base64," + a.data + '" alt="">'
                : svg(a.kind === "image" ? "i-image" : "i-file");
            return '<span class="att">' + thumb +
                '<span class="att-name">' + esc(a.name) + "</span>" +
                '<button class="x" data-i="' + i + '" title="Remove">' + svg("i-x") + "</button></span>";
        }).join("");
        updateSendState();
    }

    attachBar.addEventListener("click", function (e) {
        var b = e.target.closest("button.x");
        if (!b) return;
        S.attachments.splice(+b.dataset.i, 1);
        renderAttachments();
    });

    $("btn-attach").addEventListener("click", function () { post("attach-file"); });

    // drag & drop
    ["dragenter", "dragover"].forEach(function (ev) {
        composer.addEventListener(ev, function (e) {
            e.preventDefault();
            composer.classList.add("drag");
        });
    });
    ["dragleave", "drop"].forEach(function (ev) {
        composer.addEventListener(ev, function (e) {
            e.preventDefault();
            composer.classList.remove("drag");
        });
    });
    composer.addEventListener("drop", function (e) {
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files) Array.prototype.forEach.call(files, readLocalFile);
        var uris = e.dataTransfer && e.dataTransfer.getData("text/uri-list");
        if (uris) uris.split(/\r?\n/).filter(Boolean).forEach(function (u) {
            post("resolve-uri", { uri: u });
        });
    });

    // paste images
    input.addEventListener("paste", function (e) {
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf("image/") === 0) {
                var f = items[i].getAsFile();
                if (f) { e.preventDefault(); readLocalFile(f); }
            }
        }
    });

    function readLocalFile(file) {
        var isImage = /^image\//.test(file.type);
        var r = new FileReader();
        r.onload = function () {
            if (isImage) {
                var b64 = String(r.result).split(",")[1];
                S.attachments.push({ kind: "image", name: file.name || "pasted.png", data: b64, mimeType: file.type });
            } else {
                S.attachments.push({ kind: "file", name: file.name, content: String(r.result).slice(0, 100000) });
            }
            renderAttachments();
        };
        if (isImage) r.readAsDataURL(file); else r.readAsText(file);
    }

    /* ============================================== popovers: slash & mention */

    var COMMANDS = [
        { name: "/new",      icon: "i-plus",     desc: "Start a fresh session",           run: function () { post("new-session"); } },
        { name: "/clear",    icon: "i-trash",    desc: "Clear the transcript",            run: function () { resetChat(); } },
        { name: "/history",  icon: "i-history",  desc: "Browse recent sessions",          run: function () { post("list-sessions"); } },
        { name: "/model",    icon: "i-cpu",      desc: "Switch the model",                run: function () { post("pick-model"); } },
        { name: "/focus",    icon: "i-focus",    desc: "Toggle focus mode",               run: function () { toggleFocus(); } },
        { name: "/export",   icon: "i-download", desc: "Export this chat as Markdown",    run: function () { doExport(); } },
        { name: "/settings", icon: "i-gear",     desc: "Open Metwally settings",          run: function () { post("open-settings"); } },
        { name: "/help",     icon: "i-info",     desc: "Keyboard shortcuts and tips",     run: function () { helpModal(); } },
        { name: "/compact",  icon: "i-layers",   desc: "Compact the conversation",        send: "Compact our conversation so far into a concise summary and continue from it." },
        { name: "/review",   icon: "i-git",      desc: "Review uncommitted changes",      send: "Review my uncommitted changes for correctness, maintainability and CI impact. Tag each finding by severity." },
        { name: "/tests",    icon: "i-flask",    desc: "Write tests for recent work",     send: "Write focused tests covering the code we just changed, then run them." },
        { name: "/explain",  icon: "i-book",     desc: "Explain the active file",         send: "Explain the file currently open in my editor: what it does and how it fits the system." },
        { name: "/fix",      icon: "i-wand",     desc: "Fix the current problems",        send: "Look at the diagnostics/problems in this workspace and fix the real ones." }
    ];

    function closePop() {
        if (S.pop) { S.pop.node.remove(); S.pop = null; }
    }

    function openPop(kind, items, onPick, title) {
        closePop();
        if (!items.length) return;
        var node = document.createElement("div");
        node.className = "pop scroll";
        node.innerHTML = (title ? '<div class="pop-title">' + esc(title) + "</div>" : "") +
            items.map(function (it, i) {
                return '<button class="pop-item' + (i === 0 ? " sel" : "") + '" data-i="' + i + '">' +
                    svg(it.icon || "i-file") +
                    '<span class="pi-main">' +
                        '<span class="pi-name">' + (it.mono ? '<span class="mono">' : "<span>") + esc(it.name) + "</span></span>" +
                        (it.desc ? '<span class="pi-desc">' + esc(it.desc) + "</span>" : "") +
                    "</span>" +
                    (it.key ? '<span class="pi-key">' + esc(it.key) + "</span>" : "") +
                "</button>";
            }).join("");
        $("composer").parentNode.appendChild(node);
        S.pop = { kind: kind, node: node, items: items, sel: 0, pick: onPick };
        node.addEventListener("mousedown", function (e) {
            var b = e.target.closest(".pop-item");
            if (!b) return;
            e.preventDefault();
            onPick(items[+b.dataset.i]);
            closePop();
        });
    }

    function movePop(delta) {
        var p = S.pop;
        var els = p.node.querySelectorAll(".pop-item");
        els[p.sel].classList.remove("sel");
        p.sel = (p.sel + delta + els.length) % els.length;
        els[p.sel].classList.add("sel");
        els[p.sel].scrollIntoView({ block: "nearest" });
    }

    function handlePopKey(e) {
        if (e.key === "ArrowDown") { e.preventDefault(); movePop(1); return true; }
        if (e.key === "ArrowUp") { e.preventDefault(); movePop(-1); return true; }
        if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            var p = S.pop;
            p.pick(p.items[p.sel]);
            closePop();
            return true;
        }
        if (e.key === "Escape") { e.preventDefault(); closePop(); return true; }
        return false;
    }

    function maybePopover() {
        var v = input.value;
        var caret = input.selectionStart;
        var upto = v.slice(0, caret);

        var slash = /(^|\n)\/([\w-]*)$/.exec(upto);
        if (slash) {
            var q = slash[2].toLowerCase();
            var hits = COMMANDS.filter(function (c) { return c.name.slice(1).indexOf(q) === 0; });
            if (hits.length) {
                openPop("slash", hits.map(function (c) {
                    return { name: c.name, desc: c.desc, icon: c.icon, mono: true, ref: c };
                }), function (it) {
                    input.value = v.slice(0, caret - slash[2].length - 1) + it.name + " " + v.slice(caret);
                    input.focus();
                    autosize();
                    updateSendState();
                }, "Commands");
                return;
            }
        }

        var at = /(^|\s)@([^\s@]*)$/.exec(upto);
        if (at) {
            post("search-files", { query: at[2] });
            S.pendingMention = { start: caret - at[2].length - 1, end: caret };
            return;
        }

        closePop();
    }

    function showFileHits(files) {
        if (!S.pendingMention) return;
        if (!files.length) { closePop(); return; }
        openPop("mention", files.map(function (f) {
            return { name: f.rel, desc: f.dir || "", icon: "i-file", mono: true, ref: f };
        }), function (it) {
            var m = S.pendingMention;
            var v = input.value;
            input.value = v.slice(0, m.start) + "@" + it.name + " " + v.slice(m.end);
            S.attachments.push({ kind: "ref", name: it.name, path: it.ref.path });
            renderAttachments();
            input.focus();
            autosize();
            updateSendState();
        }, "Files in workspace");
    }

    $("btn-mention").addEventListener("click", function () {
        input.focus();
        var pos = input.selectionStart;
        var needsSpace = pos > 0 && !/\s$/.test(input.value.slice(0, pos));
        input.value = input.value.slice(0, pos) + (needsSpace ? " @" : "@") + input.value.slice(pos);
        input.selectionStart = input.selectionEnd = pos + (needsSpace ? 2 : 1);
        maybePopover();
    });

    function runSlash(text) {
        var name = text.split(/\s+/)[0].toLowerCase();
        var cmd = null;
        for (var i = 0; i < COMMANDS.length; i++) if (COMMANDS[i].name === name) cmd = COMMANDS[i];
        if (!cmd) return false;
        if (cmd.run) { cmd.run(); return true; }
        if (cmd.send) {
            var rest = text.slice(name.length).trim();
            input.value = cmd.send + (rest ? "\n\n" + rest : "");
            send();
            return true;
        }
        return false;
    }

    document.addEventListener("mousedown", function (e) {
        if (S.pop && !e.target.closest(".pop") && !e.target.closest("#composer")) closePop();
    });

    /* ================================================================ header */

    function toggleFocus() {
        S.focus = !S.focus;
        chat.classList.toggle("focus", S.focus);
        $("btn-focus").classList.toggle("on", S.focus);
        $("btn-focus").setAttribute("aria-pressed", String(S.focus));
        persist();
    }

    $("btn-focus").addEventListener("click", toggleFocus);
    $("btn-history").addEventListener("click", function () { post("list-sessions"); });
    $("btn-settings").addEventListener("click", function () { post("open-settings"); });
    $("btn-new").addEventListener("click", function () { post("new-session"); });
    $("btn-export").addEventListener("click", doExport);
    $("model-chip").addEventListener("click", function () { post("pick-model"); });

    // Quick-action buttons
    document.querySelectorAll(".qa-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
            var prompt = btn.dataset.prompt;
            if (prompt) {
                el.input.value = prompt;
                el.input.focus();
                el.input.dispatchEvent(new Event("input"));
            }
        });
    });

    function doExport() {
        if (!S.transcript.length) { toast("Nothing to export yet", "err"); return; }
        var lines = ["# Metwally session", "", "- Model: " + (S.model || "unknown"),
            "- Workspace: " + (S.cwd || "unknown"),
            "- Exported: " + new Date().toISOString(), ""];
        S.transcript.forEach(function (t) {
            lines.push(t.role === "user" ? "## You" : "## Metwally", "", t.text, "");
        });
        post("export", { markdown: lines.join("\n") });
    }

    function setUsage(u) {
        S.usage = u;
        var chip = $("usage-chip");
        if (!u) {
            chip.hidden = true;
            $("model-chip").classList.remove("has-ctx");
            return;
        }
        chip.hidden = false;
        var parts = [fmtNum(u.totalTokens || 0) + " tok"];
        if (u.cost && u.cost.total) parts.push("$" + u.cost.total.toFixed(4));
        chip.textContent = parts.join(" · ");
        chip.title =
            "in " + fmtNum(u.input) + " · out " + fmtNum(u.output) +
            " · cache r/w " + fmtNum(u.cacheRead) + "/" + fmtNum(u.cacheWrite);

        if (S.contextWindow) {
            $("model-chip").classList.add("has-ctx");
            var used = (u.input || 0) + (u.cacheRead || 0) + (u.output || 0);
            var pct = Math.max(0, Math.min(100, (used / S.contextWindow) * 100));
            var ring = $("ctx-ring");
            ring.querySelector(".ring-fg").style.strokeDashoffset = String(100 - pct);
            ring.className = "ctx-ring" + (pct > 90 ? " crit" : pct > 70 ? " warn" : "");
            $("model-chip").title = S.model + " — " + Math.round(pct) + "% of " +
                fmtNum(S.contextWindow) + " context used";
        }
    }

    function setStreaming(on) {
        S.streaming = on;
        dot.className = on ? "busy" : "ok";
        dot.title = on ? "Working…" : "Idle";
        progress.classList.toggle("on", on);
        updateSendState();
        clearInterval(timers.turn);
        if (on) {
            S.turnStart = Date.now();
            S.turnTokens = 0;
        }
    }

    /* ================================================================ modals */

    function modal(title, bodyHtml, icon) {
        var ov = document.createElement("div");
        ov.className = "overlay";
        ov.innerHTML =
            '<div class="modal">' +
                '<div class="modal-hd">' + svg(icon || "i-history") + "<span>" + esc(title) + "</span>" +
                    '<span class="spacer"></span>' +
                    '<button class="icon-btn" data-close="1">' + svg("i-x") + "</button>" +
                "</div>" +
                '<div class="modal-body scroll">' + bodyHtml + "</div>" +
            "</div>";
        document.body.appendChild(ov);
        ov.addEventListener("click", function (e) {
            if (e.target === ov || e.target.closest("[data-close]")) ov.remove();
        });
        return ov;
    }

    function sessionsModal(sessions) {
        var html = sessions.length
            ? sessions.map(function (s) {
                  return '<button class="row-btn" data-path="' + esc(s.path) + '">' + svg("i-history") +
                      '<span class="row-main"><span class="row-name">' + esc(s.name) + "</span>" +
                      '<span class="row-meta" title="' + esc(s.path) + '">' + esc(s.when) + "</span></span>" +
                      svg("i-chevron") + "</button>";
              }).join("")
            : '<div class="pop-empty">No saved sessions yet.</div>';
        var ov = modal("Session history", html, "i-history");
        ov.addEventListener("click", function (e) {
            var b = e.target.closest(".row-btn");
            if (!b) return;
            post("switch-session", { path: b.dataset.path });
            ov.remove();
        });
    }

    function helpModal() {
        var rows = [
            ["Send message", ["Enter"]],
            ["New line", ["Shift", "Enter"]],
            ["Stop generation", ["Esc"]],
            ["New session", ["Ctrl", "L"]],
            ["Command palette", ["/"]],
            ["Add file context", ["@"]],
            ["Recall last prompt", ["Up"]],
            ["Attach / paste image", ["Ctrl", "V"]]
        ];
        modal("Shortcuts", '<div class="kv-list">' + rows.map(function (r) {
            return '<div class="kv"><span class="k">' + esc(r[0]) + '</span><span class="v">' +
                r[1].map(function (k) { return "<kbd>" + esc(k) + "</kbd>"; }).join("") + "</span></div>";
        }).join("") + "</div>", "i-info");
    }

    /* ======================================================== click delegation */

    stream.addEventListener("click", function (e) {
        // Welcome card click
        var card = e.target.closest(".card");
        if (card && card.dataset.prompt) {
            input.value = card.dataset.prompt;
            input.focus();
            input.dispatchEvent(new Event("input"));
            return;
        }
        var hd = e.target.closest(".tool-hd, .think-hd");
        if (hd) { hd.parentNode.classList.toggle("open"); return; }

        var act = e.target.closest("[data-act]");
        if (act) {
            var kind = act.dataset.act;
            if (kind === "copy-code" || kind === "insert-code" || kind === "new-file") {
                var block = act.closest(".code-block");
                var code = block.querySelector("pre code").textContent;
                if (kind === "copy-code") {
                    copyText(code, act);
                } else if (kind === "insert-code") {
                    post("insert-code", { code: code });
                } else {
                    post("new-file", { code: code, lang: block.dataset.lang, file: block.dataset.file || "" });
                }
            } else if (kind === "copy-msg") {
                copyText(act.parentNode.dataset.raw || "", act);
            } else if (kind === "retry") {
                if (S.lastPrompt) {
                    input.value = S.lastPrompt;
                    autosize();
                    send();
                }
            }
            return;
        }

        var link = e.target.closest("a[data-path]");
        if (link) { post("open-file", { path: link.dataset.path }); return; }
        var ext = e.target.closest("a[data-ext]");
        if (ext) { e.preventDefault(); post("open-external", { url: ext.getAttribute("href") }); }
    });

    function copyText(text, btn) {
        post("copy", { text: text });
        if (btn) {
            var old = btn.innerHTML;
            btn.classList.add("done");
            btn.innerHTML = svg("i-check") + (btn.textContent.trim() ? "Copied" : "");
            setTimeout(function () { btn.classList.remove("done"); btn.innerHTML = old; }, 1200);
        }
    }

    /* ============================================================== persistence */

    function persist() {
        try {
            vscode.setState({
                transcript: S.transcript.slice(-60),
                effort: S.effort,
                temp: S.temp,
                focus: S.focus
            });
        } catch (e) { /* state is best effort */ }
    }

    function restore() {
        var st;
        try { st = vscode.getState(); } catch (e) { st = null; }
        if (!st) return false;
        if (st.effort) {
            S.effort = st.effort;
            Array.prototype.forEach.call($("effort").children, function (b) {
                b.classList.toggle("on", b.dataset.v === st.effort);
            });
        }
        if (typeof st.temp === "number") { S.temp = st.temp; $("temp").value = String(st.temp); }
        if (st.focus) toggleFocus();
        if (st.transcript && st.transcript.length) {
            S.transcript = st.transcript;
            stream.innerHTML = "";
            st.transcript.forEach(function (t) {
                if (t.role === "user") addUser(t.text, t.attachments);
                else {
                    var d = document.createElement("div");
                    d.className = "turn msg-bot";
                    d.innerHTML = '<div class="avatar">' + svg("i-bolt") + '</div><div class="body"><div class="md"></div></div>';
                    d.querySelector(".md").innerHTML = MD.render(t.text);
                    addTurnActions(d.querySelector(".body"), t.text);
                    stream.appendChild(d);
                }
            });
            scroll(true);
            return true;
        }
        return false;
    }

    function resetChat() {
        S.transcript = [];
        el.bot = null; el.text = null; el.raw = ""; el.think = null; el.tool = null;
        clearInterval(timers.think); clearInterval(timers.tool);
        setUsage(null);
        $("ctx-ring").querySelector(".ring-fg").style.strokeDashoffset = "100";
        welcome();
        persist();
    }

    /* ========================================================= extension bus */

    window.addEventListener("message", function (e) {
        var m = e.data;
        switch (m.type) {
            case "init":
                S.model = m.model || "";
                S.provider = m.provider || "";
                S.contextWindow = m.contextWindow || 0;
                S.cwd = m.cwd || "";
                S.workspace = m.workspace || "";
                $("model-label").textContent = m.modelLabel || m.model || "model";
                $("model-chip").title = (m.model || "") + (m.contextWindow ? " · " + fmtNum(m.contextWindow) + " context" : "");
                if (!restore()) welcome();
                setStreaming(false);
                dot.className = "";
                break;

            case "user-message":
                addUser(m.text, m.attachments);
                S.transcript.push({ role: "user", text: m.text, attachments: m.attachments });
                persist();
                break;

            case "thinking-start":
                thinkBlock();
                scroll();
                break;

            case "thinking-delta": {
                var tb = thinkBlock().querySelector(".think-body");
                el.thinkRaw += m.text;
                tb.textContent = el.thinkRaw;
                tb.scrollTop = tb.scrollHeight;
                scroll();
                break;
            }

            case "thinking-end":
                endThink();
                break;

            case "text-delta":
                if (!el.text) {
                    var host = document.createElement("div");
                    host.className = "md";
                    body().appendChild(host);
                    el.text = host;
                    el.raw = "";
                }
                el.raw += m.text;
                el.text.innerHTML = MD.render(el.raw);
                scroll();
                break;

            case "tool-start":
                endThink();
                startTool(m.toolName, m.args);
                break;

            case "tool-update":
                if (el.tool) {
                    var out = el.tool.querySelector(".tool-out");
                    if (out) {
                        var t = m.output || "";
                        out.textContent = t.length > 4000 ? "…" + t.slice(-4000) : t;
                    }
                }
                break;

            case "tool-end":
                endTool(m.output, m.isError);
                break;

            case "message-end":
                endThink();
                endTurn();
                break;

            case "streaming":
                setStreaming(!!m.active);
                if (!m.active) { endThink(); endTurn(); }
                break;

            case "usage":
                setUsage(m.usage);
                break;

            case "error":
                notice(m.text, "err", m.title || "Agent error");
                break;

            case "info":
                notice(m.text, "info", m.title);
                break;

            case "toast":
                toast(m.text, m.kind);
                break;

            case "clear":
                resetChat();
                break;

            case "sessions":
                sessionsModal(m.sessions || []);
                break;

            case "files":
                showFileHits(m.files || []);
                break;

            case "attachment":
                S.attachments.push(m.attachment);
                renderAttachments();
                break;

            case "set-input":
                input.value = m.text || "";
                autosize();
                updateSendState();
                input.focus();
                if (m.send) send();
                break;

            case "model":
                S.model = m.model;
                S.contextWindow = m.contextWindow || S.contextWindow;
                $("model-label").textContent = m.modelLabel || m.model;
                break;
        }
    });

    /* ------------------------------------------------------------------ boot */

    welcome();
    updateSendState();
    post("ready");
})();
