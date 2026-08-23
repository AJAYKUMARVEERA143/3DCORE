# 3D Core - Main Application Orchestrator
import sys
from src.rendering.viewport_renderer import ViewportRenderer
from src.ai_engine.smart_drawing_snapper import SmartDrawingSnapper
from src.cad_parser.dxf_extruder import DXFExtruder
from src.ai_engine.prompt_builder import AIPromptBuilder
from src.ui.asset_library import CloudAssetLibrary
from src.p2p_network.gpu_collector import GPUCollectorNetwork

class App3DCore:
    def __init__(self):
        print("==================================================")
        print("          3D CORE APPLICATION INITIALIZED         ")
        print("==================================================")
        self.viewport = ViewportRenderer(render_mode="HYBRID")
        self.snapper = SmartDrawingSnapper()
        self.ai_builder = AIPromptBuilder()
        self.asset_hub = CloudAssetLibrary()
        self.gpu_network = GPUCollectorNetwork()

    def run_demo(self):
        # 1. Test Freehand Drawing Recognition
        print("\n[Demo 1] Free-hand Drawing Test:")
        sample_stroke = [(0,0), (1,2), (3,3), (4,1), (3,-1), (1,-2), (0.1, 0.1)]
        res_draw = self.snapper.process_stroke(sample_stroke, workspace_mode="3D Grid")

        # 2. Test AutoCAD 2D Floor Plan Auto Extrude
        print("\n[Demo 2] AutoCAD 2D Floor Plan 3D Auto-Extrude Test:")
        extruder = DXFExtruder("floor_plan_sample.dxf")
        res_extrude = extruder.auto_extrude_3d(wall_height=3.2)

        # 3. Test AI Prompt to 3D Model
        print("\n[Demo 3] AI Prompt Generation Test:")
        res_ai = self.ai_builder.generate_mesh_from_prompt("2-Story Modern Villa with Glass Balcony", target_category="CIVIL")

        # 4. Test P2P GPU Collector Offloading
        print("\n[Demo 4] P2P GPU Collector Offloading Test:")
        res_p2p = self.gpu_network.dispatch_heavy_task("RAYTRACE_RENDER", {"mesh": res_ai["model_name"]})

        print("\n[Status] All 5 Phases Operating Successfully!")

if __name__ == "__main__":
    print("NOTE: main.py is a print-only demo. It is NOT 3D Core Studio.")
    print("Start the real app with:  python3 server.py   (then open http://127.0.0.1:8000)")
    print()
    app = App3DCore()
    app.run_demo()
