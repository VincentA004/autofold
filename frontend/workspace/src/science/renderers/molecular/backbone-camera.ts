import type { Structure } from 'molstar/lib/mol-model/structure'
import type { Camera } from 'molstar/lib/mol-canvas3d/camera'
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra'

/** Frame the actual trace with the approved demo's orientation and padding. */
export function backboneCamera(structures: Structure[], width: number, height: number, fov: number): Partial<Camera.Snapshot> | undefined {
  const points: Vec3[] = []
  for (const structure of structures) for (const unit of structure.units) for (let i = 0; i < unit.polymerElements.length; i++) {
    const p = Vec3(); unit.conformation.position(unit.polymerElements[i], p); points.push(p)
  }
  if (!points.length || width <= 0 || height <= 0) return
  const center = Vec3()
  for (const p of points) Vec3.add(center, center, p)
  Vec3.scale(center, center, 1 / points.length)
  const ax = -.28, ay = .8
  const right = Vec3.create(Math.cos(ay), 0, Math.sin(ay))
  const up = Vec3.create(Math.sin(ax) * Math.sin(ay), Math.cos(ax), -Math.sin(ax) * Math.cos(ay))
  const back = Vec3.create(-Math.cos(ax) * Math.sin(ay), Math.sin(ax), Math.cos(ax) * Math.cos(ay))
  const delta = Vec3()
  let extentX = 1, extentY = 1, radius = 1
  for (const p of points) {
    Vec3.sub(delta, p, center)
    extentX = Math.max(extentX, Math.abs(Vec3.dot(delta, right)))
    extentY = Math.max(extentY, Math.abs(Vec3.dot(delta, up)))
    radius = Math.max(radius, Vec3.magnitude(delta))
  }
  const scale = Math.min(width * .38 / extentX, height * .39 / extentY)
  const distance = height / (2 * scale * Math.tan(fov / 2))
  const target = Vec3.scaleAndAdd(Vec3(), center, up, -.01 * height / scale)
  return { mode: 'orthographic', position: Vec3.scaleAndAdd(Vec3(), target, back, distance), target, up, radius: radius + 2, radiusMax: radius + 2 }
}
