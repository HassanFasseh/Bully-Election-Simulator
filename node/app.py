import os
import time
import threading
import random
import logging
import requests
from flask import Flask, jsonify, request, Response
from flask_cors import CORS
from datetime import datetime
import json
from collections import deque

# -- Config -------------------------------------------------------------------
NODE_ID       = int(os.environ.get("NODE_ID", 1))
ALL_NODES_ENV = os.environ.get("ALL_NODES", "")
HEARTBEAT_INT = float(os.environ.get("HEARTBEAT_INTERVAL", 3))
TIMEOUT       = float(os.environ.get("REQUEST_TIMEOUT", 2))
LATENCY_MAX   = float(os.environ.get("MAX_LATENCY_MS", 200)) / 1000
PORT          = int(os.environ.get("PORT", 5000))

ALL_IDS = [int(x) for x in ALL_NODES_ENV.split(",") if x.strip()]

def node_url(nid):
    return f"http://node{nid}:{PORT}"

# -- State ------------------------------------------------------------------
state = {
    "id":                   NODE_ID,
    "leader":               None,
    "status":               "follower",
    "alive":                True,
    "election_in_progress": False,
    "logs":                 [],
    "messages":             deque(maxlen=100),
}
state_lock = threading.Lock()

sse_clients = []
sse_lock = threading.Lock()

app = Flask(__name__)
CORS(app)

