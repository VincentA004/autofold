import { StateObjectRef } from "molstar/lib/mol-state"
import { StructureRepresentationPresetProvider, presetStaticComponent } from "molstar/lib/mol-plugin-state/builder/structure/representation-preset"
import { Color } from "molstar/lib/mol-util/color"
import { BackboneHighlights } from "./backbone-highlights"
import { UniformColorThemeProvider } from "molstar/lib/mol-theme/color/uniform"
import { UniformSizeThemeProvider } from "molstar/lib/mol-theme/size/uniform"

/** A uniform-width trace, never a B-factor/confidence-sized putty display. */
export const BackbonePreset = StructureRepresentationPresetProvider({
  id: "autofold-backbone",
  display: { name: "Backbone" },
  params: () => ({}),
  async apply(ref, _params, plugin) {
    const structure = StateObjectRef.resolveAndCheck(plugin.state.data, ref)
    if (!structure) return {}
    const polymer = await presetStaticComponent(plugin, structure, "polymer")
    const registry = plugin.representation.structure.registry
    if (!registry.types.some(([name]) => name === BackboneHighlights.name)) registry.add(BackboneHighlights)
    const update = plugin.state.data.build()
    const representation = plugin.builders.structure.representation.buildRepresentation(update, polymer, {
      type: "putty",
      typeParams: { sizeFactor: 0.9, quality: "high", visuals: ["polymer-tube", "polymer-gap"], alpha: 0.82, ignoreLight: true },
      size: "uniform",
      sizeParams: { value: 1 },
      color: "chain-id",
      colorParams: {
        asymId: "label",
        palette: { name: "colors", params: { list: { kind: "set", colors: [Color(0x939ba3), Color(0x5fc2b6), Color(0xb6a1ce), Color(0xd5b47a), Color(0x7fa9c8)] } } },
      },
    }, { tag: "autofold-backbone" })
    const highlights = plugin.builders.structure.representation.buildRepresentation(update, polymer, {
      type: BackboneHighlights,
      typeParams: { alpha: 0.55, ignoreLight: true },
      color: UniformColorThemeProvider,
      colorParams: { value: Color(0xe2f1ea) },
      size: UniformSizeThemeProvider,
    }, { tag: "autofold-backbone-highlights" })
    await update.commit({ revertOnError: true })
    return { components: { polymer }, representations: { polymer: representation, highlights } }
  },
})
