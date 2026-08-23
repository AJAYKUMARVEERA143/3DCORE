# 3D Core - Smart Free-Hand Vector Snap Engine (Phase 2)
import math

class SmartDrawingSnapper:
    def __init__(self, snapping_tolerance=0.85):
        self.tolerance = snapping_tolerance

    def process_stroke(self, raw_points, workspace_mode="3D"):
        if not raw_points or len(raw_points) < 2:
            return {"status": "INVALID_STROKE"}

        shape_type = self._detect_geometric_shape(raw_points)
        dimensions = self._calculate_dimensions(shape_type, raw_points)

        print(f"[SmartSnap] Workspace: {workspace_mode}")
        print(f"[SmartSnap] Gesture Detected: {shape_type}")

        return {
            "status": "SUCCESS",
            "recognized_shape": shape_type,
            "interactive_dimensions": dimensions,
            "snapped_points": self._generate_snapped_geometry(shape_type, raw_points)
        }

    def _detect_geometric_shape(self, points):
        start_point = points[0]
        end_point = points[-1]
        dist = math.hypot(end_point[0] - start_point[0], end_point[1] - start_point[1])

        if len(points) > 8 and dist < 1.5:
            return "CIRCLE"
        elif len(points) > 12 and dist < 3.0:
            return "RECTANGLE"
        else:
            return "STRAIGHT_LINE"

    def _calculate_dimensions(self, shape_type, points):
        if shape_type == "CIRCLE":
            return {"prompt": "Specify Circle Dimensions", "fields": ["Radius (r)", "Diameter (d)"], "default_value_m": 2.5}
        elif shape_type == "RECTANGLE":
            return {"prompt": "Specify Rectangle Dimensions", "fields": ["Length (L)", "Width (W)"], "default_value_m": "5.0 x 3.0"}
        else:
            length = math.hypot(points[-1][0] - points[0][0], points[-1][1] - points[0][1])
            return {"prompt": "Specify Line Length", "fields": ["Length (m)"], "default_value_m": round(length, 2)}

    def _generate_snapped_geometry(self, shape_type, points):
        if shape_type == "STRAIGHT_LINE":
            return [points[0], points[-1]]
        return points