logging.basicConfig(
    level=logging.INFO,
    format=f"[Node {NODE_ID}] %(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# -- Emit helpers ---------------------------------------------------------------
def emit_log(msg, kind="info"):
    ts = datetime.utcnow().strftime("%H:%M:%S")
    entry = {"ts": ts, "node": NODE_ID, "msg": msg, "kind": kind}
    with state_lock:
        state["logs"].append(entry)
        if len(state["logs"]) > 200:
            state["logs"].pop(0)
    log.info(msg)

def emit_message(msg_type, to_node, label=""):
    colors = {
        "election":    "#ff8c00",
        "coordinator": "#ffd700",
        "ok":          "#00ff88",
        "heartbeat":   "#3a8fff",
    }
    event = {
        "ts":    datetime.utcnow().isoformat(),
        "from":  NODE_ID,
        "to":    to_node,
        "type":  msg_type,
        "label": label or msg_type.upper(),
        "color": colors.get(msg_type, "#c8d8ea"),
    }
    with state_lock:
        state["messages"].append(event)
    push_sse(event)

def push_sse(data):
    payload = "data: " + json.dumps(data) + "\n\n"
    with sse_lock:
        dead = []
        for q in sse_clients:
            try:
                q.put_nowait(payload)
            except Exception:
                dead.append(q)
        for q in dead:
            sse_clients.remove(q)

# -- HTTP helpers -------------------------------------------------------------
def simulated_latency():
    if LATENCY_MAX > 0:
        time.sleep(random.uniform(0, LATENCY_MAX))

def higher_nodes():
    return [nid for nid in ALL_IDS if nid > NODE_ID]

def other_nodes():
    return [nid for nid in ALL_IDS if nid != NODE_ID]

# -- Election logic ---------------------------------------------------------
def start_election():
    with state_lock:
        if not state["alive"]:
            return
        state["election_in_progress"] = True
        state["status"] = "candidate"
        state["leader"] = None

    emit_log(f"Starting election (I am node {NODE_ID})", "election")

    higher = higher_nodes()
    if not higher:
        with state_lock:
            state["leader"] = NODE_ID
            state["status"] = "leader"
            state["election_in_progress"] = False
        emit_log(f"I am the new leader (node {NODE_ID}); no higher nodes exist", "leader")
        broadcast_coordinator()
        return

    higherAlive = []
    threads = []

    def probe(nid):
        emit_message("election", nid, "ELECTION")
        r = None
        for attempt in range(2):
            try:
                simulated_latency()
                r = requests.post(
                    f"{node_url(nid)}/election",
                    json={"from": NODE_ID},
                    timeout=TIMEOUT
                )
                break
            except Exception:
                if attempt == 0:
                    time.sleep(0.2)
        if r and r.status_code == 200:
            higherAlive.append(nid)
            emit_message("ok", nid, "OK")
            emit_log(f"Node {nid} responded OK to our election", "info")

    for nid in higher:
        t = threading.Thread(target=probe, args=(nid,), daemon=True)
        threads.append(t)
        t.start()

    for t in threads:
        t.join(timeout=TIMEOUT + 1)

    with state_lock:
        if not state["alive"]:
            state["election_in_progress"] = False
            return

    if not higherAlive:
        with state_lock:
            state["leader"] = NODE_ID
            state["status"] = "leader"
            state["election_in_progress"] = False
        emit_log(f"I am the new leader (node {NODE_ID}); no response from higher nodes", "leader")
        broadcast_coordinator()
    else:
        emit_log(f"Higher node(s) {higherAlive} are alive; waiting for coordinator", "info")
        def timeout_fallback():
            time.sleep(TIMEOUT * 4)
            with state_lock:
                if state["election_in_progress"] and state["alive"]:
                    state["election_in_progress"] = False
                    if state["status"] == "candidate":
                        state["status"] = "follower"
        threading.Thread(target=timeout_fallback, daemon=True).start()

def broadcast_coordinator():
    emit_log(f"Broadcasting coordinator = node {NODE_ID} to all peers", "coordinator")
    for nid in other_nodes():
        def send(n=nid):
            emit_message("coordinator", n, "COORDINATOR")
            simulated_latency()
            try:
                requests.post(
                    f"{node_url(n)}/coordinator",
                    json={"leader": NODE_ID},
                    timeout=TIMEOUT
                )
            except Exception:
                pass
        threading.Thread(target=send, daemon=True).start()

# -- Heartbeat -------------------------------------------------------------
def heartbeat_loop():
    time.sleep(HEARTBEAT_INT)
    while True:
        time.sleep(HEARTBEAT_INT)
        with state_lock:
            alive   = state["alive"]
            leader  = state["leader"]
            status  = state["status"]
            in_elec = state["election_in_progress"]

        if not alive or status == "leader" or in_elec:
            continue

        if leader is None:
            emit_log("No leader known; starting election", "election")
            threading.Thread(target=start_election, daemon=True).start()
            continue

        emit_message("heartbeat", leader, "PING")
        try:
            r = requests.get(f"{node_url(leader)}/status", timeout=TIMEOUT)
            if r.status_code != 200:
                raise Exception("bad status")
            data = r.json()
            if not data.get("alive", True):
                raise Exception("leader reports down")
        except Exception:
            emit_log(f"Leader node {leader} is unreachable; starting election", "failure")
            with state_lock:
                state["leader"] = None
            threading.Thread(target=start_election, daemon=True).start()

# -- Routes --------------------------------------------------------------
@app.before_request
def check_alive():
    with state_lock:
        alive = state["alive"]
    if not alive and request.path not in ("/recover", "/status", "/events"):
        return jsonify({"error": "node is down"}), 503

@app.route("/status", methods=["GET"])
def status():
    with state_lock:
        return jsonify({
            "id":       state["id"],
            "leader":   state["leader"],
            "status":   state["status"] if state["alive"] else "down",
            "alive":    state["alive"],
            "logs":     list(state["logs"])[-50:],
            "messages": list(state["messages"])[-20:],
        })

@app.route("/events", methods=["GET"])
def events():
    import queue
    q = queue.Queue(maxsize=50)
    with sse_lock:
        sse_clients.append(q)

    def generate():
        yield "data: " + json.dumps({"type": "connected", "node": NODE_ID}) + "\n\n"
        try:
            while True:
                try:
                    msg = q.get(timeout=15)
                    yield msg
                except Exception:
                    yield "data: " + json.dumps({"type": "ping"}) + "\n\n"
        except GeneratorExit:
            pass
        finally:
            with sse_lock:
                if q in sse_clients:
                    sse_clients.remove(q)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

@app.route("/election", methods=["POST"])
def election():
    data   = request.json or {}
    caller = data.get("from")
    emit_log(f"Received election from node {caller}; I have a higher ID, taking over", "election")
    threading.Thread(target=start_election, daemon=True).start()
    return jsonify({"ok": True, "from": NODE_ID}), 200

@app.route("/coordinator", methods=["POST"])
def coordinator():
    data   = request.json or {}
    leader = data.get("leader")
    with state_lock:
        state["leader"]               = leader
        state["election_in_progress"] = False
        state["status"]               = "leader" if leader == NODE_ID else "follower"
    emit_log(f"New coordinator announced: node {leader}", "coordinator")
    return jsonify({"ok": True}), 200

@app.route("/ok", methods=["POST"])
def ok_route():
    return jsonify({"ok": True}), 200

@app.route("/shutdown", methods=["POST"])
def shutdown():
    with state_lock:
        state["alive"]               = False
        state["status"]              = "down"
        state["election_in_progress"] = False
        state["leader"]              = None
    emit_log(f"Node {NODE_ID} is going down", "failure")
    return jsonify({"ok": True}), 200

@app.route("/recover", methods=["POST"])
def recover():
    with state_lock:
        state["alive"]               = True
        state["election_in_progress"] = False
        state["status"]              = "follower"
        state["leader"]              = None
    emit_log(f"Node {NODE_ID} is back online", "recovered")
    return jsonify({"ok": True}), 200

@app.route("/trigger-election", methods=["POST"])
def trigger_election():
    emit_log(f"Manual election triggered on node {NODE_ID}", "election")
    with state_lock:
        state["election_in_progress"] = False
        state["status"]              = "candidate"
        state["leader"]              = None
    threading.Thread(target=start_election, daemon=True).start()
    return jsonify({"ok": True}), 200

# -- Bootstrap -----------------------------------------------------------
if __name__ == "__main__":
    emit_log(f"Node {NODE_ID} starting; peers: {ALL_IDS}", "info")

    def boot_election():
        time.sleep(3 + random.uniform(0, 2))
        emit_log("Boot election starting", "election")
        start_election()

    threading.Thread(target=boot_election, daemon=True).start()
    threading.Thread(target=heartbeat_loop, daemon=True).start()

    app.run(host="0.0.0.0", port=PORT, threaded=True)
