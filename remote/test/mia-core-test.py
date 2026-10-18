#!/usr/bin/env python3
# mia-core (task 0292): the job queue, headless runner, cap, routing, budget,
# heartbeat runs and restart reconciliation, against a temp MIA_DIR and a fake
# `claude` (fake-claude.py). Nothing touches ~/.mission-control.
#   python3 test/mia-core-test.py
import importlib.machinery
import importlib.util
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import warnings

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
MIA = os.path.join(REPO, "scripts", "mia")
CORE = os.path.join(REPO, "scripts", "mia-core")
FAKE = os.path.join(HERE, "fake-claude.py")


def load_core_module(mia_dir):
    os.environ["MIA_DIR"] = mia_dir
    loader = importlib.machinery.SourceFileLoader("mia_core_%d" % int(time.time() * 1e6), CORE)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    m = importlib.util.module_from_spec(spec)
    loader.exec_module(m)
    return m


class Env(object):
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="mia-core-test-")
        self.dir = os.path.join(self.tmp, "mia")
        self.work = os.path.join(self.tmp, "work")
        for d in (self.dir, self.work, os.path.join(self.dir, "briefs"), os.path.join(self.dir, "tasks")):
            os.makedirs(d, exist_ok=True)
        self.fake_log = os.path.join(self.tmp, "fake-calls.jsonl")
        self.env = dict(os.environ, MIA_DIR=self.dir, MIA_CLAUDE_BIN=FAKE, FAKE_CLAUDE_LOG=self.fake_log,
                        FAKE_CLAUDE_STATE=os.path.join(self.tmp, "sessions"))
        self.env.pop("CLAUDECODE", None)
        self.config({"headless": True, "retryDelaySeconds": 0, "reapGraceSeconds": 1, "keepAwake": False,
                     "budget": {"usageCommand": False}})

    def config(self, over):
        p = os.path.join(self.dir, "core.json")
        c = json.load(open(p)) if os.path.exists(p) else {}
        c.update(over)
        json.dump(c, open(p, "w"))

    def run(self, *args, stdin=None, ok=True):
        r = subprocess.run(list(args), env=self.env, input=stdin, capture_output=True, text=True, timeout=60)
        if ok and r.returncode != 0:
            raise AssertionError("%s failed (%d): %s %s" % (args, r.returncode, r.stdout, r.stderr))
        return r

    def mia(self, *args, stdin=None, ok=True):
        return self.run("bash", MIA, *args, stdin=stdin, ok=ok)

    def core(self, *args, ok=True):
        return self.run(sys.executable, CORE, *args, ok=ok)

    def task(self, tid):
        return json.load(open(os.path.join(self.dir, "tasks", tid + ".json")))

    def add(self, title="Do it", work=None):
        return self.mia("task", "add", title, "--dir", work or self.work).stdout.strip()

    def dispatch(self, tid, brief, *flags):
        return self.mia("dispatch", tid, "--stdin", *flags, stdin=brief)

    def db(self):
        c = sqlite3.connect(os.path.join(self.dir, "jobs.db"))
        c.row_factory = sqlite3.Row
        return c

    def jobs(self):
        with self.db() as c:
            return [dict(r) for r in c.execute("SELECT * FROM jobs ORDER BY id")]

    def job(self, jid):
        return next(j for j in self.jobs() if j["id"] == jid)

    def inbox(self):
        p = os.path.join(self.dir, "inbox.jsonl")
        return [json.loads(l) for l in open(p)] if os.path.exists(p) else []

    def calls(self):
        return [json.loads(l) for l in open(self.fake_log)] if os.path.exists(self.fake_log) else []

    def tick_until(self, cond, timeout=30, what="condition"):
        end = time.time() + timeout
        while time.time() < end:
            self.core("tick")
            if cond():
                return
            time.sleep(0.3)
        raise AssertionError("timed out waiting for " + what + "; jobs=" + json.dumps(self.jobs(), default=str)[:1500])

    def cleanup(self):
        # Stop anything a test left running (only our fake workers).
        try:
            with self.db() as c:
                for r in c.execute("SELECT pid FROM runs WHERE pid IS NOT NULL"):
                    try:
                        os.killpg(r["pid"], signal.SIGKILL)
                    except OSError:
                        pass
        except sqlite3.Error:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)


def finishes(inbox, tid):
    return [e for e in inbox if e.get("taskId") == tid and e["kind"] == "executor"]


