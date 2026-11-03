import * as THREE from 'three'
import type { GraphNodeType } from '@shared/graph'
import {
  FLOW_PARTICLE_COLOR,
  FLOW_PARTICLE_MAX,
  FLOW_PARTICLE_SIZE,
  FLOW_PARTICLES_PER_LINK,
  FLOW_SPEED_RANGE,
  GRID_DIVISIONS,
  GRID_OPACITY,
  GRID_SIZE_MAX,
  GRID_SIZE_MIN,
  GRID_Y_OFFSET,
  HUD,
  STARFIELD_COLOR,
  STARFIELD_COUNT,
  STARFIELD_OPACITY,
  STARFIELD_RADIUS,
  STARFIELD_ROTATE_SPEED,
  STARFIELD_SIZE,
  rgba
} from '@renderer/lib/graphTheme'

/**
 * Three.js scene effects for the Memory Nebula's J.A.R.V.I.S. tactical HUD.
 *
 * `NebulaGraph.tsx` stays focused on React state, force-graph plumbing and the
 * DOM label layer; every *decorative* Three.js object lives here instead:
 *
 * - `glowTexture` — cached additive radial halo textures (one per node colour);
 * - `shellLineGeometry`/`coreSphereGeometry`/`haloRingGeometry` — cached unit
 *   geometries so every node shares buffers (8–10 geometries for the whole
 *   graph, never one per node);
 * - `GridFloor` — the holographic holo-table grid parked under the graph, rebuilt
 *   when the simulation settles / the graph scope changes and disposed properly;
 * - `Starfield` — a static, never-raycast decorative star shell;
 * - `FlowParticles` — one `THREE.Points` with white light packets running along
 *   the links (reference demo's 流光).
 *
 * Everything is deterministic (FNV-1a string hashing + seeded PRNG) so the same
 * graph always produces the same looking HUD. Geometry/texture caches are
 * module-level and bounded: they are intentionally *not* disposed on component
 * unmount because their key space is fixed (6 node types × 2 detail levels),
 * which also keeps React StrictMode's mount → unmount → mount cycle from having
 * to rebuild GPU resources. Per-instance objects (grid/starfield/particles)
 * expose `dispose()` and are owned by the graph component.
 */

/* ------------------------------------------------------------ deterministic -- */

/** Deterministic FNV-1a hash → stable 0..1 unit value (survives re-renders). */
export function hashUnit(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4_294_967_296
}

/** Small deterministic PRNG (xorshift32) used by the starfield. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4_294_967_296
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t
}

/* ----------------------------------------------------------- glow textures -- */

/** Canvas resolution of the radial halo texture (bounded, reused per colour). */
const GLOW_TEXTURE_SIZE = 256

/** One additive halo texture per node colour; shared by every matching node. */
const glowTextures = new Map<string, THREE.Texture>()

/**
 * Soft additive glow disc.
 *
 * Brighter than a plain gaussian: a hot core plus a white specular pin makes the
 * nodes read as sparkling HUD lights instead of flat dim blobs (all additive, so
 * the deep-space background stays black).
 */
export function glowTexture(color: string): THREE.Texture {
  const cached = glowTextures.get(color)
  if (cached !== undefined) return cached

  const canvas = document.createElement('canvas')
  canvas.width = GLOW_TEXTURE_SIZE
  canvas.height = GLOW_TEXTURE_SIZE
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('2D canvas unavailable for the nebula glow texture')
  const center = GLOW_TEXTURE_SIZE / 2

  const gradient = context.createRadialGradient(center, center, 0, center, center, center)
  gradient.addColorStop(0, rgba(color, 1))
  gradient.addColorStop(0.12, rgba(color, 1))
  gradient.addColorStop(0.3, rgba(color, 0.68))
  gradient.addColorStop(0.56, rgba(color, 0.24))
  gradient.addColorStop(0.8, rgba(color, 0.06))
  gradient.addColorStop(1, rgba(color, 0))
  context.fillStyle = gradient
  context.fillRect(0, 0, GLOW_TEXTURE_SIZE, GLOW_TEXTURE_SIZE)

  // White-hot pinpoint in the middle: the "sparkle" highlight.
  const sparkle = context.createRadialGradient(
    center,
    center,
    0,
    center,
    center,
    center * 0.3
  )
  sparkle.addColorStop(0, 'rgba(255, 255, 255, 0.95)')
  sparkle.addColorStop(0.45, 'rgba(255, 255, 255, 0.35)')
  sparkle.addColorStop(1, 'rgba(255, 255, 255, 0)')
  context.fillStyle = sparkle
  context.fillRect(0, 0, GLOW_TEXTURE_SIZE, GLOW_TEXTURE_SIZE)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  glowTextures.set(color, texture)
  return texture
}

