#!/usr/bin/env python3
# mia-core end to end with the REAL `claude -p` on Haiku (task 0292): a throwaway
# MIA_DIR, the real service loop, a few cents of tokens. Checks:
#   dispatch -> headless run -> exactly one finished event -> report + DONE note
#   mia tell -> the same session resumes (turn 2) -> one more event
#   service stopped mid-run and restarted -> the worker is adopted, one event
#   worker killed while the service is down -> resumed once with --resume
#   heartbeat run on Haiku -> HEARTBEAT_OK stays silent
#   python3 test/mia-core-e2e.py            (needs a logged-in `claude`)
import json
import os
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
MIA = os.path.join(REPO, "scripts", "mia")
CORE = os.path.join(REPO, "scripts", "mia-core")
HAIKU = "claude-haiku-5-5"

tmp = tempfile.mkdtemp(prefix="mia-core-e2e-")
D = os.path.join(tmp, "mia")
for sub in ("tasks", "briefs"):
    os.makedirs(os.path.join(D, sub))
# Ids from 9001 so a stray Fleet card can't be mistaken for a real task.
json.dump({"id": "9000", "title": "placeholder", "status": "done", "log": []},
          open(os.path.join(D, "tasks", "9000.json"), "w"))
json.dump({"headless": True, "maxConcurrent": 2, "retryDelaySeconds": 0, "keepAwake": False,
           "budget": {"usageCommand": False}, "heartbeats": {"enabled": False, "beats": {"hb_health": "health"}}},
          open(os.path.join(D, "core.json"), "w"))
ENV = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_CODE") and k not in ("CLAUDECODE", "AI_AGENT")}
ENV["MIA_DIR"] = D
passed = failed = 0
service = None


def ok(cond, label):
    global passed, failed
    if cond:
        passed += 1
        print("  ✓ " + label)
    else:
        failed += 1
        print("  ✗ " + label)


