# 3D Core - Cloud Asset Hub & Smart Auto-Suggest Engine (Phase 4)

class CloudAssetLibrary:
    def __init__(self):
        self.downloaded_cache = []
        self.categories = ["Furniture", "Mechanical Parts", "Civil Structures", "Textures"]

    def fetch_categories(self):
        return self.categories

    def download_asset(self, asset_id):
        print(f"[Asset Hub] Downloading asset '{asset_id}' to local permanent storage...")
        if asset_id not in self.downloaded_cache:
            self.downloaded_cache.append(asset_id)
        print(f"[Asset Hub] Asset cached permanently. (User can delete anytime).")

    def delete_local_asset(self, asset_id):
        if asset_id in self.downloaded_cache:
            self.downloaded_cache.remove(asset_id)
            print(f"[Asset Hub] Asset '{asset_id}' removed from local memory.")

    def auto_suggest_placement(self, surface_type):
        print(f"[Auto-Suggest] Selected surface context: '{surface_type}'.")
        suggestions = {
            "FLOOR": ["Modern Sofas", "Dining Tables", "Office Chairs"],
            "WALL": ["Wall Art", "Wall Lamps", "Bookshelves"],
            "MECHANICAL_SHAFT": ["Flange Adapter", "Ball Bearings", "Locking Pins"]
        }
        return suggestions.get(surface_type, ["Generic Prop"])

    def tap_to_swap(self, current_asset_id, category):
        print(f"[Tap-to-Swap] User tapped on '{current_asset_id}'. Fetching variants for category '{category}'...")
        return [f"{category}_Variant_01", f"{category}_Variant_02", f"{category}_Variant_03"]
