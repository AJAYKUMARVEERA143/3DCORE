import urllib.request
import json
import os
import shutil

LOCAL_ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets')

def fetch_hf_tree(dataset_id, subpath='', recursive=True):
    url = f'https://huggingface.co/api/datasets/{dataset_id}/tree/main'
    if subpath:
        url += f'/{subpath}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())

def download_hf_file(dataset_id, hf_path, local_path):
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    url = f'https://huggingface.co/datasets/{dataset_id}/resolve/main/{hf_path}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        with open(local_path, 'wb') as f:
            shutil.copyfileobj(resp, f)
    return os.path.getsize(local_path)

def download_dataset(dataset_id, local_subdir, max_files=25, extensions=None):
    local_dir = os.path.join(LOCAL_ASSETS, local_subdir)
    os.makedirs(local_dir, exist_ok=True)
    print(f'\n=== Downloading: {dataset_id} -> {local_dir} ===')

    try:
        tree = fetch_hf_tree(dataset_id)
    except Exception as e:
        print(f'Error fetching tree root: {e}')
        return []

    downloaded = []

    # Collect all files (recurse into directories)
    def collect_files(items):
        all_files = []
        for item in items:
            if item.get('type') == 'file':
                all_files.append(item)
            elif item.get('type') == 'directory':
                try:
                    sub = fetch_hf_tree(dataset_id, item['path'])
                    all_files.extend(collect_files(sub))
                except Exception as e:
                    print(f'  Skipping subdir {item["path"]}: {e}')
        return all_files

    all_files = collect_files(tree)
    print(f'Total files found: {len(all_files)}')

    count = 0
    for item in all_files:
        if count >= max_files:
            print(f'  Reached max {max_files} files, stopping.')
            break
        hf_path = item.get('path', '')
        if not hf_path:
            continue
        if extensions:
            ext = os.path.splitext(hf_path)[1].lower()
            if ext not in extensions:
                continue

        local_path = os.path.join(local_dir, hf_path.replace('/', os.sep))
        if os.path.exists(local_path):
            print(f'  Already exists: {hf_path}')
            downloaded.append(local_path)
            count += 1
            continue
        try:
            sz = download_hf_file(dataset_id, hf_path, local_path)
            print(f'  [OK] {hf_path} ({sz:,} bytes)')
            downloaded.append(local_path)
            count += 1
        except Exception as e:
            print(f'  [FAIL] {hf_path}: {e}')

    print(f'\nDone: {len(downloaded)} files saved to {local_dir}')
    return downloaded

# ================================================================
# 1. Download dream-textures/textures-color-1k
#    PNG/JPG textures: Albedo, Normal, Roughness, AO maps
# ================================================================
dream_files = download_dataset(
    dataset_id='dream-textures/textures-color-1k',
    local_subdir='textures/dream-textures-color-1k',
    max_files=50,
    extensions=['.png', '.jpg', '.jpeg', '.webp', '.parquet', '.json', '.md']
)

# ================================================================
# 2. Download YiboZhang2001/TexVerse-1K
#    GLB files with embedded PBR textures/materials
# ================================================================
texverse_files = download_dataset(
    dataset_id='YiboZhang2001/TexVerse-1K',
    local_subdir='TexVerse',
    max_files=10,
    extensions=['.glb', '.gltf', '.json', '.md', '.yaml']
)

print('\n==================================================')
print('Local Asset Store Summary:')
print(f'  dream-textures/textures-color-1k: {len(dream_files)} files')
print(f'  YiboZhang2001/TexVerse-1K:        {len(texverse_files)} files')
print('==================================================')