def sh(*args, stdin=None):
    r = subprocess.run(list(args), env=ENV, input=stdin, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise SystemExit("%s failed: %s %s" % (args, r.stdout, r.stderr))
    return r.stdout


def mia(*a, stdin=None):
    return sh("bash", MIA, *a, stdin=stdin)


def start_service():
    global service
    log = open(os.path.join(tmp, "core.log"), "a")
    service = subprocess.Popen([sys.executable, CORE, "run", "--interval", "1"], env=ENV,
                               stdout=log, stderr=log)


def stop_service():
    global service
    if service and service.poll() is None:
        service.terminate()
        service.wait(15)
    service = None


def db():
    c = sqlite3.connect(os.path.join(D, "jobs.db"))
    c.row_factory = sqlite3.Row
    return c


def job(task):
    with db() as c:
        r = c.execute("SELECT * FROM jobs WHERE task_id=? ORDER BY id DESC LIMIT 1", (task,)).fetchone()
        return dict(r) if r else None


def inbox():
    p = os.path.join(D, "inbox.jsonl")
    return [json.loads(l) for l in open(p)] if os.path.exists(p) else []


def task(t):
    return json.load(open(os.path.join(D, "tasks", t + ".json")))


def wait(cond, what, timeout=240):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(1)
    print("    (timed out waiting for %s)" % what)
    return False


BRIEF = """This is an automated test of the job queue; keep it minimal and fast.
1. Create a file named hello.txt in this folder containing the single line: hi
2. Then do the report + DONE note exactly as instructed above (one short line in the report).
"""

try:
    work = os.path.join(tmp, "work")
    os.makedirs(work)
    t1 = mia("task", "add", "E2E hello", "--dir", work).strip()
    print("dispatch -> one finish (task %s)" % t1)
    out = mia("dispatch", t1, "--model", HAIKU, "--stdin", stdin=BRIEF)
    ok("headless job" in out, "mia dispatch queued a headless job")
    start_service()
    ok(wait(lambda: (job(t1) or {}).get("status") == "finished", "finish"), "the run finished")
    time.sleep(3)
    j = job(t1)
    ev = [e for e in inbox() if e.get("taskId") == t1 and e["kind"] == "executor"]
    ok(len(ev) == 1, "exactly one finished event (%d)" % len(ev))
    ok(ev and "report written" in ev[0]["text"], "the event says the report was written")
    ok(os.path.exists(os.path.join(D, "briefs", t1 + ".report.md")), "report in the test MIA_DIR")
    ok(any(l["text"].strip() == "DONE" for l in task(t1)["log"]), "executor noted DONE through mia")
    ok(open(os.path.join(work, "hello.txt")).read().strip() == "hi", "the work was done")
    ok(task(t1)["status"] == "checking", "task is checking")
    ok(j["cost_usd"] > 0 and j["output_tokens"] > 0, "cost $%.4f, %d output tokens recorded" % (j["cost_usd"], j["output_tokens"]))
    with db() as c:
        r = c.execute("SELECT * FROM runs WHERE job_id=?", (j["id"],)).fetchone()
    first = open(r["log_path"]).readline()
    ok(j["session_id"] in open(r["log_path"]).read(), "stream-json carries the pre-assigned session id")

    print("mia tell -> resume the same session")
    mia("tell", t1, "Append a second line containing: bye  to hello.txt, add one line to the report, then end your turn.")
    ok(wait(lambda: (job(t1) or {}).get("turn") == 2 and job(t1)["status"] == "finished", "turn 2"), "turn 2 finished")
    time.sleep(3)
    ev = [e for e in inbox() if e.get("taskId") == t1 and e["kind"] == "executor"]
    ok([e["key"] for e in ev] == ["finish:%d:1" % j["id"], "finish:%d:2" % j["id"]], "one event per turn")
    ok("bye" in open(os.path.join(work, "hello.txt")).read(), "the told change landed")
    with db() as c:
        modes = [r["mode"] for r in c.execute("SELECT mode FROM runs WHERE job_id=? ORDER BY id", (j["id"],))]
    ok(modes == ["fresh", "resume"], "second run used --resume (%s)" % modes)

    print("service restart mid-run -> adopted")
    w2 = os.path.join(tmp, "work2")
    os.makedirs(w2)
    t2 = mia("task", "add", "E2E slow", "--dir", w2).strip()
    mia("dispatch", t2, "--model", HAIKU, "--stdin",
        stdin="Automated test. First run the shell command `sleep 25`. Then create done.txt containing ok, "
              "and do the report + DONE note as instructed above.\n")
    ok(wait(lambda: (job(t2) or {}).get("status") == "running", "running", 60), "running")
    time.sleep(6)
    stop_service()
    time.sleep(2)
    with db() as c:
        pid = c.execute("SELECT pid FROM runs WHERE job_id=? ORDER BY id DESC", (job(t2)["id"],)).fetchone()["pid"]
    alive = True
    try:
        os.kill(pid, 0)
    except OSError:
        alive = False
    ok(alive, "the worker outlived the service")
    start_service()
    ok(wait(lambda: job(t2)["status"] == "finished", "adopted finish"), "the new service saw it finish")
    time.sleep(3)
    ev = [e for e in inbox() if e.get("taskId") == t2 and e["kind"] == "executor"]
    ok(len(ev) == 1, "exactly one finished event after the restart (%d)" % len(ev))
    ok(os.path.exists(os.path.join(w2, "done.txt")), "the work was done")

    print("worker dies while the service is down -> resumed once")
    w3 = os.path.join(tmp, "work3")
    os.makedirs(w3)
    t3 = mia("task", "add", "E2E killed", "--dir", w3).strip()
    mia("dispatch", t3, "--model", HAIKU, "--stdin",
        stdin="Automated test. First run the shell command `sleep 30`. Then create done.txt containing ok, "
              "and do the report + DONE note as instructed above.\n")
    ok(wait(lambda: (job(t3) or {}).get("status") == "running" and job(t3)["session_started"], "started", 90),
       "running with a session")
    time.sleep(4)
    stop_service()
    with db() as c:
        pid = c.execute("SELECT pid FROM runs WHERE job_id=? ORDER BY id DESC", (job(t3)["id"],)).fetchone()["pid"]
    os.killpg(pid, signal.SIGKILL)   # only the worker this test started
    time.sleep(1)
    start_service()
    ok(wait(lambda: job(t3)["status"] in ("finished", "failed"), "resumed finish"), "it finished after a resume")
    time.sleep(3)
    j3 = job(t3)
    with db() as c:
        modes = [r["mode"] for r in c.execute("SELECT mode FROM runs WHERE job_id=? ORDER BY id", (j3["id"],))]
    ok(j3["status"] == "finished" and modes == ["fresh", "resume"], "resumed exactly once (%s, %s)" % (j3["status"], modes))
    ev = [e for e in inbox() if e.get("taskId") == t3 and e["kind"] == "executor"]
    ok(len(ev) == 1, "one event for the whole job (%d)" % len(ev))
    ok(any("resuming once" in l["text"] for l in task(t3)["log"]), "the task log says it was resumed")

    print("heartbeat run on Haiku")
    json.dump({"heartbeats": [{"id": "hb_health", "label": "Health", "everyMinutes": 180, "enabled": True,
                               "prompt": "Check that the folder %s exists (it does). If it exists, nothing needs Mia." % w3}],
               "reminders": []}, open(os.path.join(D, "schedule.json"), "w"))
    sh(sys.executable, CORE, "beat", "hb_health")
    ok(wait(lambda: db().execute("SELECT status FROM jobs WHERE beat_id='hb_health'").fetchone()[0]
            in ("finished", "failed"), "beat", 120), "the beat ran")
    time.sleep(2)
    b = dict(db().execute("SELECT * FROM jobs WHERE beat_id='hb_health'").fetchone())
    ok(b["model"] == HAIKU and b["status"] == "finished", "on Haiku, finished")
    ok("HEARTBEAT_OK" in (b["result"] or ""), "answered HEARTBEAT_OK (%r)" % (b["result"] or "")[:60])
    ok(not [e for e in inbox() if e["kind"] == "heartbeat"], "nothing reached Mia")
    total = db().execute("SELECT SUM(cost_usd) FROM jobs").fetchone()[0]
    print("  total cost of this test: $%.3f" % total)
finally:
    stop_service()
    with db() as c:
        for r in c.execute("SELECT pid FROM runs WHERE ended_at IS NULL"):
            try:
                os.killpg(r["pid"], signal.SIGTERM)
            except OSError:
                pass
    print("%d passed, %d failed  (logs: %s)" % (passed, failed, tmp))
sys.exit(1 if failed else 0)
