/* =============================================================================
   Dependency-free syntax highlighter.
   A CDN is not reachable under the webview CSP, so this is a compact
   single-pass tokenizer covering the languages an agent actually emits.
   Returns HTML with <span class="tk-*"> spans; input is escaped here.
   ========================================================================== */
(function (global) {
    "use strict";

    function esc(s) {
        return s.replace(/[&<>]/g, function (c) {
            return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
        });
    }

    var KW = {
        c: "break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of package private protected public return static super switch this throw true try typeof undefined var void while yield async await as is namespace declare readonly type keyof infer satisfies abstract struct union sizeof template typename virtual override final using inline explicit friend operator constexpr noexcept nullptr auto goto register volatile extern signed unsigned defer func go chan map range select fallthrough impl fn mut pub trait where match loop move ref crate mod use dyn unsafe box",
        py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case self cls",
        sh: "if then else elif fi for while do done case esac function return in select until local export readonly declare source alias unset trap set shift eval exec exit",
        sql: "select from where insert into values update set delete create table drop alter add index join left right inner outer on group by order having limit offset union all as distinct and or not null primary key foreign references default constraint view with returning"
    };

    var TYPES = "int long short char float double bool boolean void string String number Number Boolean Object Array Promise Map Set Record Partial Uint8Array Buffer size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t";

    function wordSet(str) {
        var m = Object.create(null);
        str.split(/\s+/).forEach(function (w) { if (w) m[w] = 1; });
        return m;
    }

    var SETS = { c: wordSet(KW.c), py: wordSet(KW.py), sh: wordSet(KW.sh), sql: wordSet(KW.sql) };
    var TYPESET = wordSet(TYPES);

    var FAMILY = {
        js: "c", jsx: "c", ts: "c", tsx: "c", javascript: "c", typescript: "c", java: "c",
        c: "c", h: "c", cpp: "c", cc: "c", hpp: "c", cxx: "c", "c++": "c", cs: "c", csharp: "c",
        go: "c", golang: "c", rust: "c", rs: "c", kotlin: "c", kt: "c", swift: "c", scala: "c",
        php: "c", dart: "c", groovy: "c",
        py: "py", python: "py", python3: "py",
        sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh", fish: "sh",
        sql: "sql", psql: "sql", mysql: "sql",
        json: "json", jsonc: "json",
        yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml", conf: "yaml",
        css: "css", scss: "css", less: "css",
        html: "xml", xml: "xml", svg: "xml", vue: "xml",
        diff: "diff", patch: "diff"
    };

    /* One alternation per family. Order matters: comments and strings win. */
    var GRAMMAR = {
        c: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(`(?:\\[\s\S]|[^\\`])*`|"(?:\\[\s\S]|[^\\"\n])*"|'(?:\\[\s\S]|[^\\'\n])*')|(\b0[xXbBoO][0-9a-fA-F_]+\b|\b\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?[fFlLuU]*\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|([{}()[\].,;:?]|[-+*/%=!<>&|^~]+)/g,
        py: /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|[fFrRbBuU]{0,2}"(?:\\[\s\S]|[^\\"\n])*"|[fFrRbBuU]{0,2}'(?:\\[\s\S]|[^\\'\n])*')|(\b0[xXbBoO][0-9a-fA-F_]+\b|\b\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?\b)|(@[A-Za-z_][\w.]*)|([A-Za-z_][\w]*)(?=\s*\()|([A-Za-z_][\w]*)|([{}()[\].,;:]|[-+*/%=!<>&|^~]+)/g,
        sh: /(#[^\n]*)|("(?:\\[\s\S]|[^\\"])*"|'[^']*')|(\$\{[^}]*\}|\$[A-Za-z_][\w]*|\$[@#?*0-9])|(\b\d+\b)|(^\s*[A-Za-z_][\w-]*(?=\s)|(?<=[|;&]\s*)[A-Za-z_][\w-]*)|([A-Za-z_][\w-]*)|(--?[A-Za-z][\w-]*)|([|&;<>()$`\\"'{}[\]]|[-+*/%=!]+)/gm,
        json: /("(?:\\[\s\S]|[^\\"])*")(\s*:)?|(\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\],:])/g,
        yaml: /(#[^\n]*)|("(?:\\[\s\S]|[^\\"])*"|'[^']*')|^(\s*-?\s*)([\w.$-]+)(\s*:)|(\b-?\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b|\byes\b|\bno\b)/gm,
        css: /(\/\*[\s\S]*?\*\/)|("(?:\\[\s\S]|[^\\"])*"|'[^']*')|(@[\w-]+|--[\w-]+)|(\.[\w-]+|#[\w-]+|:{1,2}[\w-]+)|(\b[\w-]+)(?=\s*:)|(-?\b\d*\.?\d+(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b|#[0-9a-fA-F]{3,8}\b)|([{}();:,])/g,
        xml: /(<!--[\s\S]*?-->)|(<\/?)([\w:-]+)|([\w:-]+)(=)("(?:[^"]*)"|'[^']*')|(\/?>)/g,
        sql: /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*'|"(?:[^"])*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)|([(),;.*=<>!+-])/g,
        diff: null
    };

    function highlightDiff(code) {
        return code.split("\n").map(function (l) {
            var cls = l[0] === "+" ? "tk-str" : l[0] === "-" ? "tk-var" : l[0] === "@" ? "tk-op" : "";
            return cls ? '<span class="' + cls + '">' + esc(l) + "</span>" : esc(l);
        }).join("\n");
    }

    function run(code, fam) {
        var re = GRAMMAR[fam];
        if (!re) return esc(code);
        re.lastIndex = 0;
        var out = "";
        var last = 0;
        var m;
        while ((m = re.exec(code)) !== null) {
            if (m.index > last) out += esc(code.slice(last, m.index));
            out += classify(m, fam);
            last = m.index + m[0].length;
            if (m[0].length === 0) re.lastIndex++;
        }
        out += esc(code.slice(last));
        return out;
    }

    function span(cls, text) { return '<span class="' + cls + '">' + esc(text) + "</span>"; }

    function classify(m, fam) {
        var raw = m[0];
        switch (fam) {
            case "c":
                if (m[1]) return span("tk-com", raw);
                if (m[2]) return span("tk-str", raw);
                if (m[3]) return span("tk-num", raw);
                if (m[4]) return SETS.c[m[4]] ? span("tk-key", raw) : span("tk-fn", raw);
                if (m[5]) {
                    if (SETS.c[m[5]]) return span("tk-key", raw);
                    if (TYPESET[m[5]] || /^[A-Z]/.test(m[5])) return span("tk-typ", raw);
                    return esc(raw);
                }
                if (m[6]) return span("tk-op", raw);
                return esc(raw);

            case "py":
                if (m[1]) return span("tk-com", raw);
                if (m[2]) return span("tk-str", raw);
                if (m[3]) return span("tk-num", raw);
                if (m[4]) return span("tk-typ", raw);
                if (m[5]) return SETS.py[m[5]] ? span("tk-key", raw) : span("tk-fn", raw);
                if (m[6]) {
                    if (SETS.py[m[6]]) return span("tk-key", raw);
                    if (/^[A-Z]/.test(m[6])) return span("tk-typ", raw);
                    return esc(raw);
                }
                if (m[7]) return span("tk-op", raw);
                return esc(raw);

            case "sh":
                if (m[1]) return span("tk-com", raw);
                if (m[2]) return span("tk-str", raw);
                if (m[3]) return span("tk-var", raw);
                if (m[4]) return span("tk-num", raw);
                if (m[5]) return SETS.sh[m[5].trim()] ? span("tk-key", raw) : span("tk-fn", raw);
                if (m[6]) return SETS.sh[m[6]] ? span("tk-key", raw) : esc(raw);
                if (m[7]) return span("tk-typ", raw);
                if (m[8]) return span("tk-op", raw);
                return esc(raw);

            case "json":
                if (m[1]) return m[2]
                    ? span("tk-fn", m[1]) + span("tk-op", m[2])
                    : span("tk-str", m[1]);
                if (m[3]) return span("tk-num", raw);
                if (m[4]) return span("tk-key", raw);
                if (m[5]) return span("tk-op", raw);
                return esc(raw);

            case "yaml":
                if (m[1]) return span("tk-com", raw);
                if (m[2]) return span("tk-str", raw);
                if (m[4]) return esc(m[3] || "") + span("tk-fn", m[4]) + span("tk-op", m[5]);
                if (m[6]) return span("tk-num", raw);
                return esc(raw);

            case "css":
                if (m[1]) return span("tk-com", raw);
                if (m[2]) return span("tk-str", raw);
                if (m[3]) return span("tk-key", raw);
                if (m[4]) return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(m[4])
                    ? span("tk-num", raw)
                    : span("tk-typ", raw);
                if (m[5]) return span("tk-fn", raw);
                if (m[6]) return span("tk-num", raw);
                if (m[7]) return span("tk-op", raw);
                return esc(raw);

            case "xml":
                if (m[1]) return span("tk-com", raw);
                if (m[3]) return span("tk-op", m[2]) + span("tk-key", m[3]);
                if (m[4]) return span("tk-fn", m[4]) + span("tk-op", m[5]) + span("tk-str", m[6]);
                if (m[7]) return span("tk-op", raw);
                return esc(raw);

            case "sql":
                if (m[1]) return span("tk-com", raw);
                if (m[2]) return span("tk-str", raw);
                if (m[3]) return span("tk-num", raw);
                if (m[4]) return SETS.sql[m[4].toLowerCase()] ? span("tk-key", raw) : esc(raw);
                if (m[5]) return span("tk-op", raw);
                return esc(raw);
        }
        return esc(raw);
    }

    /** highlight(code, lang) -> escaped HTML string */
    function highlight(code, lang) {
        var key = String(lang || "").toLowerCase().replace(/^\./, "");
        var fam = FAMILY[key];
        if (!fam) return esc(code);
        if (fam === "diff") return highlightDiff(code);
        try {
            return run(code, fam);
        } catch (e) {
            return esc(code);
        }
    }

    global.MtwHighlight = { highlight: highlight, esc: esc, supports: FAMILY };
})(window);