/* -------------------------------------------------------- node geometry -- */

/** 0 = performance mode (coarse), 1 = normal HUD detail. */
export type GeometryDetail = 0 | 1

const shellGeometries = new Map<string, THREE.BufferGeometry>()
const coreGeometries = new Map<string, THREE.BufferGeometry>()
let ringGeometry: THREE.BufferGeometry | null = null

/** Project/target/host are hubs → icosahedron; evidence → octahedron. */
function isStructuralShell(nodeType: GraphNodeType): boolean {
  return nodeType === 'project' || nodeType === 'target' || nodeType === 'host'
}

/**
 * Unit-radius `LineSegments` wireframe shell for a node.
 *
 * Built from `WireframeGeometry` (an explicit line buffer) instead of
 * `MeshBasicMaterial.wireframe`, so the HUD shell is a real line layer: it stays
 * hairline at every zoom level and can be drawn with additive blending without
 * the triangle-edge overdraw of a wireframe mesh. Callers scale the returned
 * geometry by `nodeRadius(node)`, which keeps one buffer per (type, detail).
 */
export function shellLineGeometry(nodeType: GraphNodeType, detail: GeometryDetail): THREE.BufferGeometry {
  const structural = isStructuralShell(nodeType)
  const key = structural ? `ico|${detail}` : 'octa'
  const cached = shellGeometries.get(key)
  if (cached !== undefined) return cached

  const source = structural
    ? new THREE.IcosahedronGeometry(1, detail)
    : new THREE.OctahedronGeometry(1, 0)
  const wireframe = new THREE.WireframeGeometry(source)
  // The solid source geometry only feeds WireframeGeometry; its buffers are gone.
  source.dispose()
  shellGeometries.set(key, wireframe)
  return wireframe
}

/** Unit-radius white-hot core sphere (segments drop in performance mode). */
export function coreSphereGeometry(detail: GeometryDetail): THREE.BufferGeometry {
  const key = detail === 1 ? 'high' : 'low'
  const cached = coreGeometries.get(key)
  if (cached !== undefined) return cached
  const segments = detail === 1 ? 18 : 10
  const geometry = new THREE.SphereGeometry(1, segments, segments)
  coreGeometries.set(key, geometry)
  return geometry
}

/**
 * Unit-radius ring used for the rotating selection halo and the snapshot outer
 * orbit ring (a `LineLoop` closes it automatically, so 96 points are enough).
 */
export function haloRingGeometry(): THREE.BufferGeometry {
  if (ringGeometry !== null) return ringGeometry
  const segments = 96
  const positions = new Float32Array(segments * 3)
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2
    positions[index * 3] = Math.cos(angle)
    positions[index * 3 + 1] = Math.sin(angle)
    positions[index * 3 + 2] = 0
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  ringGeometry = geometry
  return geometry
}

/* -------------------------------------------------------------- grid floor -- */

/** Secondary grid hue from the reference HUD (between cyan and deep navy). */
const GRID_SECONDARY_COLOR = '#0A4A6E'

/** HUD coordinate axes drawn on top of the floor (X cyan, Z steel blue). */
const AXIS_X_COLOR = '#00E5FF'
const AXIS_Z_COLOR = '#3FA9CC'
const AXIS_OPACITY = 0.42
const AXIS_TICKS_PER_SIDE = 8
const ORIGIN_RING_SEGMENTS = 48

/**
 * Holographic grid floor parked below the graph's bounding box.
 *
 * The floor is decorative and rebuilt only when the simulation settles or the
 * graph extent changes materially; until then it keeps following the graph
 * centre. `GridHelper` bakes its colours into a vertex-colour buffer, so a new
 * instance is cheaper than re-tinting an existing one.
 *
 * On top of the grid we draw a HUD coordinate system: a bright X axis (cyan), a
 * Z axis (steel blue), short tick marks every 1/16 of the floor and a faint
 * origin ring. They share one additive `LineSegments` draw call, so the floor
 * reads as a tactical plot without adding per-frame cost.
 */
