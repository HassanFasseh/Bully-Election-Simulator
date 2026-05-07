import { useState, useEffect, useRef, useCallback } from 'react'
import NetworkGraph from './NetworkGraph.jsx'
import './App.css'

const NODE_COUNT = parseInt(import.meta.env.VITE_NODE_COUNT || '5')
const POLL_MS    = 1500

function nodeUrl(id) { return `/api/node${id}` }

const STATUS_COLOR = {
  leader:    'var(--leader)',
  follower:  'var(--follower)',
  candidate: 'var(--candidate)',
  down:      'var(--down)',
}

// Log lines carry a `kind` from the backend; colour the event log by it.
const LOG_COLOR = {
  leader:      'var(--leader)',
  election:    'var(--candidate)',
  failure:     'var(--down)',
  recovered:   'var(--green)',
  coordinator: 'var(--accent)',
  info:        'var(--text-dim)',
}

const allIds = Array.from({ length: NODE_COUNT }, (_, i) => i + 1)

function mergeEvents(nodesData, prev) {
  const fresh = []
  for (const nd of nodesData) {
    for (const e of (nd?.logs || [])) {
      const key = `${e.node}-${e.ts}-${e.msg}`
      fresh.push({ ...e, key })
    }
  }
  const seen = new Set(prev.map(e => e.key))
  const newEntries = fresh.filter(e => !seen.has(e.key))
  return [...prev, ...newEntries].slice(-400)
}

