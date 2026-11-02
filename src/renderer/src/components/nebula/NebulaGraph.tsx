import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes
} from 'react'
import ForceGraph3DImport from 'react-force-graph-3d'
import * as THREE from 'three'
import type { NebulaLink, NebulaNode } from '@shared/graph'
import { NebulaGraph2D } from '@renderer/components/nebula/NebulaGraph2D'
import { useI18n } from '@renderer/i18n'
import {
  AUTO_ROTATE_RESUME_MS,
  AUTO_ROTATE_SPEED,
  CAMERA_FOCUS_MS,
  CAMERA_RESET_MS,
  DEFAULT_CAMERA_DISTANCE,
  DIM_OPACITY,
  FOCUS_DIM_OPACITY,
  HALO_SCALE,
  LABEL_BG_COLOR,
  LABEL_BORDER_COLOR,
  LABEL_DIM_FACTOR,
  LABEL_EMPHASIS_OPACITY,
  LABEL_FONT,
  LABEL_IDLE_OPACITY,
  LABEL_IDLE_SCALE,
  LABEL_SPRITE_SCALE,
  LABEL_TEXT_COLOR,
  LABEL_TEXTURE_HEIGHT,
  LABEL_TEXTURE_WIDTH,
  LINK_COLORS,
  NEBULA_BACKGROUND,
  NEBULA_SKYBOX_HEIGHT,
  NEBULA_SKYBOX_WIDTH,
  PERFORMANCE_SELECTED_HALO_OPACITY,
  SPRITE_TEXTURE_SIZE,
  STARFIELD_BRIGHT_COUNT,
  STARFIELD_BRIGHT_OPACITY,
  STARFIELD_BRIGHT_SIZE,
  STARFIELD_DUST_CLUSTERS,
  STARFIELD_DUST_COUNT,
  STARFIELD_DUST_OPACITY,
  STARFIELD_DUST_SIZE,
  STARFIELD_FAR_COUNT,
  STARFIELD_FAR_MAX_RADIUS,
  STARFIELD_FAR_MIN_RADIUS,
  STARFIELD_FAR_OPACITY,
  STARFIELD_FAR_SIZE,
  STARFIELD_ROTATE_SPEED,
  linkOpacity,
  nodeColor,
  nodeRadius,
  rgba
} from '@renderer/lib/graphTheme'
import { cn } from '@renderer/lib/utils'

/**
 * Imperative camera/selection API exposed to `NebulaPage`. All Three.js objects
 * stay inside this component; the page never touches a scene graph.
 */
export interface NebulaGraphHandle {
  /** Fly the camera to a node (800ms); no-op when the node is not rendered. */
  focusNode(nodeId: string): void
  /** Restore the default framing of the whole graph. */
  resetView(): void
  /** Fit all currently rendered nodes into the frustum. */
  zoomToFit(): void
  /** Current WebGL frame as a PNG data URL (null when the canvas is unavailable). */
  captureImage(): string | null
}

export interface NebulaGraphProps {
  /** Already filtered by the page (type filters applied). */
  nodes: NebulaNode[]
  links: NebulaLink[]
  selectedId: string | null
  /** Search matches; `null` means "no active search" (nothing is dimmed). */
  highlightIds: string[] | null
  /** Focus neighbourhood; `null` means "no focus mode" (nothing is dimmed). */
  focusIds: string[] | null
  /** Large-graph mode: no idle labels, halos only for the selected node. */
  performanceMode: boolean
  /** Auto-rotation is already reduced-motion aware upstream. */
  autoRotate: boolean
  onSelect: (nodeId: string | null) => void
  className?: string
}

/* ---------------------------------------------------------------- internals -- */

/** Nodes as the force engine sees them: positions are injected at runtime. */
type GraphNode = NebulaNode & { x?: number; y?: number; z?: number }
type GraphLink = NebulaLink & { source: string; target: string }

interface Coords {
  x: number
  y: number
  z: number
}

interface OrbitControlsLike {
  autoRotate: boolean
  autoRotateSpeed: number
  enableDamping: boolean
  /** Current orbit center; set through `cameraPosition(pos, lookAt)`. */
  target?: { x: number; y: number; z: number }
}

interface ForceLike {
  strength(value: number | ((node: unknown) => number)): unknown
  distance?(value: number | ((link: unknown) => number)): unknown
}

/** Deterministic FNV-1a hash → stable 0..1 unit value (survives re-renders). */
function hashUnit(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 4_294_967_296
}

/** Links are string ids before simulation and node objects during it. */
function linkEndpointId(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'id' in value) {
    return String((value as { id: unknown }).id)
  }
  return String(value)
}

function linkKey(link: { source: unknown; target: unknown }): string {
  return `${linkEndpointId(link.source)}|${linkEndpointId(link.target)}`
}

/**
 * Per-link distance: a fixed distance made every child sit on one shell, which
 * looks like a rigid cone under a busy hub. A deterministic 32–100 spread puts
 * children on several shells while the edges stay straight.
 */
function linkDistance(link: GraphLink): number {
  return 32 + hashUnit(linkKey(link)) * 68
}

/* ------------------------------------------------------------- link art -- */

/**
 * Edges are a short polyline whose vertex colours fade to black at both ends.
 * With additive blending the line dissolves into the node glow instead of
 * ending in a hard point at the node centre, while the trimmed middle keeps
 * the web readable. Deterministic per-link colours keep the look stable.
 */
const LINK_SEGMENT_COUNT = 20
const LINK_FADE_FRACTION = 0.2
const LINK_TRIM_RATIO = 0.045
const LINK_TRIM_MIN = 1.5
const LINK_TRIM_MAX = 7
const LINK_COLOR_GAIN = 2.4

function linkBaseColor(link: GraphLink): THREE.Color {
  const opacity = linkOpacity(link.relation, link.derived === true)
  // Slight per-link brightness variation keeps the web organic instead of a
  // uniform wireframe; deterministic so the look is stable across reloads.
  const variation = 0.82 + hashUnit(`${linkKey(link)}|brightness`) * 0.36
  return new THREE.Color(LINK_COLORS[link.relation]).multiplyScalar(
    Math.min(1, opacity * LINK_COLOR_GAIN * variation)
  )
}

