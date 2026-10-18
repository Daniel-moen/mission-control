#!/usr/bin/env python3
# A stand-in for `claude -p --output-format stream-json` (task 0292 tests).
# Reads the prompt from stdin like the real one and behaves by keywords in it:
#   FAKE:ok          init, one assistant line, a success result (the default)
#   FAKE:die         init, then exit 1 without a result (a crash)
#   FAKE:predie      exit 1 before even the init line (session never started)
#   FAKE:error       a result with is_error (an API failure)
#   FAKE:sleep=<s>   work that long before the result
#   FAKE:server      start a child `sleep 300`, register it in $MIA_RUN_PIDFILE
#   FAKE:linger      after the result, stay alive (a background shell)
#   FAKE:report=<id> write briefs/<id>.report.md under $MIA_DIR
#   FAKE:text=<word> the result text, ~ for spaces (default DONE)
#   FAKE:opus        bill the usage to an Opus model (budget tests)
# A run with --resume of a session it never saw fails like the real one.
# Every call is appended to $FAKE_CLAUDE_LOG as one JSON line.
import json, os, re, subprocess, sys, time, uuid

args = sys.argv[1:]
prompt = sys.stdin.read()


def opt(name):
    return args[args.index(name) + 1] if name in args else None


sid = opt("--session-id") or opt("--resume") or str(uuid.uuid4())
model = opt("--model") or "claude-default"
state = os.environ.get("FAKE_CLAUDE_STATE") or os.path.join(os.environ.get("MIA_DIR", "/tmp"), "fake-sessions")
os.makedirs(state, exist_ok=True)
log = os.environ.get("FAKE_CLAUDE_LOG")
if log:
    with open(log, "a") as f:
        f.write(json.dumps({"args": args, "prompt": prompt, "pid": os.getpid(), "cwd": os.getcwd(),
                            "env": {k: os.environ.get(k) for k in ("MIA_TASK_ID", "MIA_JOB_ID",
                                                                   "MIA_RUN_PIDFILE", "CLAUDECODE")}}) + "\n")


def out(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


def result(is_error=False, text="DONE", errors=None):
    m = "claude-opus-5-5" if "FAKE:opus" in prompt else model
    o = {"type": "result", "subtype": "error_during_execution" if is_error else "success",
         "is_error": is_error, "session_id": sid, "result": text, "num_turns": 2,
         "total_cost_usd": 0.01, "usage": {"input_tokens": 10, "cache_creation_input_tokens": 100,
                                            "cache_read_input_tokens": 1000, "output_tokens": 500},
         "modelUsage": {m: {"outputTokens": 500, "inputTokens": 10, "costUSD": 0.01}}}
    if errors:
        o["errors"] = errors
    out(o)


if "--resume" in args and not os.path.exists(os.path.join(state, sid)):
    result(True, "", ["No conversation found with session ID: %s" % sid])
    sys.exit(1)
if "FAKE:predie" in prompt and "--resume" not in args:
    sys.stderr.write("boom before init\n")
    sys.exit(1)
sp = os.path.join(state, sid)
orig = open(sp).read() if os.path.exists(sp) else ""
if not orig:
    with open(sp, "w") as f:
        f.write(prompt)
prompt = orig + "\n" + prompt if orig else prompt   # a resumed run keeps the first run's flags
out({"type": "system", "subtype": "init", "session_id": sid, "model": model, "cwd": os.getcwd()})
out({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "unifiedWindows": {
    "five_hour": {"utilization": float(os.environ.get("FAKE_UTIL", "0.2")), "resetsAt": int(time.time()) + 3600}}}})
out({"type": "assistant", "message": {"model": model, "content": [
    {"type": "tool_use", "name": "Bash", "input": {"command": "echo working"}}]}, "session_id": sid})
m = re.search(r"FAKE:sleep=([\d.]+)", prompt)
if m:
    time.sleep(float(m.group(1)))
if "FAKE:server" in prompt:
    child = subprocess.Popen(["sleep", "300"])
    with open(os.environ["MIA_RUN_PIDFILE"], "a") as f:
        f.write("%d\n" % child.pid)
m = re.search(r"FAKE:report=(\d+)", prompt)
if m:
    with open(os.path.join(os.environ["MIA_DIR"], "briefs", m.group(1) + ".report.md"), "w") as f:
        f.write("report\n")
if "FAKE:die" in prompt and "--resume" not in args:
    sys.exit(1)
if "FAKE:die-always" in prompt:
    sys.exit(1)
m = re.search(r"FAKE:text=(\S+)", prompt)
text = m.group(1).replace("~", " ") if m else "DONE"
if "FAKE:error" in prompt and "--resume" not in args:
    result(True, "API Error: 529 overloaded")
    sys.exit(1)
out({"type": "assistant", "message": {"model": model, "content": [{"type": "text", "text": text}]},
     "session_id": sid})
result(False, text)
if "FAKE:linger" in prompt:
    time.sleep(300)
