import { useEffect, useRef, useCallback } from 'react'
import * as d3 from 'd3'

const STATUS_COLOR = {
  leader:    '#ffd700',
  follower:  '#3a8fff',
  candidate: '#ff8c00',
  down:      '#ff3355',
}

const MSG_COLOR = {
  election:    '#ff8c00',
  coordinator: '#ffd700',
  ok:          '#00ff88',
  heartbeat:   '#3a8fff',
}

// stable position layout: fixed circle
function getPositions(count, cx, cy, r) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
  })
}

export default function NetworkGraph({ nodes, packets }) {
  const svgRef    = useRef(null)
  const nodesRef  = useRef(nodes)
  const packetsRef = useRef([])
  const rafRef    = useRef(null)
  const svgElRef  = useRef(null)
  const posRef    = useRef({})

  nodesRef.current = nodes

  // -- Draw static elements once --
  useEffect(() => {
    if (!svgRef.current || !nodes.length) return
    const container = svgRef.current
    const W = container.clientWidth
    const H = container.clientHeight
    const cx = W / 2, cy = H / 2
    const R  = Math.min(W, H) * 0.33

    d3.select(container).selectAll('*').remove()

    const svg = d3.select(container)
      .append('svg')
      .attr('width', W).attr('height', H)

    svgElRef.current = svg

    // grid
    const grid = svg.append('g')
    for (let x = 0; x < W; x += 40)
      grid.append('line').attr('x1',x).attr('y1',0).attr('x2',x).attr('y2',H)
        .attr('stroke','#1e3a5f').attr('stroke-width',0.4).attr('opacity',0.4)
    for (let y = 0; y < H; y += 40)
      grid.append('line').attr('x1',0).attr('y1',y).attr('x2',W).attr('y2',y)
        .attr('stroke','#1e3a5f').attr('stroke-width',0.4).attr('opacity',0.4)

    // defs
    const defs = svg.append('defs')
    const makeGlow = (id, blur=8) => {
      const f = defs.append('filter').attr('id', id)
      f.append('feGaussianBlur').attr('stdDeviation', blur).attr('result','blur')
      const m = f.append('feMerge')
      m.append('feMergeNode').attr('in','blur')
      m.append('feMergeNode').attr('in','SourceGraphic')
    }
    makeGlow('glow-leader', 12)
    makeGlow('glow-cand', 7)
    makeGlow('glow-pkt', 5)

    // arrowhead markers for each message type
    Object.entries(MSG_COLOR).forEach(([type, color]) => {
      defs.append('marker')
        .attr('id', `arrow-${type}`)
        .attr('markerWidth', 6).attr('markerHeight', 6)
        .attr('refX', 5).attr('refY', 3)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,0 L0,6 L6,3 z')
        .attr('fill', color)
    })

    const positions = getPositions(nodes.length, cx, cy, R)
    nodes.forEach((n, i) => { posRef.current[n.id] = positions[i] })

    // edge lines layer (between all pairs)
    const edgeLayer = svg.append('g').attr('class','edges')
    nodes.forEach((a, i) => {
      nodes.forEach((b, j) => {
        if (j <= i) return
        const pa = positions[i], pb = positions[j]
        edgeLayer.append('line')
          .attr('class', `edge-${a.id}-${b.id}`)
          .attr('x1', pa.x).attr('y1', pa.y)
          .attr('x2', pb.x).attr('y2', pb.y)
          .attr('stroke', '#1e3a5f')
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '4 4')
          .attr('opacity', 0.3)
      })
    })

    // packet layer (animated)
    svg.append('g').attr('class', 'packets')

    // node layer
    const nodeLayer = svg.append('g').attr('class', 'nodes')

    nodes.forEach((n, i) => {
      const { x, y } = positions[i]
      const g = nodeLayer.append('g')
        .attr('class', `node-g node-${n.id}`)
        .attr('transform', `translate(${x},${y})`)

      // outer pulse ring (candidate)
      g.append('circle').attr('class','pulse-ring')
        .attr('r', 44).attr('fill','none')
        .attr('stroke', STATUS_COLOR.candidate)
        .attr('stroke-width', 2).attr('opacity', 0)

      // leader orbit ring
      g.append('circle').attr('class','orbit-ring')
        .attr('r', 50).attr('fill','none')
        .attr('stroke', STATUS_COLOR.leader)
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '6 4')
        .attr('opacity', 0)

      // hex body
      const hexPts = d3.range(6).map(k => {
        const a = (Math.PI/3)*k - Math.PI/6
        return [36*Math.cos(a), 36*Math.sin(a)].join(',')
      }).join(' ')
      g.append('polygon').attr('class','hex-body')
        .attr('points', hexPts)
        .attr('fill', '#0d1520')
        .attr('stroke', STATUS_COLOR.follower)
        .attr('stroke-width', 2)

      // inner fill
      g.append('polygon').attr('class','hex-fill')
        .attr('points', hexPts)
        .attr('fill', STATUS_COLOR.follower)
        .attr('opacity', 0.1)

      // ID text
      g.append('text').attr('class','node-label')
        .attr('text-anchor','middle').attr('dy','-7px')
        .attr('font-family',"'Orbitron',sans-serif")
        .attr('font-size', 15).attr('font-weight', 700)
        .attr('fill', STATUS_COLOR.follower)
        .text(n.id)

      // status text
      g.append('text').attr('class','status-label')
        .attr('text-anchor','middle').attr('dy','10px')
        .attr('font-family',"'Share Tech Mono',monospace")
        .attr('font-size', 9).attr('letter-spacing', 2)
        .attr('fill', STATUS_COLOR.follower)
        .text('FOLLOWER')

      // leader marker: gold triangle pointing at the hex (hidden initially)
      g.append('polygon').attr('class','crown')
        .attr('points', '-6,-24 6,-24 0,-14')
        .attr('fill', STATUS_COLOR.leader)
        .attr('opacity', 0)

      // dead marker: red X drawn from two strokes (hidden initially)
      const deadX = g.append('g').attr('class','dead-x').attr('opacity', 0)
      deadX.append('line').attr('x1',-8).attr('y1',-8).attr('x2',8).attr('y2',8)
        .attr('stroke','#ff3355').attr('stroke-width',3).attr('stroke-linecap','round')
      deadX.append('line').attr('x1',8).attr('y1',-8).attr('x2',-8).attr('y2',8)
        .attr('stroke','#ff3355').attr('stroke-width',3).attr('stroke-linecap','round')
    })

    // legend
    const leg = svg.append('g').attr('transform',`translate(14,${H-100})`)
    const items = [
      ['LEADER',    STATUS_COLOR.leader],
      ['FOLLOWER',  STATUS_COLOR.follower],
      ['CANDIDATE', STATUS_COLOR.candidate],
      ['DOWN',      STATUS_COLOR.down],
    ]
    items.forEach(([label, color], i) => {
      const g = leg.append('g').attr('transform',`translate(0,${i*20})`)
      g.append('rect').attr('width',10).attr('height',10).attr('rx',2)
        .attr('fill', color+'33').attr('stroke', color).attr('stroke-width',1)
      g.append('text').attr('x',16).attr('y',9)
        .attr('font-family',"'Share Tech Mono',monospace")
        .attr('font-size',10).attr('letter-spacing',2).attr('fill',color)
        .text(label)
    })

    // msg type legend
    const msgLeg = svg.append('g').attr('transform',`translate(${W-130},${H-90})`)
    const msgItems = [
      ['ELECTION',    MSG_COLOR.election],
      ['COORDINATOR', MSG_COLOR.coordinator],
      ['OK',          MSG_COLOR.ok],
      ['HEARTBEAT',   MSG_COLOR.heartbeat],
    ]
    msgItems.forEach(([label, color], i) => {
      const g = msgLeg.append('g').attr('transform',`translate(0,${i*20})`)
      g.append('circle').attr('r',5).attr('cx',5).attr('cy',5)
        .attr('fill', color).attr('opacity',0.8)
      g.append('text').attr('x',16).attr('y',9)
        .attr('font-family',"'Share Tech Mono',monospace")
        .attr('font-size',9).attr('letter-spacing',1).attr('fill',color)
        .text(label)
    })

  }, [nodes.length]) // only rebuild if node count changes

  // -- Update node visuals when state changes --
  useEffect(() => {
    if (!svgElRef.current) return
    const svg = svgElRef.current

    nodes.forEach(n => {
      const g   = svg.select(`.node-${n.id}`)
      const col = n.alive ? (STATUS_COLOR[n.status] || '#5c7a99') : STATUS_COLOR.down
      const statusLabel = n.alive ? n.status.toUpperCase() : 'DOWN'

      g.select('.hex-body').attr('stroke', col)
        .attr('filter', n.status === 'leader' ? 'url(#glow-leader)' : n.status === 'candidate' ? 'url(#glow-cand)' : null)
      g.select('.hex-fill').attr('fill', col).attr('opacity', n.alive ? 0.12 : 0.04)
      g.select('.node-label').attr('fill', col)
      g.select('.status-label').attr('fill', col).text(statusLabel)
      g.select('.crown').attr('opacity', n.status === 'leader' ? 1 : 0)
      g.select('.dead-x').attr('opacity', !n.alive ? 0.6 : 0)
      g.select('.orbit-ring').attr('opacity', n.status === 'leader' ? 0.5 : 0)

      // candidate pulse animation
      const ring = g.select('.pulse-ring')
      if (n.status === 'candidate' && n.alive) {
        ring.attr('stroke', STATUS_COLOR.candidate)
        const doPulse = () => {
          ring.attr('r', 38).attr('opacity', 0.8)
            .transition().duration(900).ease(d3.easeCubicOut)
            .attr('r', 60).attr('opacity', 0)
            .on('end', doPulse)
        }
        if (ring.attr('opacity') === '0') doPulse()
      } else {
        ring.interrupt().attr('opacity', 0)
      }
    })
  }, [nodes])

  // -- Animate packets --
  useEffect(() => {
    if (!packets || !packets.length) return
    if (!svgElRef.current) return

    const svg    = svgElRef.current
    const pLayer = svg.select('.packets')
    const pos    = posRef.current

    packets.forEach(pkt => {
      const from = pos[pkt.from]
      const to   = pos[pkt.to]
      if (!from || !to) return

      // draw a trail line that fades
      const line = pLayer.append('line')
        .attr('x1', from.x).attr('y1', from.y)
        .attr('x2', from.x).attr('y2', from.y)
        .attr('stroke', pkt.color || '#fff')
        .attr('stroke-width', 1.5)
        .attr('opacity', 0.4)
        .attr('stroke-dasharray', '3 3')

      line.transition().duration(1200).ease(d3.easeLinear)
        .attr('x2', to.x).attr('y2', to.y)
        .transition().duration(400)
        .attr('opacity', 0)
        .remove()

      // draw the packet dot
      const dot = pLayer.append('circle')
        .attr('cx', from.x).attr('cy', from.y)
        .attr('r', 6)
        .attr('fill', pkt.color || '#fff')
        .attr('filter', 'url(#glow-pkt)')
        .attr('opacity', 1)

      dot.transition().duration(1200).ease(d3.easeLinear)
        .attr('cx', to.x).attr('cy', to.y)
        .on('end', function() {
          d3.select(this)
            .transition().duration(300)
            .attr('r', 14).attr('opacity', 0)
            .remove()
        })

      // label on the packet
      const dx = to.x - from.x, dy = to.y - from.y
      const dist = Math.sqrt(dx*dx + dy*dy)
      const mx = from.x + dx * 0.5, my = from.y + dy * 0.5 - 12

      const txt = pLayer.append('text')
        .attr('x', from.x).attr('y', from.y - 12)
        .attr('text-anchor', 'middle')
        .attr('font-family', "'Share Tech Mono',monospace")
        .attr('font-size', 9).attr('letter-spacing', 1)
        .attr('fill', pkt.color || '#fff')
        .attr('opacity', 0)
        .text(pkt.label)

      txt.transition().duration(200).attr('opacity', 1)
        .transition().duration(800).ease(d3.easeLinear)
        .attr('x', mx).attr('y', my)
        .transition().duration(300).attr('opacity', 0).remove()
    })
  }, [packets])

  return <div ref={svgRef} style={{ width:'100%', height:'100%' }} />
}