function createLinkObject(link: GraphLink): THREE.Object3D {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(LINK_SEGMENT_COUNT * 3), 3)
  )
  const base = linkBaseColor(link)
  const colors = new Float32Array(LINK_SEGMENT_COUNT * 3)
  for (let index = 0; index < LINK_SEGMENT_COUNT; index += 1) {
    const t = index / (LINK_SEGMENT_COUNT - 1)
    const fadeIn = Math.min(1, t / LINK_FADE_FRACTION)
    const fadeOut = Math.min(1, (1 - t) / LINK_FADE_FRACTION)
    const fade = Math.min(fadeIn, fadeOut) ** 1.2
    colors[index * 3] = base.r * fade
    colors[index * 3 + 1] = base.g * fade
    colors[index * 3 + 2] = base.b * fade
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  )
  line.frustumCulled = false
  line.renderOrder = 2
  return line
}

function updateLinkPosition(
  object: THREE.Object3D,
  coords: { start: Coords; end: Coords }
): void {
  if (!(object instanceof THREE.Line)) return
  const position = object.geometry.getAttribute('position') as THREE.BufferAttribute
  const dx = coords.end.x - coords.start.x
  const dy = coords.end.y - coords.start.y
  const dz = coords.end.z - coords.start.z
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const trim =
    length > 0
      ? Math.min(LINK_TRIM_MAX, Math.max(LINK_TRIM_MIN, length * LINK_TRIM_RATIO))
      : 0
  const t0 = length > 0 ? Math.min(0.45, trim / length) : 0
  const t1 = 1 - t0
  const array = position.array as Float32Array
  for (let index = 0; index < LINK_SEGMENT_COUNT; index += 1) {
    const t = t0 + (t1 - t0) * (index / (LINK_SEGMENT_COUNT - 1))
    array[index * 3] = coords.start.x + dx * t
    array[index * 3 + 1] = coords.start.y + dy * t
    array[index * 3 + 2] = coords.start.z + dz * t
  }
  position.needsUpdate = true
}

/**
 * Minimal slice of the kapsule instance we drive. The library ships hand-written
 * types that do not cover every accessor consistently across versions, so this
 * is the single documented boundary between our code and `3d-force-graph`.
 */
interface GraphController {
  cameraPosition(): Coords
  cameraPosition(position: Partial<Coords>, lookAt?: Coords, transitionMs?: number): unknown
  controls(): OrbitControlsLike
  d3ReheatSimulation(): unknown
  d3Force(name: string): ForceLike | undefined
  scene(): THREE.Scene
}

interface ForceGraphProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] }
  width: number
  height: number
  backgroundColor: string
  showNavInfo: boolean
  nodeId: string
  nodeVal: (node: GraphNode) => number
  /** The library's DOM tooltip is redundant with our sprite labels. */
  nodeLabel: () => string
  /** Keep the drawing buffer so PNG export can read the frame. */
  rendererConfig: { preserveDrawingBuffer: boolean; antialias: boolean }
  enableNodeDrag: boolean
  warmupTicks: number
  cooldownTicks: number
  d3AlphaDecay: number
  nodeThreeObject: (node: GraphNode) => THREE.Object3D
  linkThreeObject: (link: GraphLink) => THREE.Object3D
  linkPositionUpdate: (object: THREE.Object3D, coords: { start: Coords; end: Coords }, link: GraphLink) => void
  onNodeClick: (node: GraphNode, event: MouseEvent) => void
  onNodeHover: (node: GraphNode | null, previousNode: GraphNode | null) => void
  onBackgroundClick: () => void
  onEngineStop: () => void
}

const ForceGraph3D = ForceGraph3DImport as unknown as ForwardRefExoticComponent<
  ForceGraphProps & RefAttributes<GraphController>
>

/** Above this many graph elements we stop adding halos and warn the user. */
const PERFORMANCE_ELEMENT_LIMIT = 800

interface NodeVisual {
  core: THREE.Sprite
  halo: THREE.Sprite
  label: THREE.Sprite
  coreMaterial: THREE.SpriteMaterial
  haloMaterial: THREE.SpriteMaterial
  labelMaterial: THREE.SpriteMaterial
  labelTexture: THREE.Texture
  /** World-space radius of the core sprite, used to park the label above it. */
  radius: number
}

