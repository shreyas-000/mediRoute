'use client'
import { useEffect, useRef, useState, useMemo, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { astar } from '@/lib/pathfinding/astar'
import { bearing, distanceM } from '@/lib/utils'
import { createXRTracker } from '@/lib/ar/tracking'
import { speakCue } from '@/lib/voice/speech'
import type { Graph, GraphEdge, Profile } from '@/types'

const NODE_ARRIVAL_THRESHOLD_M = 3 // 3 meters to consider arrived at a node

function NavigateContent() {
  const params = useSearchParams()
  const hospitalId = params.get('hospitalId')!
  const startNodeId = params.get('startNodeId')!
  const startX = parseFloat(params.get('startX')!)
  const startY = parseFloat(params.get('startY')!)
  const startFloor = parseInt(params.get('startFloor')!)
  const destNodeId = params.get('dest')!
  const profile = (params.get('profile') ?? 'standard') as Profile

  const [graph, setGraph] = useState<Graph | null>(null)
  const [route, setRoute] = useState<GraphEdge[]>([])
  const [currentX, setCurrentX] = useState(startX)
  const [currentY, setCurrentY] = useState(startY)
  const [currentFloor, setCurrentFloor] = useState(startFloor)
  const [routeIndex, setRouteIndex] = useState(0) // which edge we're currently on
  const [xrSupported, setXrSupported] = useState<boolean | null>(null)
  const [arSessionActive, setArSessionActive] = useState(false)
  const [arrived, setArrived] = useState(false)
  const [heading, setHeading] = useState(0)

  const overlayRef = useRef<HTMLDivElement>(null)
  const xrTrackerRef = useRef(createXRTracker())

  // Load graph
  useEffect(() => {
    if (!hospitalId || !startNodeId || !destNodeId) return

    const cacheKey = `graph:${hospitalId}`
    const cached = sessionStorage.getItem(cacheKey)

    const resolveGraph: Promise<Graph> = cached
      ? Promise.resolve(JSON.parse(cached))
      : fetch(`/api/hospital/${hospitalId}/graph`)
          .then(r => r.json())
          .then(g => {
            sessionStorage.setItem(cacheKey, JSON.stringify(g))
            return g
          })

    resolveGraph.then((g: Graph) => {
      setGraph(g)
      const edges = astar(g, startNodeId, destNodeId, profile)
      setRoute(edges ?? [])
      
      const destNode = g.nodes[destNodeId]
      if (destNode && edges && edges.length > 0) {
        speakCue(`Navigating to ${destNode.label}. Route found.`)
      }
    })
  }, [hospitalId, startNodeId, destNodeId, profile])

  // Check WebXR support
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.xr) {
      navigator.xr.isSessionSupported('immersive-ar').then(setXrSupported)
    } else {
      setXrSupported(false)
    }
  }, [])

  // Node arrival detection
  useEffect(() => {
    if (!graph || route.length === 0 || arrived) return
    const currentEdge = route[routeIndex]
    if (!currentEdge) return

    const nextNode = graph.nodes[currentEdge.toNode]
    if (!nextNode) return

    // If on a different floor (e.g. elevator edge), wait for user to confirm floor change
    if (nextNode.floor !== currentFloor) return

    const dist = distanceM(currentX, currentY, nextNode.x, nextNode.y)
    if (dist < NODE_ARRIVAL_THRESHOLD_M) {
      if (routeIndex === route.length - 1) {
        setArrived(true)
        speakCue('You have arrived at your destination.')
      } else {
        setCurrentX(nextNode.x)
        setCurrentY(nextNode.y)
        setCurrentFloor(nextNode.floor)
        setRouteIndex(i => i + 1)
        const nextEdge = route[routeIndex + 1]
        if (nextEdge?.landmark) {
          speakCue(`Continue, then ${nextEdge.landmark}`)
        }
      }
    }
  }, [currentX, currentY, currentFloor, routeIndex, route, graph, arrived])

  async function startAR() {
    if (!navigator.xr || !overlayRef.current) return

    try {
      const session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['dom-overlay'],
        domOverlay: { root: overlayRef.current },
      })

      setArSessionActive(true)

      session.addEventListener('end', () => {
        setArSessionActive(false)
      })

      // Start render loop
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2', { xrCompatible: true })
      if (!gl) throw new Error('WebGL2 not supported')
      
      await gl.makeXRCompatible()
      session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) })

      const refSpace = await session.requestReferenceSpace('local')

      // Calibrate tracker with the starting anchor position
      session.requestAnimationFrame(function firstFrame(time, xrFrame) {
        const pose = xrFrame.getViewerPose(refSpace)
        if (pose) {
          xrTrackerRef.current.recalibrate(
            { x: startX, y: startY, floor: startFloor },
            pose
          )
        }
      })

      session.requestAnimationFrame(function frame(time, xrFrame) {
        // Keep loop going if session active
        if (session.visibilityState !== 'hidden') {
          session.requestAnimationFrame(frame)
        }

        const pose = xrFrame.getViewerPose(refSpace)
        if (!pose) return

        const worldPos = xrTrackerRef.current.getWorldPosition(pose)
        const h = xrTrackerRef.current.getHeading(pose)

        setCurrentX(worldPos.x)
        setCurrentY(worldPos.y)
        setHeading(h)
      })
    } catch (err) {
      console.error('Failed to start AR session:', err)
      alert('Failed to start AR session. Please make sure you are using Chrome on an ARCore-supported Android device.')
    }
  }

  // --- Derived render state ---
  const currentEdge = route[routeIndex]
  const nextNode = currentEdge ? graph?.nodes[currentEdge.toNode] : null
  const destNode = graph?.nodes[destNodeId]
  
  // Calculate remaining distance roughly by summing current edge + remaining edges
  const remainingDistM = useMemo(() => {
    if (!nextNode) return 0
    let dist = distanceM(currentX, currentY, nextNode.x, nextNode.y)
    for (let i = routeIndex + 1; i < route.length; i++) {
      dist += route[i].distanceM
    }
    return dist
  }, [currentX, currentY, nextNode, route, routeIndex])

  const arrowRotation = useMemo(() => {
    if (!nextNode) return 0
    const targetBearing = bearing(currentX, currentY, nextNode.x, nextNode.y)
    // Adjust device heading from compass. Our coordinate space: 0 = right (+x).
    const deviceBearingFromRight = heading - 90 
    return targetBearing - deviceBearingFromRight
  }, [nextNode, currentX, currentY, heading])

  function confirmFloorTransition() {
    if (!nextNode) return
    setCurrentFloor(nextNode.floor)
    setCurrentX(nextNode.x)
    setCurrentY(nextNode.y)
    setRouteIndex(i => i + 1)
    
    // Recalibrate tracker to new floor position so SLAM starts fresh here
    const currentWorldOrigin = { x: nextNode.x, y: nextNode.y, floor: nextNode.floor }
    // We cannot access xrFrame here directly outside of RAF, but tracking library 
    // will just keep deltas from whenever it recalibrated.
    // In a real robust system, we would ask user to scan a QR code out of the elevator.
    // For demo, we just update state and hope SLAM doesn't drift too much between floors.
    
    const nextEdge = route[routeIndex + 1]
    if (nextEdge?.landmark) {
      speakCue(`Continue, then ${nextEdge.landmark}`)
    }
  }

  if (xrSupported === null) {
    return <div className="min-h-screen bg-background flex items-center justify-center">Checking device compatibility...</div>
  }

  if (xrSupported === false) {
    return (
      <div className="min-h-screen bg-background p-8 flex flex-col items-center justify-center text-center">
        <h2 className="text-xl font-bold mb-4">AR Not Supported</h2>
        <p className="text-muted-foreground mb-4">Your device or browser does not support WebXR AR sessions.</p>
        <p className="text-sm">Please try using Google Chrome on an Android device.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background relative flex flex-col items-center justify-center overflow-hidden">
      
      {!arSessionActive ? (
        <div className="p-8 text-center max-w-sm w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
          <h1 className="text-2xl font-bold mb-2">Ready to Navigate</h1>
          <p className="text-muted-foreground mb-8">Follow the on-screen arrows to your destination.</p>
          
          <button
            onClick={startAR}
            className="w-full bg-primary text-primary-foreground py-4 rounded-2xl font-semibold text-lg shadow-lg hover:shadow-primary/20 transition-all active:scale-95"
          >
            Start AR Camera
          </button>
        </div>
      ) : null}

      {/* DOM Overlay container for WebXR */}
      <div 
        ref={overlayRef} 
        className="fixed inset-0 pointer-events-none"
        style={{ display: arSessionActive ? 'block' : 'none' }}
      >
        {/* Top HUD */}
        <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/80 to-transparent pt-12 pb-8 px-6 flex items-start justify-between pointer-events-none">
          <div>
            <p className="text-sm text-white/70 font-medium">Navigating to</p>
            <p className="font-bold text-xl text-white tracking-tight">{destNode?.label}</p>
          </div>
          <div className="text-right bg-black/40 backdrop-blur-md px-3 py-1.5 rounded-xl border border-white/10">
            <p className="text-xs text-white/70 font-medium">Floor {currentFloor}</p>
            <p className="font-bold text-lg text-white">{Math.round(remainingDistM)}m</p>
          </div>
        </div>

        {/* Directional Arrow */}
        {!arrived && !currentEdge?.isElevator && !currentEdge?.isStairs && (
          <div
            className="absolute inset-0 flex items-center justify-center pt-24"
            style={{ transform: `rotate(${arrowRotation}deg)`, transition: 'transform 0.15s ease-out' }}
          >
            <div className="w-24 h-24 bg-primary/90 backdrop-blur-xl rounded-full flex items-center justify-center shadow-[0_0_40px_rgba(var(--primary),0.6)] border border-white/20">
              <svg viewBox="0 0 24 24" className="w-12 h-12 text-white fill-current">
                <path d="M12 2L4 14h5v8h6v-8h5z" />
              </svg>
            </div>
          </div>
        )}

        {/* Landmarks / Voice Cues */}
        {currentEdge?.landmark && !arrived && !currentEdge?.isElevator && (
          <div className="absolute bottom-12 left-6 right-6">
            <div className="bg-black/80 backdrop-blur-xl text-white rounded-2xl px-6 py-5 border border-white/10 shadow-2xl">
              <p className="text-sm text-white/70 font-medium mb-1">Next instruction</p>
              <p className="font-semibold text-lg">{currentEdge.landmark}</p>
            </div>
          </div>
        )}

        {/* Elevator / Stairs transition */}
        {(currentEdge?.isElevator || currentEdge?.isStairs) && !arrived && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm pointer-events-auto">
            <div className="bg-background rounded-3xl p-8 mx-6 text-center border border-border max-w-sm w-full animate-in zoom-in-95 duration-300">
              <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <p className="text-4xl">{currentEdge.isElevator ? '🛗' : '🪜'}</p>
              </div>
              <p className="font-bold text-2xl mb-1">Take the {currentEdge.isElevator ? 'elevator' : 'stairs'}</p>
              <p className="text-muted-foreground mb-8">Go to Floor {nextNode?.floor}</p>
              <button
                onClick={confirmFloorTransition}
                className="w-full bg-primary text-primary-foreground font-semibold py-4 rounded-xl shadow-lg active:scale-95 transition-transform"
              >
                I'm on Floor {nextNode?.floor}
              </button>
            </div>
          </div>
        )}

        {/* Arrival Screen */}
        {arrived && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm pointer-events-auto">
            <div className="bg-background rounded-3xl p-8 mx-6 text-center border border-border max-w-sm w-full animate-in zoom-in-95 duration-300">
              <div className="w-20 h-20 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4 text-green-500">
                <svg viewBox="0 0 24 24" className="w-10 h-10 fill-current"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>
              </div>
              <p className="font-bold text-2xl mb-2">You have arrived</p>
              <p className="text-muted-foreground mb-8">You are now at {destNode?.label}.</p>
              <button
                onClick={() => window.location.href = '/'}
                className="w-full bg-secondary text-secondary-foreground font-semibold py-4 rounded-xl active:scale-95 transition-transform"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {/* Wheelchair Accessible Badge */}
        {profile === 'wheelchair' && (
          <div className="absolute top-24 left-6 bg-blue-500/20 text-blue-400 border border-blue-500/30 text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-lg">
            ♿ Accessible Route
          </div>
        )}
      </div>
    </div>
  )
}

export default function NavigatePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background flex items-center justify-center text-muted-foreground">Loading Navigation...</div>}>
      <NavigateContent />
    </Suspense>
  )
}
