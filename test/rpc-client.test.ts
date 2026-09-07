import { test } from "node:test";
import * as assert from "node:assert/strict";
import { PiRpcClient } from "../src/rpc-client";

/**
 * The framing logic is the part of the client most likely to break silently:
 * a dropped or mis-split line loses an event with no error anywhere. These
 * tests drive onStdout directly instead of spawning pi.
 */
function harness() {
    const client = new PiRpcClient({ piPath: "/nonexistent/pi", cwd: "/tmp" });
    const events: Array<Record<string, unknown>> = [];
    const parseErrors: string[] = [];
    client.on("event", (e) => events.push(e));
    client.on("parse-error", (l) => parseErrors.push(l));
    const feed = (chunk: string) =>
        (client as unknown as { onStdout(b: Buffer): void }).onStdout(Buffer.from(chunk, "utf8"));
    return { client, events, parseErrors, feed };
}

test("emits one event per LF-terminated line", () => {
    const h = harness();
    h.feed('{"type":"a"}\n{"type":"b"}\n');
    assert.deepEqual(h.events.map((e) => e.type), ["a", "b"]);
});

test("buffers a line split across chunks", () => {
    const h = harness();
    h.feed('{"type":"age');
    assert.equal(h.events.length, 0, "must not emit a partial line");
    h.feed('nt_start"}\n');
    assert.deepEqual(h.events.map((e) => e.type), ["agent_start"]);
});

test("does not emit until the terminating newline arrives", () => {
    const h = harness();
    h.feed('{"type":"a"}');
    assert.equal(h.events.length, 0);
    h.feed("\n");
    assert.equal(h.events.length, 1);
});

test("strips a trailing CR so CRLF output still parses", () => {
    const h = harness();
    h.feed('{"type":"a"}\r\n');
    assert.deepEqual(h.events.map((e) => e.type), ["a"]);
});

test("skips blank and whitespace-only lines without reporting an error", () => {
    const h = harness();
    h.feed('\n   \n{"type":"a"}\n\n');
    assert.deepEqual(h.events.map((e) => e.type), ["a"]);
    assert.deepEqual(h.parseErrors, []);
});

test("reports malformed JSON and keeps processing later lines", () => {
    const h = harness();
    h.feed('not json\n{"type":"a"}\n');
    assert.deepEqual(h.parseErrors, ["not json"]);
    assert.deepEqual(h.events.map((e) => e.type), ["a"], "a bad line must not poison the stream");
});

test("splits a chunk carrying many lines at once", () => {
    const h = harness();
    h.feed(Array.from({ length: 50 }, (_, i) => `{"type":"e${i}"}`).join("\n") + "\n");
    assert.equal(h.events.length, 50);
    assert.equal(h.events[49].type, "e49");
});

test("reassembles a multi-byte character split across chunks", () => {
    // StringDecoder exists for exactly this; a naive toString() would corrupt it.
    const h = harness();
    const buf = Buffer.from('{"type":"a","t":"é"}\n', "utf8");
    const cut = buf.indexOf(Buffer.from("é", "utf8")) + 1;
    (h.client as unknown as { onStdout(b: Buffer): void }).onStdout(buf.subarray(0, cut));
    (h.client as unknown as { onStdout(b: Buffer): void }).onStdout(buf.subarray(cut));
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].t, "é");
});

test("routes a correlated response to its pending request", async () => {
    const h = harness();
    const pending = (h.client as unknown as {
        pending: Map<string, { resolve(v: unknown): void; reject(e: Error): void; timer?: NodeJS.Timeout }>;
    }).pending;
    const got = new Promise((resolve) => pending.set("req-1", { resolve, reject: () => {} }));
    h.feed('{"type":"response","id":"req-1","command":"prompt","success":true,"data":{"ok":1}}\n');
    assert.deepEqual((await got as Record<string, unknown>).data, { ok: 1 });
    assert.equal(h.events.length, 0, "a correlated response is not an agent event");
});

test("rejects a pending request when the response reports failure", async () => {
    const h = harness();
    const pending = (h.client as unknown as {
        pending: Map<string, { resolve(v: unknown): void; reject(e: Error): void; timer?: NodeJS.Timeout }>;
    }).pending;
    const failed = new Promise<Error>((resolve) => pending.set("req-9", { resolve: () => {}, reject: resolve }));
    h.feed('{"type":"response","id":"req-9","command":"compact","success":false,"error":"nope"}\n');
    assert.match((await failed).message, /nope/);
});

test("emits an uncorrelated response as an event rather than dropping it", () => {
    const h = harness();
    h.feed('{"type":"response","id":"unknown","command":"x","success":true}\n');
    assert.equal(h.events.length, 1);
});

test("send rejects when the process cannot be spawned", async () => {
    const client = new PiRpcClient({ piPath: "/nonexistent/pi-binary", cwd: "/tmp" });
    client.on("error", () => { /* swallow the spawn ENOENT */ });
    await assert.rejects(() => client.send({ type: "prompt" }, 500));
    client.kill();
});

test("isRunning is false before a spawn", () => {
    assert.equal(new PiRpcClient({ piPath: "/nonexistent/pi", cwd: "/tmp" }).isRunning, false);
});