function detectWebGl(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * Soft additive glow disc; one texture per colour, shared by every node.
 *
 * Brighter than a plain gaussian: a hot core plus a white specular pin makes the
 * nodes read as sparkling lights instead of flat dim blobs (all additive, so the
 * canvas background stays black).
 */
function createGlowTexture(color: string): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = SPRITE_TEXTURE_SIZE
  canvas.height = SPRITE_TEXTURE_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D canvas unavailable')
  const center = SPRITE_TEXTURE_SIZE / 2
  const gradient = context.createRadialGradient(center, center, 0, center, center, center)
  gradient.addColorStop(0, rgba(color, 1))
  gradient.addColorStop(0.12, rgba(color, 1))
  gradient.addColorStop(0.3, rgba(color, 0.68))
  gradient.addColorStop(0.56, rgba(color, 0.24))
  gradient.addColorStop(0.8, rgba(color, 0.06))
  gradient.addColorStop(1, rgba(color, 0))
  context.fillStyle = gradient
  context.fillRect(0, 0, SPRITE_TEXTURE_SIZE, SPRITE_TEXTURE_SIZE)

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
  context.fillRect(0, 0, SPRITE_TEXTURE_SIZE, SPRITE_TEXTURE_SIZE)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

/** Rounded dark pill with the node name; visible at low opacity by default. */
function createLabelTexture(text: string): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = LABEL_TEXTURE_WIDTH
  canvas.height = LABEL_TEXTURE_HEIGHT
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D canvas unavailable')
  context.font = LABEL_FONT
  const maxTextWidth = LABEL_TEXTURE_WIDTH - 72
  let display = text.trim()
  if (display.length === 0) display = '—'
  if (context.measureText(display).width > maxTextWidth) {
    while (display.length > 1 && context.measureText(`${display}…`).width > maxTextWidth) {
      display = display.slice(0, -1)
    }
    display = `${display}…`
  }
  const textWidth = Math.min(maxTextWidth, context.measureText(display).width)
  const paddingX = 32
  const width = Math.min(LABEL_TEXTURE_WIDTH, textWidth + paddingX * 2)
  const height = 84
  const x = (LABEL_TEXTURE_WIDTH - width) / 2
  const y = (LABEL_TEXTURE_HEIGHT - height) / 2
  context.beginPath()
  context.roundRect(x, y, width, height, 20)
  context.fillStyle = LABEL_BG_COLOR
  context.fill()
  context.lineWidth = 2
  context.strokeStyle = LABEL_BORDER_COLOR
  context.stroke()
  context.fillStyle = LABEL_TEXT_COLOR
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(display, LABEL_TEXTURE_WIDTH / 2, LABEL_TEXTURE_HEIGHT / 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

function disposeVisual(visual: NodeVisual): void {
  visual.coreMaterial.dispose()
  visual.haloMaterial.dispose()
  visual.labelMaterial.dispose()
  visual.labelTexture.dispose()
  visual.label.removeFromParent()
  visual.halo.removeFromParent()
  visual.core.removeFromParent()
}

/* ------------------------------------------------------- background starfield -- */

/**
 * Purely decorative space background behind the graph: distant stars + a faint
 * dust cloud, both static THREE.Points layers that drift on their own. They are
 * not nodes: never raycast, never labelled, never counted in stats.
 */
interface SceneDecor {
  /** Attach the skybox + drifting point layers to the given scene. */
  attach(scene: THREE.Scene): void
  rotate(deltaSeconds: number): void
  dispose(): void
}

/** Deterministic PRNG so the generated nebula looks identical on every load. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * Procedurally painted nebula cloud: clustered gas complexes, wispy filament
 * chains, high-frequency grains, dark dust lanes and bright star-forming knots,
 * then a round edge fade so the square sprite melts into the black canvas. Two
 * variants layer for depth.
 */
/**
 * Procedurally painted equirectangular nebula skybox (360° × 180°).
 *
 * A world-space sprite only covers the side of the scene facing -Z, so when the
 * camera orbits to the other half the backdrop disappears (user report: "只有
 * 一小面存在，另一面还是黑的"). Baking the same gas clouds into a 2:1 texture
 * assigned to `scene.background` keeps the nebula behind the camera on every
 * side, while the separate THREE.Points star/dust layers still drift for
 * parallax.
 *
 * Horizontal wrap: every puff is painted three times (x-W, x, x+W) so the
 * left/right seams of the equirectangular map join without a visible edge.
 */
function createNebulaSkyboxTexture(): THREE.Texture {
  const width = NEBULA_SKYBOX_WIDTH
  const height = NEBULA_SKYBOX_HEIGHT
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D canvas unavailable')
  const random = createRandom(0x5f356495)
  const palettes: ReadonlyArray<readonly string[]> = [
    ['#1e3a8a', '#1d4ed8'],
    ['#0e7490', '#22d3ee'],
    ['#4c1d95', '#7c3aed'],
    ['#831843', '#db2777']
  ]

  /** Soft elongated gas puff: a radial gradient painted under an ellipse transform. */
  const paintPuff = (
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    color: string,
    alpha: number
  ): void => {
    context.save()
    context.translate(x, y)
    context.rotate(rotation)
    context.scale(1, radiusY / radiusX)
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, radiusX)
    gradient.addColorStop(0, rgba(color, alpha))
    gradient.addColorStop(0.55, rgba(color, alpha * 0.45))
    gradient.addColorStop(1, rgba(color, 0))
    context.fillStyle = gradient
    context.beginPath()
    context.arc(0, 0, radiusX, 0, Math.PI * 2)
    context.fill()
    context.restore()
  }

  /** Paint the same puff at x-W, x and x+W so the 2:1 map wraps seamlessly. */
  const wrappedPuff = (
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    color: string,
    alpha: number
  ): void => {
    for (const offset of [-width, 0, width]) {
      paintPuff(x + offset, y, radiusX, radiusY, rotation, color, alpha)
    }
  }

  // 1) deep-space base
  const base = context.createLinearGradient(0, 0, 0, height)
  base.addColorStop(0, '#02030a')
  base.addColorStop(0.5, '#05070f')
  base.addColorStop(1, '#02030a')
  context.fillStyle = base
  context.fillRect(0, 0, width, height)
  context.globalCompositeOperation = 'lighter'

  // 2) cloud complexes spread across the whole sky
  const clusterCount = 12
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    const palette = palettes[cluster % palettes.length]
    const centerX = random() * width
    const centerY = height * (0.18 + random() * 0.64)
    const spread = width * (0.02 + random() * 0.06)
    const puffCount = 18 + Math.floor(random() * 14)
    for (let index = 0; index < puffCount; index += 1) {
      const angle = random() * Math.PI * 2
      const distance = Math.abs(random() + random() - 1) * spread * 2.2
      const x = centerX + Math.cos(angle) * distance
      const y = centerY + Math.sin(angle) * distance * 0.55
      const radiusX = width * (0.008 + random() * 0.03)
      wrappedPuff(
        x,
        y,
        radiusX,
        radiusX * (0.5 + random() * 0.6),
        random() * Math.PI,
        palette[Math.floor(random() * palette.length)],
        0.07 + random() * 0.13
      )
    }
  }

  // 3) wispy filament chains (small puffs following a wandering path)
  for (let tendril = 0; tendril < 22; tendril += 1) {
    const palette = palettes[Math.floor(random() * palettes.length)]
    const color = palette[Math.floor(random() * palette.length)]
    let x = random() * width
    let y = height * (0.2 + random() * 0.6)
    const direction = random() * Math.PI * 2
    const steps = 12 + Math.floor(random() * 12)
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps
      x += Math.cos(direction + Math.sin(t * 4) * 0.8) * width * 0.006
      y += Math.sin(direction + Math.cos(t * 3) * 0.8) * height * 0.014
      const radius = width * (0.0025 + random() * 0.006) * (1 - t * 0.5)
      wrappedPuff(
        x,
        y,
        radius,
        radius * (0.5 + random() * 0.7),
        direction + random(),
        color,
        (0.06 + random() * 0.09) * (1 - t)
      )
    }
  }

  // 4) bright star-forming knots
  for (let index = 0; index < 10; index += 1) {
    const x = random() * width
    const y = height * (0.2 + random() * 0.6)
    const radius = width * (0.004 + random() * 0.01)
    wrappedPuff(
      x,
      y,
      radius,
      radius * (0.7 + random() * 0.6),
      random() * Math.PI,
      random() > 0.5 ? '#f9a8d4' : '#a5f3fc',
      0.18 + random() * 0.16
    )
  }

  // 5) dark dust lanes carved back into the glow
  context.globalCompositeOperation = 'source-over'
  for (let index = 0; index < 52; index += 1) {
    const x = random() * width
    const y = height * (0.12 + random() * 0.76)
    const radius = height * (0.03 + random() * 0.12)
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, 'rgba(2, 3, 8, 0.34)')
    gradient.addColorStop(1, 'rgba(2, 3, 8, 0)')
    context.fillStyle = gradient
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
  }

  // 6) darken the poles so the equirectangular stretching is hidden
  const poleHeight = height * 0.2
  const topFade = context.createLinearGradient(0, 0, 0, poleHeight)
  topFade.addColorStop(0, 'rgba(2, 3, 8, 0.95)')
  topFade.addColorStop(1, 'rgba(2, 3, 8, 0)')
  context.fillStyle = topFade
  context.fillRect(0, 0, width, poleHeight)
  const bottomFade = context.createLinearGradient(0, height - poleHeight, 0, height)
  bottomFade.addColorStop(0, 'rgba(2, 3, 8, 0)')
  bottomFade.addColorStop(1, 'rgba(2, 3, 8, 0.95)')
  context.fillStyle = bottomFade
  context.fillRect(0, height - poleHeight, width, poleHeight)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.needsUpdate = true
  return texture
}

