import { Mesh } from "molstar/lib/mol-geo/geometry/mesh/mesh"
import { MeshBuilder } from "molstar/lib/mol-geo/geometry/mesh/mesh-builder"
import { addCylinder } from "molstar/lib/mol-geo/geometry/mesh/builder/cylinder"
import { addSphere } from "molstar/lib/mol-geo/geometry/mesh/builder/sphere"
import { Sphere3D } from "molstar/lib/mol-math/geometry"
import { Vec3 } from "molstar/lib/mol-math/linear-algebra"
import { isNucleic } from "molstar/lib/mol-model/structure/model/types"
import { StructureRepresentationProvider } from "molstar/lib/mol-repr/structure/representation"
import { UnitsRepresentation } from "molstar/lib/mol-repr/structure/units-representation"
import { UnitsMeshParams, UnitsMeshVisual } from "molstar/lib/mol-repr/structure/units-visual"
import { createCurveSegmentState, PolymerTraceIterator, interpolateCurveSegment, PolymerLocationIterator, getPolymerElementLoci, eachPolymerElement, StandardTension, StandardShift, NucleicShift } from "molstar/lib/mol-repr/structure/visual/util/polymer"
import { ParamDefinition as PD } from "molstar/lib/mol-util/param-definition"

const Params = { ...UnitsMeshParams }

/** Decorative dashes follow Mol*'s own smoothed polymer trace, including breaks.
 * They do not represent bonds, contacts, confidence, or missing residues. */
function HighlightVisual(materialId: number) {
  return UnitsMeshVisual({
    defaultProps: PD.getDefaultValues(Params),
    createGeometry(_ctx, unit, structure, _theme, _props, oldMesh) {
      if (!unit.polymerElements.length) return Mesh.createEmpty(oldMesh)
      const mesh = MeshBuilder.createState(unit.polymerElements.length * 240, 1024, oldMesh)
      const curve = createCurveSegmentState(12)
      const iterator = PolymerTraceIterator(unit, structure, { ignoreSecondaryStructure: true })
      const a = Vec3(), b = Vec3()
      const radius = 0.2
      let group = 0
      while (iterator.hasNext) {
        const trace = iterator.move()
        interpolateCurveSegment(curve, trace, StandardTension, isNucleic(trace.moleculeType) ? NucleicShift : StandardShift)
        mesh.currentGroup = group++
        // Two short, rounded highlights per residue; keep the end extensions
        // clear so the overlay cannot imply connections across chain breaks.
        for (const start of [2, 8]) {
          Vec3.fromArray(a, curve.curvePoints, start * 3)
          Vec3.fromArray(b, curve.curvePoints, (start + 2) * 3)
          addCylinder(mesh, a, b, 1, { radiusTop: radius, radiusBottom: radius, radialSegments: 8 })
          addSphere(mesh, a, radius, 0)
          addSphere(mesh, b, radius, 0)
        }
      }
      const result = MeshBuilder.getMesh(mesh)
      result.setBoundingSphere(Sphere3D.expand(Sphere3D(), unit.boundary.sphere, radius))
      return result
    },
    createLocationIterator: group => PolymerLocationIterator.fromGroup(group, { asSecondary: true }),
    getLoci: getPolymerElementLoci,
    eachLocation: eachPolymerElement,
    setUpdateState() {},
  }, materialId)
}

export const BackboneHighlights = StructureRepresentationProvider({
  name: "autofold-backbone-highlights",
  label: "Backbone highlights",
  description: "Decorative centerline highlights on the smoothed polymer trace.",
  factory(ctx, getParams) {
    const repr = UnitsRepresentation("Backbone highlights", ctx, getParams, HighlightVisual)
    // Keep picking and scientific selections on the actual backbone tube.
    repr.setState({ pickable: false })
    return repr
  },
  getParams: () => Params,
  defaultValues: PD.getDefaultValues(Params),
  defaultColorTheme: { name: "uniform" },
  defaultSizeTheme: { name: "uniform" },
  isApplicable: structure => structure.polymerResidueCount > 0,
})
