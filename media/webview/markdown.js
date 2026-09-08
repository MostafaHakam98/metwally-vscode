/* =============================================================================
   Streaming-safe Markdown renderer.
   Block pass (headings, lists, tables, quotes, fenced code) + inline pass.
   An unterminated ``` fence renders as an open code block so streaming output
   never flashes raw backticks.
   ========================================================================== */
(function (global) {
    "use strict";

    var HL = global.MtwHighlight;
    // U+0001, built at runtime so no control byte lives in this source file.
    var S = String.fromCharCode(1);

    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
        });
    }

    var ICON_COPY = '<svg><use href="#i-copy"/></svg>';
    var ICON_INSERT = '<svg><use href="#i-insert"/></svg>';
    var ICON_NEWFILE = '<svg><use href="#i-openfile"/></svg>';
    var ICON_CHECK = '<svg><use href="#i-check"/></svg>';

    /* ---------------------------------------------------------------- inline */

    function inline(src) {
        var codes = [];
        // 1. lift inline code out so its contents are never re-processed
        var text = String(src).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, function (_, f, body) {
            codes.push(body);
            return S + (codes.length - 1) + S;
        });

        // 2. escape everything else
        text = esc(text);

        // 3. inline constructs
        text = text
            .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, function (_, alt, url) {
                return /^(https?:|data:)/i.test(url)
                    ? '<img src="' + esc(url) + '" alt="' + alt + '" loading="lazy">'
                    : '<span class="md-link">' + alt + "</span>";
            })
            .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, function (_, label, url) {
                return /^https?:/i.test(url)
                    ? '<a href="' + esc(url) + '" data-ext="1">' + label + "</a>"
                    : '<a class="md-link" data-path="' + esc(url) + '">' + label + "</a>";
            })
            .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (_, pre, url) {
                return pre + '<a href="' + url + '" data-ext="1">' + url + "</a>";
            })
            .replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
            .replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
            .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
            .replace(/~~([\s\S]+?)~~/g, "<del>$1</del>");

        // 4. put code spans back
        var back = new RegExp(S + "(\\d+)" + S, "g");
        return text.replace(back, function (_, i) {
            return '<code class="inline">' + esc(codes[+i]) + "</code>";
        });
    }

    /* ------------------------------------------------------------ code block */

    function codeBlock(lang, file, code, open) {
        var body = HL ? HL.highlight(code, lang) : esc(code);
        var label = (lang || "text").toLowerCase();
        var head =
            '<div class="code-hd">' +
                '<span class="lang-tag">' + esc(label) + "</span>" +
                (file ? '<span class="code-file">' + esc(file) + "</span>" : "") +
                '<span class="spacer"></span>' +
                (open ? "" :
                    '<div class="code-actions">' +
                        '<button class="mini-btn" data-act="copy-code" title="Copy">' + ICON_COPY + "</button>" +
                        '<button class="mini-btn" data-act="insert-code" title="Insert at cursor">' + ICON_INSERT + "</button>" +
                        '<button class="mini-btn" data-act="new-file" title="Open in a new editor">' + ICON_NEWFILE + "</button>" +
                    "</div>") +
            "</div>";
        return '<div class="code-block" data-lang="' + esc(label) + '"' +
            (file ? ' data-file="' + esc(file) + '"' : "") + ">" +
            head + "<pre><code>" + body + "</code></pre></div>";
    }

    /* ----------------------------------------------------------------- table */

    function isDivider(line) {
        return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.indexOf("-") !== -1;
    }

    function cells(line) {
        var t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
        return t.split("|").map(function (c) { return c.trim(); });
    }

    /* ------------------------------------------------------------- list tree */

    function renderList(items, loose) {
        var out = "";
        var i = 0;
        while (i < items.length) {
            var ordered = items[i].ordered;
            var tag = ordered ? "ol" : "ul";
            // Honour an explicit start, so "3." does not render as "1.".
            var first = items[i].num;
            var attrs = (ordered && first > 1) ? ' start="' + first + '"' : "";
            if (loose) attrs += ' class="loose"';
            var buf = "";
            while (i < items.length && items[i].ordered === ordered) {
                var it = items[i];
                var cls = it.task ? ' class="task' + (it.checked ? " checked" : "") + '"' : "";
                var box = it.task
                    ? '<span class="box">' + (it.checked ? ICON_CHECK : "") + "</span>"
                    : "";
                buf += "<li" + cls + ">" + box + "<span>" + inline(it.text) +
                    (it.children.length ? renderList(it.children, it.childrenLoose) : "") + "</span></li>";
                i++;
            }
            out += "<" + tag + attrs + ">" + buf + "</" + tag + ">";
        }
        return out;
    }

    function collectList(lines, start, baseIndent) {
        var items = [];
        var i = start;
        var loose = false;
        while (i < lines.length) {
            // A blank line does not end a list when the list continues after
            // it. Treating it as a terminator started a fresh <ol> per item, so
            // every item in a loose list rendered as "1.".
            if (!lines[i].trim()) {
                var j = i;
                while (j < lines.length && !lines[j].trim()) j++;
                if (j >= lines.length) break;
                var la = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/.exec(lines[j]);
                var laIndent = la ? la[1].replace(/\t/g, "    ").length : -1;
                var continues = la ? laIndent >= baseIndent
                    : (items.length > 0 && /^\s{2,}\S/.test(lines[j]));
                if (!continues) break;
                loose = true;
                if (!la) items[items.length - 1].text += "\n";
                i = j;
                continue;
            }
            var m = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/.exec(lines[i]);
            if (!m) {
                if (items.length && /^\s{2,}\S/.test(lines[i])) {
                    items[items.length - 1].text += "\n" + lines[i].trim();
                    i++;
                    continue;
                }
                break;
            }
            var indent = m[1].replace(/\t/g, "    ").length;
            if (indent < baseIndent) break;
            if (indent > baseIndent && items.length) {
                var sub = collectList(lines, i, indent);
                items[items.length - 1].children = items[items.length - 1].children.concat(sub.items);
                items[items.length - 1].childrenLoose = sub.loose;
                i = sub.next;
                continue;
            }
            var text = m[4];
            var task = /^\[([ xX])\]\s+/.exec(text);
            items.push({
                indent: indent,
                num: m[3] ? parseInt(m[3], 10) : 0,
                ordered: !!m[3],
                task: !!task,
                checked: !!task && task[1].toLowerCase() === "x",
                text: task ? text.slice(task[0].length) : text,
                children: [],
                childrenLoose: false
            });
            i++;
        }
        return { items: items, next: i, loose: loose };
    }

    /* ---------------------------------------------------------------- blocks */

    function render(src) {
        if (!src) return "";
        var lines = String(src).replace(/\r\n?/g, "\n").split("\n");
        var out = "";
        var para = [];
        var i = 0;

        function flushPara() {
            if (!para.length) return;
            var joined = para.join("\n").trim();
            if (joined) out += "<p>" + inline(joined) + "</p>";
            para = [];
        }

        while (i < lines.length) {
            var line = lines[i];

            // fenced code
            var fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*(.*)$/.exec(line);
            if (fence) {
                flushPara();
                var mark = fence[1][0];
                var len = fence[1].length;
                var lang = fence[2] || "";
                var meta = (fence[3] || "").trim().replace(/^[:{]|[}]$/g, "").trim();
                var buf = [];
                var closed = false;
                var close = new RegExp("^\\s*" + (mark === "`" ? "`" : "~") + "{" + len + ",}\\s*$");
                i++;
                while (i < lines.length) {
                    if (close.test(lines[i])) { closed = true; i++; break; }
                    buf.push(lines[i]);
                    i++;
                }
                var file = /[./]/.test(meta) ? meta : (/[./]/.test(lang) ? lang : "");
                if (file === lang) lang = "";
                out += codeBlock(lang, file, buf.join("\n"), !closed);
                continue;
            }

            // heading
            var h = /^(#{1,6})\s+(.*)$/.exec(line);
            if (h) {
                flushPara();
                var lvl = Math.min(h[1].length, 4);
                out += "<h" + lvl + ">" + inline(h[2].replace(/\s+#+\s*$/, "")) + "</h" + lvl + ">";
                i++;
                continue;
            }

            // horizontal rule
            if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
                flushPara();
                out += "<hr>";
                i++;
                continue;
            }

            // blockquote
            if (/^\s{0,3}>\s?/.test(line)) {
                flushPara();
                var q = [];
                while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
                    q.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
                    i++;
                }
                out += "<blockquote>" + render(q.join("\n")) + "</blockquote>";
                continue;
            }

            // table
            if (line.indexOf("|") !== -1 && i + 1 < lines.length && isDivider(lines[i + 1])) {
                flushPara();
                var head = cells(line);
                i += 2;
                var rows = [];
                while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim()) {
                    rows.push(cells(lines[i]));
                    i++;
                }
                out += '<div class="table-wrap"><table><thead><tr>' +
                    head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") +
                    "</tr></thead><tbody>" +
                    rows.map(function (r) {
                        return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
                    }).join("") +
                    "</tbody></table></div>";
                continue;
            }

            // list
            if (/^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/.test(line)) {
                flushPara();
                var res = collectList(lines, i, 0);
                out += renderList(res.items, res.loose);
                i = res.next;
                continue;
            }

            if (!line.trim()) { flushPara(); i++; continue; }

            para.push(line);
            i++;
        }

        flushPara();
        return out;
    }

    global.MtwMarkdown = { render: render, inline: inline, esc: esc };
})(window);