const STAR_COLORS = ['#ffffff', '#e0e7ff', '#bfdbfe', '#fde68a', '#fca5a5', '#c4b5fd']
const DUST_COLORS = ['#3b82f6', '#22d3ee', '#a855f7', '#f472b6', '#93c5fd']

interface PointsLayer {
  points: THREE.Points
  geometry: THREE.BufferGeometry
  material: THREE.PointsMaterial
}

function createPointsLayer(
  count: number,
  size: number,
  opacity: number,
  texture: THREE.Texture,
  sample: (random: () => number) => { position: [number, number, number]; color: string }
): PointsLayer {
  const random = createRandom(0x1b873593 + count)
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const color = new THREE.Color()
  for (let index = 0; index < count; index += 1) {
    const entry = sample(random)
    positions[index * 3] = entry.position[0]
    positions[index * 3 + 1] = entry.position[1]
    positions[index * 3 + 2] = entry.position[2]
    color.set(entry.color)
    colors[index * 3] = color.r
    colors[index * 3 + 1] = color.g
    colors[index * 3 + 2] = color.b
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const material = new THREE.PointsMaterial({
    map: texture,
    vertexColors: true,
    size,
    sizeAttenuation: false,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  return { points, geometry, material }
}

function createSceneDecor(): SceneDecor {
  // ---- nebula backdrop: equirectangular skybox (visible on every side) ------
  const skyboxTexture = createNebulaSkyboxTexture()

  // ---- natural star field: mostly white/blue, a few warm, then bright stars --
  const starTexture = createGlowTexture('#ffffff')
  const starLayer = createPointsLayer(
    STARFIELD_FAR_COUNT,
    STARFIELD_FAR_SIZE,
    STARFIELD_FAR_OPACITY,
    starTexture,
    (random) => {
      const radius =
        STARFIELD_FAR_MIN_RADIUS +
        random() * (STARFIELD_FAR_MAX_RADIUS - STARFIELD_FAR_MIN_RADIUS)
      const theta = random() * Math.PI * 2
      const phi = Math.acos(2 * random() - 1)
      return {
        position: [
          radius * Math.sin(phi) * Math.cos(theta),
          radius * Math.sin(phi) * Math.sin(theta),
          radius * Math.cos(phi)
        ],
        color: STAR_COLORS[Math.floor(random() * STAR_COLORS.length)]
      }
    }
  )
  starLayer.points.renderOrder = -2

  const brightTexture = createGlowTexture('#fef3c7')
  const brightLayer = createPointsLayer(
    STARFIELD_BRIGHT_COUNT,
    STARFIELD_BRIGHT_SIZE,
    STARFIELD_BRIGHT_OPACITY,
    brightTexture,
    (random) => {
      const radius = 900 + random() * 1_200
      const theta = random() * Math.PI * 2
      const phi = Math.acos(2 * random() - 1)
      return {
        position: [
          radius * Math.sin(phi) * Math.cos(theta),
          radius * Math.sin(phi) * Math.sin(theta),
          radius * Math.cos(phi)
        ],
        color: random() > 0.5 ? '#ffffff' : '#fde68a'
      }
    }
  )
  brightLayer.points.renderOrder = -1

  // ---- dust motes: mostly along a few filament-like clusters ----------------
  const dustTexture = createGlowTexture('#ffffff')
  const clusterCenters: Array<[number, number, number]> = []
  const clusterRandom = createRandom(0x9e3779b9 * 3)
  for (let index = 0; index < STARFIELD_DUST_CLUSTERS; index += 1) {
    const radius = 240 + clusterRandom() * 520
    const theta = clusterRandom() * Math.PI * 2
    const phi = Math.acos(2 * clusterRandom() - 1)
    clusterCenters.push([
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta) * 0.8,
      radius * Math.cos(phi)
    ])
  }
  const dustLayer = createPointsLayer(
    STARFIELD_DUST_COUNT,
    STARFIELD_DUST_SIZE,
    STARFIELD_DUST_OPACITY,
    dustTexture,
    (random) => {
      const cluster = random() < 0.72
      if (cluster) {
        const center = clusterCenters[Math.floor(random() * clusterCenters.length)]
        const spread = 90 + random() * 240
        return {
          position: [
            center[0] + (random() - 0.5) * spread * 2,
            center[1] + (random() - 0.5) * spread * 1.4,
            center[2] + (random() - 0.5) * spread * 2
          ],
          color: DUST_COLORS[Math.floor(random() * DUST_COLORS.length)]
        }
      }
      const radius = 380 + random() * 900
      const theta = random() * Math.PI * 2
      const phi = Math.acos(2 * random() - 1)
      return {
        position: [
          radius * Math.sin(phi) * Math.cos(theta),
          radius * Math.sin(phi) * Math.sin(theta),
          radius * Math.cos(phi)
        ],
        color: DUST_COLORS[Math.floor(random() * DUST_COLORS.length)]
      }
    }
  )
  dustLayer.points.renderOrder = -1

  const driftObjects: THREE.Object3D[] = [
    starLayer.points,
    brightLayer.points,
    dustLayer.points
  ]
  let attachedScene: THREE.Scene | null = null

  return {
    attach(scene: THREE.Scene): void {
      attachedScene = scene
      scene.background = skyboxTexture
      for (const object of driftObjects) scene.add(object)
    },
    rotate(deltaSeconds: number): void {
      const step = STARFIELD_ROTATE_SPEED * deltaSeconds
      for (const object of driftObjects) object.rotation.y += step
    },
    dispose(): void {
      for (const object of driftObjects) object.removeFromParent()
      if (attachedScene !== null && attachedScene.background === skyboxTexture) {
        attachedScene.background = null
      }
      attachedScene = null
      skyboxTexture.dispose()
      starTexture.dispose()
      starLayer.geometry.dispose()
      starLayer.material.dispose()
      brightTexture.dispose()
      brightLayer.geometry.dispose()
      brightLayer.material.dispose()
      dustTexture.dispose()
      dustLayer.geometry.dispose()
      dustLayer.material.dispose()
    }
  }
}

/* ------------------------------------------------------------------ component -- */

export const NebulaGraph = forwardRef<NebulaGraphHandle, NebulaGraphProps>(function NebulaGraph(
  { nodes, links, selectedId, highlightIds, focusIds, performanceMode, autoRotate, onSelect, className },
  ref
) {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const graphRef = useRef<GraphController | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [webglSupported] = useState(detectWebGl)
  const [contextLost, setContextLost] = useState(false)

  const visualsRef = useRef<Map<string, NodeVisual>>(new Map())
  const glowCacheRef = useRef<Map<string, THREE.Texture>>(new Map())
  const nodeByIdRef = useRef<Map<string, GraphNode>>(new Map())
  const hoveredIdRef = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(selectedId)
  const highlightRef = useRef<string[] | null>(highlightIds)
  const focusRef = useRef<string[] | null>(focusIds)
  /** Derived Sets for the per-node visual pass; rebuilt when props change. */
  const highlightSetRef = useRef<Set<string> | null>(null)
  const focusSetRef = useRef<Set<string> | null>(null)
  const performanceModeRef = useRef(performanceMode)
  const autoRotateRef = useRef(autoRotate)
  const onSelectRef = useRef(onSelect)
  const autoFitTimerRef = useRef<number | undefined>(undefined)
  /** Decorative space background (stars + dust); not graph data. */
  const sceneDecorRef = useRef<SceneDecor | null>(null)
  /** Fit exactly once per data change, after the layout has actually settled. */
  const fittedRef = useRef(false)
  /** Any pan/zoom/focus/click opts the user out of the automatic re-frame. */
  const interactedRef = useRef(false)
  /** Bumped on mount so StrictMode's throwaway cleanup cannot free live caches. */
  const mountGenerationRef = useRef(0)

  selectedIdRef.current = selectedId
  highlightRef.current = highlightIds
  focusRef.current = focusIds
  highlightSetRef.current = highlightIds === null ? null : new Set(highlightIds)
  focusSetRef.current = focusIds === null ? null : new Set(focusIds)
  performanceModeRef.current = performanceMode
  autoRotateRef.current = autoRotate
  onSelectRef.current = onSelect

  // Cloned payload: the force engine rewrites link source/target into node refs,
  // and the page's own link objects must stay strings.
  const graphData = useMemo(
    () => ({
      nodes: nodes.map((node) => ({ ...node })) as GraphNode[],
      links: links.map((link) => ({ ...link })) as GraphLink[]
    }),
    [nodes, links]
  )

  useEffect(() => {
    nodeByIdRef.current = new Map(graphData.nodes.map((node) => [node.id, node] as const))
  }, [graphData])

  // The canvas sits inside a flex shell, so it must track its own box instead of
  // the window (the library defaults to full-window sizing).
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const apply = (rect: DOMRectReadOnly): void => {
      const width = Math.max(0, Math.round(rect.width))
      const height = Math.max(0, Math.round(rect.height))
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }))
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) apply(entry.contentRect)
    })
    observer.observe(element)
    apply(element.getBoundingClientRect())
    return () => observer.disconnect()
  }, [])

  /* ------------------------------------------------------- visual state sync -- */

  /**
   * Apply search/focus/selection/performance state to one node visual.
   *
   * Called for the whole map whenever a prop changes AND immediately for each
   * node object the force engine creates: on data updates the engine builds its
   * objects after the first React paint, so a map-only pass would leave the
   * freshly created labels/halos in their default (visible) state.
   */
  const applyStateToVisual = useCallback((nodeId: string, visual: NodeVisual) => {
    const highlightSet = highlightSetRef.current
    const focusSet = focusSetRef.current
    const performance = performanceModeRef.current
    const labelRatio = LABEL_TEXTURE_HEIGHT / LABEL_TEXTURE_WIDTH

    const selected = nodeId === selectedIdRef.current
    const hovered = nodeId === hoveredIdRef.current
    const matched = highlightSet === null || highlightSet.has(nodeId)
    const inFocus = focusSet === null || focusSet.has(nodeId) || selected
    const emphasized = selected || hovered
    const visible = matched && inFocus

    visual.coreMaterial.opacity = visible ? 1 : focusSet !== null ? FOCUS_DIM_OPACITY : DIM_OPACITY

    // Performance mode keeps a halo only for the selected node.
    const haloOpacity = performance
      ? selected
        ? PERFORMANCE_SELECTED_HALO_OPACITY
        : 0
      : selected
        ? 0.9
        : hovered
          ? 0.45
          : 0
    visual.haloMaterial.opacity = haloOpacity
    visual.halo.visible = haloOpacity > 0

    if (performance) {
      // Large graphs: labels only while hovered/selected, never at rest.
      visual.label.visible = emphasized && visible
      visual.labelMaterial.opacity = emphasized && visible ? LABEL_EMPHASIS_OPACITY : 0
      visual.label.scale.set(LABEL_SPRITE_SCALE, LABEL_SPRITE_SCALE * labelRatio, 1)
      visual.label.position.y = visual.radius + LABEL_SPRITE_SCALE * 0.12
      return
    }

    visual.label.visible = visible
    const labelOpacity = emphasized ? LABEL_EMPHASIS_OPACITY : LABEL_IDLE_OPACITY
    visual.labelMaterial.opacity = visible ? labelOpacity : LABEL_IDLE_OPACITY * LABEL_DIM_FACTOR
    const scale = emphasized ? LABEL_SPRITE_SCALE : LABEL_IDLE_SCALE
    visual.label.scale.set(scale, scale * labelRatio, 1)
    visual.label.position.y = visual.radius + scale * 0.12
  }, [])

  const applyVisualState = useCallback(() => {
    for (const [nodeId, visual] of visualsRef.current) {
      applyStateToVisual(nodeId, visual)
    }
  }, [applyStateToVisual])

  useEffect(() => {
    applyVisualState()
  }, [applyVisualState, nodes, selectedId, highlightIds, focusIds, performanceMode])

  /* --------------------------------------------------------------- node art -- */

  const buildNodeObject = useCallback((node: GraphNode): THREE.Object3D => {
    const color = nodeColor(node)
    const radius = nodeRadius(node)
    let glowTexture = glowCacheRef.current.get(color)
    if (!glowTexture) {
      glowTexture = createGlowTexture(color)
      glowCacheRef.current.set(color, glowTexture)
    }

    // Scope switches and data refreshes recreate objects for the same id: free
    // the previous visual before replacing it so nothing leaks.
    const previous = visualsRef.current.get(node.id)
    if (previous) disposeVisual(previous)

    const group = new THREE.Group()

    const coreMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const core = new THREE.Sprite(coreMaterial)
    core.scale.setScalar(radius * 2)
    group.add(core)

    const haloMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0
    })
    const halo = new THREE.Sprite(haloMaterial)
    halo.scale.setScalar(radius * 2 * HALO_SCALE[node.type])
    halo.visible = false
    group.add(halo)

    const labelTexture = createLabelTexture(node.name)
    const labelMaterial = new THREE.SpriteMaterial({
      map: labelTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      opacity: LABEL_IDLE_OPACITY
    })
    const label = new THREE.Sprite(labelMaterial)
    const idleWidth = LABEL_IDLE_SCALE
    label.scale.set(idleWidth, idleWidth * (LABEL_TEXTURE_HEIGHT / LABEL_TEXTURE_WIDTH), 1)
    label.position.set(0, radius + idleWidth * 0.12, 0)
    label.renderOrder = 20
    group.add(label)

    const visual: NodeVisual = {
      core,
      halo,
      label,
      coreMaterial,
      haloMaterial,
      labelMaterial,
      labelTexture,
      radius
    }
    visualsRef.current.set(node.id, visual)
    // The engine creates objects after the first paint; apply the current
    // selection/search/focus state immediately so nothing flashes at rest.
    applyStateToVisual(node.id, visual)

    return group
  }, [applyStateToVisual])

  /* --------------------------------------------------------- interaction -- */

  const handleNodeHover = useCallback(
    (node: GraphNode | null) => {
      const nextId = node ? node.id : null
      if (hoveredIdRef.current === nextId) return
      hoveredIdRef.current = nextId
      applyVisualState()
      const element = containerRef.current
      if (element) element.style.cursor = nextId ? 'pointer' : 'grab'
    },
    [applyVisualState]
  )

  /**
   * Re-target the orbit center without changing the zoom level: the camera keeps
   * its distance but looks at `center`, so auto-rotation afterwards orbits the
   * clicked node instead of the graph origin (P3 feedback).
   */
  const centerView = useCallback(
    (center: { x: number; y: number; z: number }, durationMs = 600): void => {
      const controller = graphRef.current
      if (!controller) return
      const camera = controller.cameraPosition()
      const target = controller.controls().target ?? { x: 0, y: 0, z: 0 }
      const distance = new THREE.Vector3(
        camera.x - target.x,
        camera.y - target.y,
        camera.z - target.z
      ).length()
      const offset = new THREE.Vector3(
        camera.x - center.x,
        camera.y - center.y,
        camera.z - center.z
      )
      if (offset.lengthSq() < 1e-4) offset.set(0, 0, 1)
      offset.normalize().multiplyScalar(Math.max(70, distance))
      controller.cameraPosition(
        { x: center.x + offset.x, y: center.y + offset.y, z: center.z + offset.z },
        center,
        durationMs
      )
    },
    []
  )

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      interactedRef.current = true
      onSelectRef.current(node.id)
      // Any node click becomes the new orbit center (keeps current zoom).
      centerView({ x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 })
    },
    [centerView]
  )

  const handleBackgroundClick = useCallback(() => {
    interactedRef.current = true
    onSelectRef.current(null)
    // Empty canvas restores the constellation's own center as the orbit target.
    const nodes = [...nodeByIdRef.current.values()]
    if (nodes.length === 0) return
    const box = new THREE.Box3()
    const point = new THREE.Vector3()
    for (const node of nodes) {
      box.expandByPoint(point.set(node.x ?? 0, node.y ?? 0, node.z ?? 0))
    }
    const center = box.getCenter(new THREE.Vector3())
    centerView({ x: center.x, y: center.y, z: center.z })
  }, [centerView])

  const nodeValue = useCallback((node: GraphNode): number => node.val, [])
  const emptyNodeLabel = useCallback((): string => '', [])

  /* ------------------------------------------------------------ scene setup -- */

  // Force tuning + initial camera only need configuring once the renderer
  // exists; the retry loop copes with the async mount of the canvas.
  useEffect(() => {
    let frame = 0
    let attempts = 0
    const tick = (): void => {
      const controller = graphRef.current
      if (controller) {
        const charge = controller.d3Force('charge')
        charge?.strength(-85)
        const linkForce = controller.d3Force('link')
        linkForce?.distance?.((link: unknown) => linkDistance(link as GraphLink))
        controller.d3ReheatSimulation()
        controller.cameraPosition(
          { x: 0, y: 0, z: DEFAULT_CAMERA_DISTANCE },
          { x: 0, y: 0, z: 0 },
          0
        )
        return
      }
      attempts += 1
      if (attempts > 300) return
      frame = window.requestAnimationFrame(tick)
    }
    tick()
    return () => window.cancelAnimationFrame(frame)
  }, [])

  /* ------------------------------------------------- background starfield -- */

  // Attach the decorative star/dust layers once the scene exists, then drift
  // them slowly on their own frame loop (paused for reduced-motion users).
  useEffect(() => {
    if (!webglSupported) return
    let disposed = false
    let attachFrame = 0
    let animateFrame = 0
    let lastTime = 0
    let attempts = 0

    const animate = (time: number): void => {
      if (disposed) return
      const delta = lastTime === 0 ? 0 : Math.min(0.1, (time - lastTime) / 1000)
      lastTime = time
      if (autoRotateRef.current) sceneDecorRef.current?.rotate(delta)
      animateFrame = window.requestAnimationFrame(animate)
    }

    const attach = (): void => {
      const controller = graphRef.current
      if (controller) {
        const decor = createSceneDecor()
        sceneDecorRef.current = decor
        decor.attach(controller.scene())
        animateFrame = window.requestAnimationFrame(animate)
        return
      }
      attempts += 1
      if (attempts > 300) return
      attachFrame = window.requestAnimationFrame(attach)
    }
    attachFrame = window.requestAnimationFrame(attach)

    return () => {
      disposed = true
      window.cancelAnimationFrame(attachFrame)
      window.cancelAnimationFrame(animateFrame)
      sceneDecorRef.current?.dispose()
      sceneDecorRef.current = null
    }
  }, [webglSupported])

  /* ------------------------------------------------------------ auto-rotate -- */

  useEffect(() => {
    let frame = 0
    let attempts = 0
    const tick = (): void => {
      const controls = graphRef.current?.controls()
      if (controls) {
        controls.autoRotate = autoRotateRef.current
        controls.autoRotateSpeed = AUTO_ROTATE_SPEED
        controls.enableDamping = true
        return
      }
      attempts += 1
      if (attempts > 300) return
      frame = window.requestAnimationFrame(tick)
    }
    tick()
    return () => window.cancelAnimationFrame(frame)
  }, [autoRotate])

  // Any direct interaction pauses rotation; it resumes after a short idle gap.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    let idleTimer: number | undefined
    const pause = (): void => {
      interactedRef.current = true
      const controls = graphRef.current?.controls()
      if (controls) controls.autoRotate = false
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        const nextControls = graphRef.current?.controls()
        if (nextControls) nextControls.autoRotate = autoRotateRef.current
      }, AUTO_ROTATE_RESUME_MS)
    }
    const events = ['pointerdown', 'wheel', 'touchstart'] as const
    for (const event of events) element.addEventListener(event, pause, { passive: true })
    return () => {
      for (const event of events) element.removeEventListener(event, pause)
      window.clearTimeout(idleTimer)
    }
  }, [])

  /* ------------------------------------------------------------------ framing -- */

  /**
   * Frame every rendered node deterministically.
   *
   * The library's `zoomToFit` fits the bounding *sphere*, which leaves a lot of
   * dead space with a spread-out 3D layout; computing the distance from the
   * box + camera FOV keeps the constellation filling the canvas.
   */
  const fitView = useCallback(
    (durationMs = CAMERA_RESET_MS) => {
      const controller = graphRef.current
      if (!controller) return
      const nodes = [...nodeByIdRef.current.values()]
      if (nodes.length === 0) return
      const box = new THREE.Box3()
      const point = new THREE.Vector3()
      for (const node of nodes) {
        box.expandByPoint(point.set(node.x ?? 0, node.y ?? 0, node.z ?? 0))
      }
      const center = box.getCenter(new THREE.Vector3())
      const extent = box.getSize(new THREE.Vector3())
      const viewportAspect =
        size.width > 0 && size.height > 0 ? size.width / size.height : 1.6
      const halfTanFov = Math.tan((75 * Math.PI) / 180 / 2)
      const spanHeight = Math.max(extent.y, 48)
      // Auto-rotation sweeps the horizontal axis, so the worst-case horizontal
      // extent is the XZ-plane diameter, not just the current X span.
      const spanHorizontal = Math.max(Math.hypot(extent.x, extent.z), 48)
      const distance =
        Math.max(
          spanHeight / 2 / halfTanFov,
          spanHorizontal / 2 / (halfTanFov * viewportAspect)
        ) *
          1.18 +
        20
      const current = controller.cameraPosition()
      const direction = new THREE.Vector3(
        current.x - center.x,
        current.y - center.y,
        current.z - center.z
      )
      if (direction.lengthSq() < 1e-4) direction.set(0, 0, 1)
      direction.normalize().multiplyScalar(distance)
      controller.cameraPosition(
        { x: center.x + direction.x, y: center.y + direction.y, z: center.z + direction.z },
        { x: center.x, y: center.y, z: center.z },
        durationMs
      )
    },
    [size.width, size.height]
  )

  /* ---------------------------------------------------------------- auto-fit -- */

  // Re-frame whenever the visible set changes (scope switch / filter toggle) so
  // the constellation always fills the canvas instead of floating off-centre.
  // `onEngineStop` is the accurate signal (the simulation has settled); the timer
  // is only a fallback for the rare case where the engine never reports stopping.
  useEffect(() => {
    if (nodes.length === 0) return
    fittedRef.current = false
    interactedRef.current = false
    window.clearTimeout(autoFitTimerRef.current)
    autoFitTimerRef.current = window.setTimeout(() => {
      if (fittedRef.current || interactedRef.current) return
      fittedRef.current = true
      fitView()
    }, 3200)
    return () => window.clearTimeout(autoFitTimerRef.current)
  }, [nodes, fitView])

  const handleEngineStop = useCallback(() => {
    if (fittedRef.current || interactedRef.current) return
    fittedRef.current = true
    window.clearTimeout(autoFitTimerRef.current)
    fitView()
  }, [fitView])

  /* ------------------------------------------------------------ imperative -- */

  const focusNode = useCallback((nodeId: string) => {
    const controller = graphRef.current
    const node = nodeByIdRef.current.get(nodeId)
    if (!controller || !node) return
    // A deliberate focus must win over a pending automatic re-frame.
    interactedRef.current = true
    fittedRef.current = true
    window.clearTimeout(autoFitTimerRef.current)
    const targetX = node.x ?? 0
    const targetY = node.y ?? 0
    const targetZ = node.z ?? 0
    const current = controller.cameraPosition()
    const offset = new THREE.Vector3(current.x - targetX, current.y - targetY, current.z - targetZ)
    if (offset.lengthSq() < 1e-4) offset.set(0, 0, 1)
    offset.setLength(nodeRadius(node) * 7 + 55)
    controller.cameraPosition(
      { x: targetX + offset.x, y: targetY + offset.y, z: targetZ + offset.z },
      { x: targetX, y: targetY, z: targetZ },
      CAMERA_FOCUS_MS
    )
  }, [])

  const resetView = useCallback(() => {
    fitView()
  }, [fitView])

  const zoomToFit = useCallback(() => {
    fitView(CAMERA_RESET_MS)
  }, [fitView])

  /** Read the current WebGL frame; requires `preserveDrawingBuffer`. */
  const captureImage = useCallback((): string | null => {
    const container = containerRef.current
    if (container === null) return null
    const canvas = container.querySelector('canvas')
    if (!(canvas instanceof HTMLCanvasElement)) return null
    try {
      return canvas.toDataURL('image/png')
    } catch {
      return null
    }
  }, [])

  useImperativeHandle(ref, () => ({ focusNode, resetView, zoomToFit, captureImage }), [
    focusNode,
    resetView,
    zoomToFit,
    captureImage
  ])

  /* ---------------------------------------------------------------- cleanup -- */

  // A lost WebGL context (GPU reset, memory pressure, long background tab) must
  // not leave a frozen black canvas without an explanation.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const onLost = (event: Event): void => {
      // Prevent default so the browser may still attempt an automatic restore.
      event.preventDefault()
      setContextLost(true)
    }
    const onRestored = (): void => setContextLost(false)
    container.addEventListener('webglcontextlost', onLost, true)
    container.addEventListener('webglcontextrestored', onRestored, true)
    return () => {
      container.removeEventListener('webglcontextlost', onLost, true)
      container.removeEventListener('webglcontextrestored', onRestored, true)
    }
  }, [webglSupported])

  useEffect(() => {
    mountGenerationRef.current += 1
    const generation = mountGenerationRef.current
    return () => {
      // Deferred one tick so React StrictMode's simulated remount can claim the
      // caches back before the real unmount frees them.
      window.setTimeout(() => {
        if (mountGenerationRef.current !== generation) return
        const visuals = visualsRef.current
        for (const visual of visuals.values()) disposeVisual(visual)
        visuals.clear()
        for (const texture of glowCacheRef.current.values()) texture.dispose()
        glowCacheRef.current.clear()
        window.clearTimeout(autoFitTimerRef.current)
      }, 0)
    }
  }, [])

  /* ----------------------------------------------------------------- render -- */

  const heavyGraph = nodes.length + links.length > PERFORMANCE_ELEMENT_LIMIT

  if (!webglSupported) {
    // P3 2D fallback: keep search/filter/selection usable without a GPU.
    return (
      <NebulaGraph2D
        nodes={nodes}
        links={links}
        selectedId={selectedId}
        highlightIds={highlightIds}
        focusIds={focusIds}
        performanceMode={performanceMode}
        onSelect={onSelect}
        className={className}
      />
    )
  }

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={t('nebula.canvas.ariaLabel')}
      className={cn('relative h-full w-full touch-none overflow-hidden', className)}
      style={{ backgroundColor: NEBULA_BACKGROUND }}
    >
      {size.width > 0 && size.height > 0 ? (
        <ForceGraph3D
          ref={graphRef}
          graphData={graphData}
          width={size.width}
          height={size.height}
          backgroundColor={NEBULA_BACKGROUND}
          showNavInfo={false}
          nodeId="id"
          nodeVal={nodeValue}
          nodeLabel={emptyNodeLabel}
          rendererConfig={{ preserveDrawingBuffer: true, antialias: true }}
          enableNodeDrag
          warmupTicks={20}
          cooldownTicks={140}
          d3AlphaDecay={0.022}
          nodeThreeObject={buildNodeObject}
          linkThreeObject={createLinkObject}
          linkPositionUpdate={updateLinkPosition}
          onNodeClick={handleNodeClick}
          onNodeHover={handleNodeHover}
          onBackgroundClick={handleBackgroundClick}
          onEngineStop={handleEngineStop}
        />
      ) : null}

      {contextLost ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-[#050505]/75 px-6 backdrop-blur-sm">
          <div className="max-w-[380px] rounded-xl border border-amber-400/25 bg-[#0b0c10]/[0.9] px-6 py-5 text-center">
            <p className="text-[13px] font-medium text-amber-200/90">
              {t('nebula.webglLost.title')}
            </p>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/45">
              {t('nebula.webglLost.description')}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 inline-flex h-8 items-center rounded-md border border-white/[0.12] bg-white/[0.06] px-3 text-[12px] text-white/75 transition-colors hover:bg-white/[0.1] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#050505]"
            >
              {t('nebula.webglLost.restore')}
            </button>
          </div>
        </div>
      ) : null}

      {heavyGraph ? (
        <div className="pointer-events-none absolute left-1/2 top-3 z-10 w-[min(22rem,calc(100%-2rem))] -translate-x-1/2 rounded-lg border border-amber-400/25 bg-[#0b0c10]/[0.82] px-3 py-2 text-center backdrop-blur-xl">
          <p className="text-[11.5px] font-medium text-amber-200/90">
            {t('nebula.performance.title')}
          </p>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-white/40">
            {t('nebula.performance.description', {
              nodes: nodes.length,
              links: links.length,
              limit: PERFORMANCE_ELEMENT_LIMIT
            })}
          </p>
        </div>
      ) : null}
    </div>
  )
})