// -- App --
export default function App() {
  const [nodes,      setNodes]      = useState([])
  const [events,     setEvents]     = useState([])
  const [packets,    setPackets]    = useState([])
  const [activeTab,  setActiveTab]  = useState('graph')
  const [loading,    setLoading]    = useState(true)
  const logRef   = useRef(null)
  const esRefs   = useRef({})   // EventSource per node

  // -- Polling --
  const fetchAll = useCallback(async () => {
    const results = await Promise.all(
      allIds.map(async id => {
        try {
          const r = await fetch(`${nodeUrl(id)}/status`, { signal: AbortSignal.timeout(2000) })
          if (!r.ok) return { id, alive: false, status: 'down', leader: null, logs: [] }
          return await r.json()
        } catch {
          return { id, alive: false, status: 'down', leader: null, logs: [] }
        }
      })
    )
    setNodes(results)
    setEvents(prev => mergeEvents(results, prev))
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchAll()
    const t = setInterval(fetchAll, POLL_MS)
    return () => clearInterval(t)
  }, [fetchAll])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [events])

  // -- SSE streams for packet animation --
  useEffect(() => {
    // close old streams
    Object.values(esRefs.current).forEach(es => es.close())
    esRefs.current = {}

    allIds.forEach(id => {
      const es = new EventSource(`${nodeUrl(id)}/events`)
      esRefs.current[id] = es

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data.type === 'ping' || data.type === 'connected') return
          // It's a message packet; animate it
          const pkt = {
            ...data,
            id: `${data.from}-${data.to}-${data.ts}-${Math.random()}`,
          }
          setPackets(prev => [...prev.slice(-30), pkt])
          // auto-clear after animation completes
          setTimeout(() => {
            setPackets(prev => prev.filter(p => p.id !== pkt.id))
          }, 2000)
        } catch {}
      }
      es.onerror = () => {}
    })

    return () => Object.values(esRefs.current).forEach(es => es.close())
  }, [])

  async function apiCall(id, endpoint) {
    try {
      await fetch(`${nodeUrl(id)}${endpoint}`, { method: 'POST' })
      setTimeout(fetchAll, 300)
      setTimeout(fetchAll, 900)
    } catch {}
  }

  const leader     = nodes.find(n => n.status === 'leader')
  const aliveCount = nodes.filter(n => n.alive).length

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className="logo-mark">B</div>
          <div>
            <h1 className="title">BULLY</h1>
            <p className="subtitle">Distributed leader election, visualized in real time</p>
          </div>
        </div>
        <div className="header-stats">
          <Stat label="NODES ALIVE" value={`${aliveCount}/${NODE_COUNT}`} color="var(--accent)" />
          <Stat label="CURRENT LEADER" value={leader ? `NODE ${leader.id}` : 'ELECTING'} color="var(--leader)" />
          <Stat label="EVENTS" value={events.length} color="var(--green)" />
          <div className="pulse-dot" />
        </div>
      </header>

      {/* Message type legend strip */}
      <div className="msg-strip">
        <MsgBadge color="#ff8c00" label="ELECTION" desc="Sent to higher nodes to start an election" />
        <MsgBadge color="#00ff88" label="OK" desc="Higher node acknowledges and takes over" />
        <MsgBadge color="#ffd700" label="COORDINATOR" desc="Broadcast: new leader announced" />
        <MsgBadge color="#3a8fff" label="HEARTBEAT" desc="Follower pings leader periodically" />
      </div>

      <main className="main">
        {/* Sidebar */}
        <section className="sidebar">
          <div className="section-title">CLUSTER NODES</div>
          {loading ? (
            <div className="loading">Connecting</div>
          ) : (
            <div className="node-list">
              {nodes.map(nd => (
                <NodeCard
                  key={nd.id} node={nd}
                  onShutdown={() => apiCall(nd.id, '/shutdown')}
                  onRecover ={() => apiCall(nd.id, '/recover')}
                  onElect   ={() => apiCall(nd.id, '/trigger-election')}
                />
              ))}
            </div>
          )}
        </section>

        {/* Panel */}
        <section className="panel">
          <div className="tabs">
            <button className={`tab ${activeTab==='graph'?'active':''}`} onClick={()=>setActiveTab('graph')}>
              LIVE TOPOLOGY
            </button>
            <button className={`tab ${activeTab==='logs'?'active':''}`} onClick={()=>setActiveTab('logs')}>
              EVENT LOG
            </button>
          </div>

          {activeTab === 'graph' && (
            <div className="graph-wrap">
              {nodes.length > 0 && (
                <NetworkGraph nodes={nodes} packets={packets} />
              )}
              <div className="graph-hint">
                Messages animate between nodes in real time
              </div>
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="log-wrap" ref={logRef}>
              {events.length === 0 && <div className="log-empty">Waiting for events</div>}
              {[...events].reverse().map((e, i) => (
                <LogLine key={e.key + i} event={e} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

// -- Sub-components --
function Stat({ label, value, color }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={{ color }}>{value}</span>
    </div>
  )
}

function MsgBadge({ color, label, desc }) {
  return (
    <div className="msg-badge" title={desc}>
      <span className="msg-dot" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      <span className="msg-label" style={{ color }}>{label}</span>
      <span className="msg-desc">{desc}</span>
    </div>
  )
}

function NodeCard({ node, onShutdown, onRecover, onElect }) {
  const color = STATUS_COLOR[node.status] || 'var(--text-dim)'
  const isDown = !node.alive

  return (
    <div className={`node-card ${node.status}`}>
      <div className="node-card-header">
        <div className="node-id-badge" style={{ borderColor: color, color }}>
          NODE {node.id}
        </div>
        <div className="node-status-pill" style={{ background: color+'22', color }}>
          {node.status.toUpperCase()}
        </div>
      </div>

      <div className="node-meta">
        <span className="meta-label">LEADER</span>
        <span className="meta-value" style={{ color:'var(--leader)' }}>
          {node.leader != null ? `NODE ${node.leader}` : '-'}
        </span>
      </div>

      {node.status === 'leader' && <div className="leader-crown">ELECTED LEADER</div>}

      <div className="node-actions">
        {!isDown ? (
          <>
            <button className="btn btn-danger" onClick={onShutdown} title="Simulate crash">KILL</button>
            <button className="btn btn-warn"   onClick={onElect}    title="Force election from this node">ELECT</button>
          </>
        ) : (
          <button className="btn btn-green" onClick={onRecover} title="Bring node back online">RECOVER</button>
        )}
      </div>
    </div>
  )
}

function LogLine({ event }) {
  const color = LOG_COLOR[event.kind] || 'var(--text)'
  return (
    <div className="log-line" style={{ borderLeftColor: color }}>
      <span className="log-ts">{event.ts}</span>
      <span className="log-node" style={{ color:'var(--accent2)' }}>N{event.node}</span>
      <span className="log-msg" style={{ color }}>{event.msg}</span>
    </div>
  )
}