class CoreTests(unittest.TestCase):
    def setUp(self):
        warnings.simplefilter("ignore", ResourceWarning)
        self.e = Env()

    def tearDown(self):
        self.e.cleanup()

    def test_dispatch_finish_exactly_once(self):
        e = self.e
        tid = e.add()
        r = e.dispatch(tid, "Build the thing. FAKE:sleep=1 FAKE:report=%s\n" % tid, "--model", "claude-haiku-5-5")
        self.assertIn("headless job 1", r.stdout)
        self.assertFalse(os.path.exists(os.path.join(e.dir, "dispatch", tid + ".json")), "no WezTerm dispatch file")
        self.assertEqual(e.job(1)["status"], "queued")
        e.tick_until(lambda: e.job(1)["status"] == "finished", what="finish")
        for _ in range(3):
            e.core("tick")
        t = e.task(tid)
        self.assertEqual(t["status"], "checking")
        ex = t["executor"]
        self.assertTrue(ex["headless"])
        self.assertEqual(ex["sessionId"], e.job(1)["session_id"])
        self.assertEqual(ex["finishKey"], "finish:1:1")
        self.assertEqual(ex["outputTokens"], 500)
        f = finishes(e.inbox(), tid)
        self.assertEqual(len(f), 1, "exactly one finished event")
        self.assertIn("finished", f[0]["text"])
        self.assertIn("report written", f[0]["text"])
        self.assertIn("$0.01", f[0]["text"])
        c = e.calls()[0]
        self.assertIn("-p", c["args"])
        self.assertEqual(c["args"][c["args"].index("--output-format") + 1], "stream-json")
        self.assertIn("--session-id", c["args"])
        self.assertTrue(c["prompt"].startswith("You are executing Mission Control task %s" % tid))
        self.assertEqual(c["env"]["MIA_TASK_ID"], tid)
        self.assertIsNone(c["env"]["CLAUDECODE"])
        self.assertEqual(os.path.realpath(c["cwd"]), os.path.realpath(e.work))
        # The live log reads back.
        log = e.mia("core", "log", tid).stdout
        self.assertIn("Bash echo working", log)
        self.assertIn("■ done", log)
        snap = json.load(open(os.path.join(e.dir, "jobs.json")))
        self.assertEqual(snap["jobs"][0]["status"], "finished")

    def test_crash_resumes_once_then_one_event(self):
        e = self.e
        tid = e.add()
        e.dispatch(tid, "FAKE:die\n", "--model", "m")
        e.tick_until(lambda: e.job(1)["status"] == "finished", what="resumed finish")
        calls = e.calls()
        self.assertEqual(len(calls), 2)
        self.assertIn("--resume", calls[1]["args"])
        self.assertTrue(calls[1]["prompt"].startswith("resume"))
        self.assertEqual(len(finishes(e.inbox(), tid)), 1)
        stalls = [x for x in e.inbox() if x["kind"] == "stall"]
        self.assertEqual(len(stalls), 1)
        self.assertFalse(stalls[0]["deliver"], "auto-resume is logged, not sent to Mia")
        self.assertTrue(any("resuming once" in l["text"] for l in e.task(tid)["log"]))

    def test_dies_twice_fails_with_reason(self):
        e = self.e
        tid = e.add()
        e.dispatch(tid, "FAKE:die-always\n", "--model", "m")
        e.tick_until(lambda: e.job(1)["status"] == "failed", what="failed")
        for _ in range(2):
            e.core("tick")
        f = finishes(e.inbox(), tid)
        self.assertEqual(len(f), 1)
        self.assertIn("failed after an automatic resume", f[0]["text"])
        self.assertIn("exited without a result", f[0]["text"])
        self.assertEqual(e.task(tid)["status"], "checking")

    def test_api_error_resumes(self):
        e = self.e
        tid = e.add()
        e.dispatch(tid, "FAKE:error\n", "--model", "m")
        e.tick_until(lambda: e.job(1)["status"] == "finished", what="finish after error")
        self.assertIn("529", e.job(1)["error"] or "529")   # error kept until the next failure clears
        self.assertEqual(len(finishes(e.inbox(), tid)), 1)

    def test_died_before_session_restarts_fresh(self):
        e = self.e
        tid = e.add()
        e.dispatch(tid, "FAKE:predie\n", "--model", "m")
        e.tick_until(lambda: len(e.calls()) >= 2 and e.job(1)["status"] in ("finished", "failed"), what="2nd run")
        calls = e.calls()
        self.assertIn("--session-id", calls[1]["args"], "no session yet: start fresh, same id")
        self.assertIn("FAKE:predie", calls[1]["prompt"])

    def test_restart_reconciliation(self):
        e = self.e
        tid = e.add()
        e.dispatch(tid, "FAKE:sleep=2\n", "--model", "m")
        e.core("tick")   # this "service" process exits right away: the worker must survive it
        j = e.job(1)
        self.assertEqual(j["status"], "running")
        e.tick_until(lambda: e.job(1)["status"] == "finished", what="adopted finish")
        self.assertEqual(len(finishes(e.inbox(), tid)), 1)
        # A worker killed while the service was down (sleep, flat battery):
        tid2 = e.add("second", work=os.path.join(e.tmp))
        e.dispatch(tid2, "FAKE:sleep=30\n", "--model", "m")
        e.core("tick")
        with e.db() as c:
            pid = c.execute("SELECT pid FROM runs WHERE job_id=2").fetchone()["pid"]
        os.killpg(pid, signal.SIGKILL)
        time.sleep(0.3)
        e.core("tick")
        self.assertEqual(e.job(2)["failures"], 1)
        self.assertIn("exited without a result", e.job(2)["error"])

    def test_cap_and_folder_queueing(self):
        e = self.e
        e.config({"maxConcurrent": 2})
        ids = []
        for i in range(3):
            w = os.path.join(e.tmp, "w%d" % i)
            os.makedirs(w)
            tid = e.add("t%d" % i, work=w)
            e.dispatch(tid, "FAKE:sleep=2\n", "--model", "m")
            ids.append(tid)
        e.core("tick")
        st = [j["status"] for j in e.jobs()]
        self.assertEqual(st.count("running"), 2)
        self.assertEqual(st.count("queued"), 1)
        self.assertIn("waiting for a slot", e.job(3)["wait_reason"])
        e.tick_until(lambda: all(j["status"] == "finished" for j in e.jobs()), what="all finish")
        # Same folder: the second waits even under the cap.
        a, b = e.add("a"), e.add("b")
        e.dispatch(a, "FAKE:sleep=1\n", "--model", "m")
        e.dispatch(b, "FAKE:ok\n", "--model", "m")
        e.core("tick")
        self.assertEqual(e.jobs()[-1]["wait_reason"], "folder busy with another job")
        e.tick_until(lambda: all(j["status"] == "finished" for j in e.jobs()), what="folder jobs")

    def test_reaper_stops_lingering_run_and_registered_server(self):
        e = self.e
        tid = e.add()
        e.dispatch(tid, "FAKE:server FAKE:linger\n", "--model", "m")
        e.tick_until(lambda: e.job(1)["status"] == "finished", what="finish")
        with e.db() as c:
            r = c.execute("SELECT * FROM runs WHERE job_id=1").fetchone()
        server = int(open(r["pidfile"]).read().split()[0])
        e.tick_until(lambda: e.db().execute("SELECT ended_at FROM runs WHERE job_id=1").fetchone()[0] is not None,
                     what="reaped", timeout=20)

        def gone(pid):
            try:
                os.kill(pid, 0)
            except OSError:
                return True
            st = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout
            return st.strip().startswith("Z") or not st.strip()
        time.sleep(0.5)
        self.assertTrue(gone(r["pid"]), "claude process stopped")
        self.assertTrue(gone(server), "registered server stopped")

    def test_tell_resumes_session_without_length_limit(self):
        e = self.e
        tid = e.add()
        e.dispatch(tid, "FAKE:ok\n", "--model", "m")
        e.tick_until(lambda: e.job(1)["status"] == "finished", what="turn 1")
        long_msg = "Please also fix the header. " + ("x" * 2000)
        r = e.mia("tell", tid, long_msg)
        self.assertIn("resuming its session", r.stdout)
        self.assertEqual(e.task(tid)["status"], "running")
        e.tick_until(lambda: e.job(1)["status"] == "finished" and e.job(1)["turn"] == 2, what="turn 2")
        c = e.calls()[-1]
        self.assertIn("--resume", c["args"])
        self.assertEqual(c["prompt"], long_msg)
        f = finishes(e.inbox(), tid)
        self.assertEqual([x["key"] for x in f], ["finish:1:1", "finish:1:2"])

    def test_tell_while_running_folds_into_one_finish(self):
        e = self.e
        tid = e.add()
        e.dispatch(tid, "FAKE:sleep=2\n", "--model", "m")
        e.core("tick")
        self.assertIn("after its current turn", e.mia("tell", tid, "also do Y").stdout)
        e.tick_until(lambda: e.job(1)["status"] == "finished", what="finish")
        self.assertEqual(e.job(1)["turn"], 2)
        self.assertEqual(len(finishes(e.inbox(), tid)), 1)
        self.assertEqual(e.calls()[-1]["prompt"], "also do Y")

    def test_cancelled_task_stops_its_job(self):
        e = self.e
        tid = e.add()
        e.dispatch(tid, "FAKE:sleep=30\n", "--model", "m")
        e.core("tick")
        e.mia("task", "set", tid, "status", "cancelled")
        e.core("tick")
        self.assertEqual(e.job(1)["status"], "cancelled")
        e.tick_until(lambda: e.db().execute("SELECT ended_at FROM runs").fetchone()[0] is not None, what="ended")
        self.assertEqual(finishes(e.inbox(), tid), [])

    def test_redispatch_of_a_closed_task_runs(self):
        e = self.e
        tid = e.add()
        e.mia("task", "set", tid, "status", "failed")
        e.dispatch(tid, "FAKE:ok\n", "--model", "m")
        self.assertEqual(e.task(tid)["status"], "running")
        e.tick_until(lambda: e.job(1)["status"] == "finished", what="finish")
        self.assertEqual(len(finishes(e.inbox(), tid)), 1)

    def test_routing_by_default(self):
        e = self.e
        e.config({"routeByDefault": True})
        a = e.add("Summarise the week's mail")
        e.dispatch(a, "Summarise the inbox.\n")
        self.assertEqual(e.jobs()[-1]["model"], "claude-haiku-5-5")
        self.assertTrue(e.task(a)["routing"]["guessed"])
        b = e.add("Research dry agers", work=os.path.join(e.tmp))
        e.dispatch(b, "Research and compare three dry agers.\n")
        self.assertEqual(e.jobs()[-1]["model"], "claude-sonnet-5-5")
        os.makedirs(e.tmp + "/c")
        c = e.add("Build the panel", work=e.tmp + "/c")
        e.dispatch(c, "Implement the feature and research the API first.\n")
        self.assertEqual(e.jobs()[-1]["model"], "claude-opus-5-5")
        d = e.add("Explicit")
        e.dispatch(d, "Summarise this.\n", "--kind", "build")
        self.assertEqual(e.jobs()[-1]["model"], "claude-opus-5-5", "an explicit kind wins")
        r = e.mia("routing").stdout
        self.assertIn("kind heartbeat\tcheap", r)

    def test_budget_pauses_new_opus_work_only(self):
        e = self.e
        e.config({"budget": {"enabled": True, "pauseAt": 0.8, "opusDailyOutputTokens": 600, "usageCommand": False}})
        t1 = e.add("one", work=e.tmp)
        e.dispatch(t1, "FAKE:opus\n", "--model", "claude-opus-5-5")
        e.tick_until(lambda: e.job(1)["status"] == "finished", what="first opus job")
        t2 = e.add("two")
        e.dispatch(t2, "FAKE:ok\n", "--model", "claude-opus-5-5")
        h = e.add("cheap", work=e.tmp + "/h")
        os.makedirs(e.tmp + "/h")
        e.dispatch(h, "FAKE:ok\n", "--model", "claude-haiku-5-5")
        e.core("tick")
        self.assertEqual(e.job(2)["status"], "queued")
        self.assertIn("budget", e.job(2)["wait_reason"])
        self.assertNotEqual(e.job(3)["status"], "queued", "cheap work keeps running")
        e.core("tick")
        notes = [x for x in e.inbox() if x["kind"] == "budget"]
        self.assertEqual(len(notes), 1, "one heads-up")
        u = e.add("urgent", work=e.tmp + "/u")
        os.makedirs(e.tmp + "/u")
        e.dispatch(u, "FAKE:ok\n", "--model", "claude-opus-5-5", "--urgent")
        e.core("tick")
        self.assertNotEqual(e.job(4)["status"], "queued", "--urgent skips the pause")

    def test_budget_reads_usage_shapes(self):
        m = load_core_module(self.e.dir)
        self.assertEqual(m.max_utilisation({"session": {"pct": 42}, "weekly": {"pct": 85}})[0], 0.85)
        self.assertEqual(m.max_utilisation({"windows": [{"name": "five_hour", "utilization": 0.91}]})[0], 0.91)
        self.assertEqual(m.max_utilisation({"usedPercent": 12.5})[0], 0.125)
        self.assertIsNone(m.max_utilisation({"resetsAt": 123}))

    def test_rate_limit_feeds_budget(self):
        e = self.e
        e.env["FAKE_UTIL"] = "0.93"
        e.config({"budget": {"enabled": True, "opusDailyOutputTokens": 0, "usageCommand": False}})
        t = e.add()
        e.dispatch(t, "FAKE:ok\n", "--model", "claude-haiku-5-5")
        e.tick_until(lambda: e.job(1)["status"] == "finished", what="haiku")
        b = json.loads(e.core("budget", "--json").stdout)
        self.assertTrue(b["paused"])
        self.assertEqual(b["source"], "rate limit")
        self.assertIn("93%", b["detail"])

    def test_heartbeat_runs(self):
        e = self.e
        json.dump({"heartbeats": [
            {"id": "hb_health", "label": "Health", "everyMinutes": 180, "prompt": "Check health. FAKE:text=HEARTBEAT_OK", "enabled": True},
            {"id": "hb_scout", "label": "Scout", "at": "11:00", "prompt": "Scout. FAKE:text=Disk~is~95%~full", "enabled": True},
        ], "reminders": []}, open(os.path.join(e.dir, "schedule.json"), "w"))
        e.config({"heartbeats": {"enabled": True}})
        e.core("tick")   # baseline for everyMinutes: nothing fires yet
        self.assertEqual([j for j in e.jobs() if j["source"] == "beat" and j["beat_id"] == "hb_health"], [])
        e.core("beat", "hb_health")
        e.core("beat", "hb_scout")
        e.tick_until(lambda: all(j["status"] == "finished" for j in e.jobs()), what="beats")
        jobs = e.jobs()
        self.assertTrue(all(j["model"] == "claude-haiku-5-5" for j in jobs), "beats on the cheap tier")
        ev = [x for x in e.inbox() if x["kind"] == "heartbeat"]
        self.assertEqual(len(ev), 1, "only the beat with a finding reaches Mia")
        self.assertIn("Disk is 95% full", ev[0]["text"])
        self.assertIn("Scout", ev[0]["text"])
        p = e.calls()[0]["prompt"]
        self.assertIn("HEARTBEAT_OK", p)
        self.assertIn("Do not message Daniel", p)

    def test_legacy_path_unchanged_when_off(self):
        e = self.e
        e.config({"headless": False})
        tid = e.add()
        r = e.dispatch(tid, "Do it\n")
        self.assertEqual(r.stdout.strip(), "dispatch %s queued in %s" % (tid, e.work))
        self.assertTrue(os.path.exists(os.path.join(e.dir, "dispatch", tid + ".json")))
        self.assertFalse(os.path.exists(os.path.join(e.dir, "jobs.db")) and e.jobs())
        e.mia("tell", tid, "hello")
        self.assertTrue(os.path.exists(os.path.join(e.dir, "dispatch", tid + ".tell.json")))

    def test_single_instance(self):
        e = self.e
        p = subprocess.Popen([sys.executable, CORE, "run", "--interval", "0.5"], env=e.env,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            time.sleep(1.5)
            r = e.core("run", "--once", ok=False)
            self.assertEqual(r.returncode, 3)
            self.assertIn("already running", r.stderr)
            self.assertIn("running (pid %d)" % p.pid, e.core("status").stdout)
        finally:
            p.terminate()
            p.wait(10)
        self.assertFalse(os.path.exists(os.path.join(e.dir, "core.pid")))

    def test_config_cli(self):
        e = self.e
        e.mia("core", "config", "set", "nightMaxConcurrent", "2")
        e.mia("core", "config", "set", "budget.pauseAt", "0.7")
        c = json.loads(e.mia("core", "config", "get").stdout)
        self.assertEqual(c["nightMaxConcurrent"], 2)
        self.assertEqual(c["budget"]["pauseAt"], 0.7)
        self.assertEqual(c["budget"]["opusDailyOutputTokens"], 1500000, "defaults merged under")
        m = load_core_module(e.dir)
        cfg = m.merge(m.DEFAULTS, {"nightMaxConcurrent": 2, "night": {"from": "22:00", "to": "07:00"}})
        import datetime as dt
        at = lambda h: dt.datetime(2026, 10, 19, h, 0).timestamp()
        self.assertEqual(m.cap_now(cfg, at(23)), 2)
        self.assertEqual(m.cap_now(cfg, at(3)), 2)
        self.assertEqual(m.cap_now(cfg, at(12)), 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