export class GridFloor {
  private scene: THREE.Scene | null = null
  private helper: THREE.GridHelper | null = null
  private axes: THREE.LineSegments | null = null
  private axisMaterial: THREE.LineBasicMaterial | null = null
  private origin: THREE.LineLoop | null = null
  private originMaterial: THREE.LineBasicMaterial | null = null
  private size = 0
  private y = 0

  attach(scene: THREE.Scene): void {
    this.scene = scene
  }

  /**
   * Rebuild/reposition the floor from the live node bounding box. `null` (or an
   * empty box, e.g. no positioned nodes yet) removes the floor entirely.
   */
  sync(box: THREE.Box3 | null): void {
    const scene = this.scene
    if (scene === null) return
    if (box === null || box.isEmpty()) {
      this.removeHelper()
      return
    }

    const extentX = Math.max(1, box.max.x - box.min.x)
    const extentZ = Math.max(1, box.max.z - box.min.z)
    // The floor should read as a table under the graph: overshoot the widest
    // axis by ~75%, then clamp to the HUD token range (tests need stability).
    const size = clamp(Math.max(extentX, extentZ) * 1.75, GRID_SIZE_MIN, GRID_SIZE_MAX)
    const centerX = (box.min.x + box.max.x) / 2
    const centerZ = (box.min.z + box.max.z) / 2
    const y = box.min.y - GRID_Y_OFFSET

    const helper = this.helper
    if (
      helper !== null &&
      Math.abs(size - this.size) <= this.size * 0.1 &&
      Math.abs(y - this.y) <= 6
    ) {
      // Same scale / height: slide the existing grid under the new graph centre.
      helper.position.set(centerX, y, centerZ)
      this.axes?.position.set(centerX, y + 0.3, centerZ)
      this.origin?.position.set(centerX, y + 0.35, centerZ)
      this.y = y
      return
    }

    this.removeHelper()
    const next = new THREE.GridHelper(
      size,
      GRID_DIVISIONS,
      new THREE.Color(HUD.cyan),
      new THREE.Color(GRID_SECONDARY_COLOR)
    )
    next.position.set(centerX, y, centerZ)
    next.material.transparent = true
    next.material.opacity = GRID_OPACITY
    next.material.depthWrite = false
    // Draw behind the graph but after the starfield.
    next.renderOrder = -1
    scene.add(next)
    this.helper = next
    this.size = size
    this.y = y

    // ---- coordinate axes + ticks + origin ring, one draw call --------------
    const half = (size / 2) * 0.94
    const positions: number[] = []
    const colors: number[] = []
    const axisX = new THREE.Color(AXIS_X_COLOR)
    const axisZ = new THREE.Color(AXIS_Z_COLOR)
    const pushSegment = (
      x1: number,
      z1: number,
      x2: number,
      z2: number,
      color: THREE.Color,
      gain: number
    ): void => {
      positions.push(x1, 0, z1, x2, 0, z2)
      colors.push(color.r * gain, color.g * gain, color.b * gain, color.r * gain, color.g * gain, color.b * gain)
    }

    // Main axes: X = cyan, Z = steel blue.
    pushSegment(-half, 0, half, 0, axisX, 1)
    pushSegment(0, -half, 0, half, axisZ, 1)

    // Tick marks every 1/16 of the floor, skipping the origin.
    const step = size / (AXIS_TICKS_PER_SIDE * 2)
    const tickLength = Math.max(2, size * 0.009)
    for (let index = -AXIS_TICKS_PER_SIDE; index <= AXIS_TICKS_PER_SIDE; index += 1) {
      if (index === 0) continue
      const offset = index * step
      if (Math.abs(offset) > half) continue
      // X-axis ticks run along Z, Z-axis ticks run along X.
      pushSegment(offset, -tickLength, offset, tickLength, axisX, 0.52)
      pushSegment(-tickLength, offset, tickLength, offset, axisZ, 0.52)
    }

    const axisGeometry = new THREE.BufferGeometry()
    axisGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    axisGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    const axisMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: AXIS_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const axes = new THREE.LineSegments(axisGeometry, axisMaterial)
    axes.frustumCulled = false
    axes.renderOrder = 0
    axes.position.set(centerX, y + 0.3, centerZ)
    scene.add(axes)
    this.axes = axes
    this.axisMaterial = axisMaterial

    const ringPoints: THREE.Vector3[] = []
    const ringRadius = Math.max(3, size * 0.012)
    for (let index = 0; index < ORIGIN_RING_SEGMENTS; index += 1) {
      const angle = (index / ORIGIN_RING_SEGMENTS) * Math.PI * 2
      ringPoints.push(new THREE.Vector3(Math.cos(angle) * ringRadius, 0, Math.sin(angle) * ringRadius))
    }
    const ringGeometry = new THREE.BufferGeometry().setFromPoints(ringPoints)
    const ringMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(HUD.cyan),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const origin = new THREE.LineLoop(ringGeometry, ringMaterial)
    origin.frustumCulled = false
    origin.renderOrder = 1
    origin.position.set(centerX, y + 0.35, centerZ)
    scene.add(origin)
    this.origin = origin
    this.originMaterial = ringMaterial
  }

  dispose(): void {
    this.removeHelper()
    this.scene = null
  }

  private removeHelper(): void {
    const helper = this.helper
    if (helper !== null) {
      helper.removeFromParent()
      helper.geometry.dispose()
      helper.material.dispose()
      this.helper = null
    }
    const axes = this.axes
    if (axes !== null) {
      axes.removeFromParent()
      axes.geometry.dispose()
      this.axisMaterial?.dispose()
      this.axes = null
      this.axisMaterial = null
    }
    const origin = this.origin
    if (origin !== null) {
      origin.removeFromParent()
      origin.geometry.dispose()
      this.originMaterial?.dispose()
      this.origin = null
      this.originMaterial = null
    }
  }
}

/* --------------------------------------------------------------- starfield -- */

/**
 * Sparse static star shell behind the holo-table.
 *
 * Purely decorative: never raycast, never labelled, never counted. `fog: false`
 * keeps the far stars visible through the atmospheric FogExp2.
 */
export class Starfield {
  private readonly points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>

  constructor() {
    const random = createRandom(0x1b873593)
    const positions = new Float32Array(STARFIELD_COUNT * 3)
    for (let index = 0; index < STARFIELD_COUNT; index += 1) {
      // Fill a shell (not a disc) so the camera never runs into the stars.
      const radius = STARFIELD_RADIUS * (0.55 + random() * 0.45)
      const theta = random() * Math.PI * 2
      const phi = Math.acos(2 * random() - 1)
      positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta)
      positions[index * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta)
      positions[index * 3 + 2] = radius * Math.cos(phi)
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const material = new THREE.PointsMaterial({
      color: new THREE.Color(STARFIELD_COLOR),
      size: STARFIELD_SIZE,
      // Fixed pixel size keeps distant stars as crisp HUD dots, not blobs.
      sizeAttenuation: false,
      transparent: true,
      opacity: STARFIELD_OPACITY,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    material.fog = false
    this.points = new THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>(geometry, material)
    this.points.frustumCulled = false
    this.points.renderOrder = -2
  }

  attach(scene: THREE.Scene): void {
    scene.add(this.points)
  }

  rotate(deltaSeconds: number): void {
    this.points.rotation.y += STARFIELD_ROTATE_SPEED * deltaSeconds
  }

  dispose(): void {
    this.points.removeFromParent()
    this.points.geometry.dispose()
    this.points.material.dispose()
  }
}

/* ---------------------------------------------------------------- flow glow -- */

/** A link that a flow particle can travel along (endpoint graph ids). */
export interface FlowRoute {
  readonly sourceId: string
  readonly targetId: string
}

/** Position holder resolved per frame; the force engine mutates node x/y/z. */
export interface FlowCoords {
  readonly x?: number
  readonly y?: number
  readonly z?: number
}

export type FlowPositionResolver = (nodeId: string) => FlowCoords | undefined

interface FlowParticle {
  /** Index into the route list. */
  route: number
  /** Travel progress in [0, 1). */
  phase: number
  /** Progress per second (from `FLOW_SPEED_RANGE`, deterministic). */
  speed: number
}

/**
 * Additive white light packets running from a link's source to its target.
 *
 * Implemented as a single `THREE.Points` (one draw call) rather than one mesh
 * per link: the reference demo's 流光 effect is hundreds of moving glints, and a
 * point-sprite cloud is the cheapest way to render them without per-link objects.
 * Off entirely in performance mode (thinned) and for `prefers-reduced-motion`.
 */
export class FlowParticles {
  readonly object: THREE.Points
  private readonly material: THREE.PointsMaterial
  private readonly routes: FlowRoute[] = []
  private particles: FlowParticle[] = []
  private positions = new Float32Array(0)
  private geometry: THREE.BufferGeometry
  private positionAttribute: THREE.BufferAttribute | null = null
  private enabled = true
  private performanceMode = false

  constructor(halo: THREE.Texture) {
    this.geometry = new THREE.BufferGeometry()
    // A zero-length position attribute keeps Points renderable before setRoutes.
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3))
    this.material = new THREE.PointsMaterial({
      map: halo,
      color: new THREE.Color(FLOW_PARTICLE_COLOR),
      size: FLOW_PARTICLE_SIZE,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    this.object = new THREE.Points(this.geometry, this.material)
    this.object.frustumCulled = false
    this.object.renderOrder = 3
    this.object.visible = false
  }

  /** Replace the link set the particles travel along. */
  setRoutes(routes: readonly FlowRoute[]): void {
    this.routes.length = 0
    this.routes.push(...routes)
    this.rebuild()
  }

  /** Performance mode keeps only a thin sample of the normal particle budget. */
  setBudget(performanceMode: boolean): void {
    if (this.performanceMode === performanceMode) return
    this.performanceMode = performanceMode
    this.rebuild()
  }

  /** `prefers-reduced-motion` disables the flow motion entirely (and the layer). */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.object.visible = enabled && this.particles.length > 0
  }

  update(resolve: FlowPositionResolver, deltaSeconds: number): void {
    const attribute = this.positionAttribute
    if (!this.enabled || attribute === null || this.particles.length === 0) return
    // Clamp the step so a backgrounded tab does not teleport every particle.
    const step = clamp(deltaSeconds, 0, 0.25)
    const positions = this.positions

    for (let index = 0; index < this.particles.length; index += 1) {
      const particle = this.particles[index]
      if (step > 0) {
        const phase = particle.phase + particle.speed * step
        // Wrap without an expensive modulo for the common single-step case.
        particle.phase = phase >= 1 ? phase - Math.floor(phase) : phase
      }
      const route = this.routes[particle.route]
      const start = resolve(route.sourceId)
      const end = resolve(route.targetId)
      if (start === undefined || end === undefined) continue

      // Keep the glints between the two shells instead of inside the node cores.
      const t = 0.06 + particle.phase * 0.88
      const startX = start.x ?? 0
      const startY = start.y ?? 0
      const startZ = start.z ?? 0
      const offset = index * 3
      positions[offset] = startX + ((end.x ?? 0) - startX) * t
      positions[offset + 1] = startY + ((end.y ?? 0) - startY) * t
      positions[offset + 2] = startZ + ((end.z ?? 0) - startZ) * t
    }

    attribute.needsUpdate = true
  }

  dispose(): void {
    this.object.removeFromParent()
    this.geometry.dispose()
    this.material.dispose()
    this.particles = []
    this.routes.length = 0
  }

  private rebuild(): void {
    const perLink = Math.max(1, FLOW_PARTICLES_PER_LINK)
    const cap = this.performanceMode
      ? Math.max(16, Math.ceil(FLOW_PARTICLE_MAX * 0.28))
      : FLOW_PARTICLE_MAX
    const count = this.routes.length === 0 ? 0 : Math.min(cap, this.routes.length * perLink)

    const particles: FlowParticle[] = []
    const positions = new Float32Array(count * 3)
    for (let index = 0; index < count; index += 1) {
      // Spread the (capped) particles across the *whole* link set instead of
      // clustering them on the first N edges.
      const routeIndex = count === 0 ? 0 : Math.floor((index * this.routes.length) / count)
      const route = this.routes[routeIndex]
      const key = `${route.sourceId}|${route.targetId}|${index}`
      particles.push({
        route: routeIndex,
        phase: hashUnit(`${key}|phase`),
        speed: lerp(FLOW_SPEED_RANGE[0], FLOW_SPEED_RANGE[1], hashUnit(`${key}|speed`))
      })
      // Park uninitialised particles far outside the frustum; the first update
      // moves them onto their route before anything is drawn.
      positions[index * 3 + 1] = -1_000_000
    }

    this.particles = particles
    this.positions = positions
    this.geometry.dispose()
    this.geometry = new THREE.BufferGeometry()
    this.positionAttribute = new THREE.BufferAttribute(positions, 3)
    this.geometry.setAttribute('position', this.positionAttribute)
    this.object.geometry = this.geometry
    this.object.visible = this.enabled && count > 0
  }
}
