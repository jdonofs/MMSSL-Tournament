from __future__ import annotations

import html
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = REPO_ROOT / "supabase-schema.sql"
OUTPUT_DIR = REPO_ROOT / "public" / "characters"
METADATA_PATH = REPO_ROOT / "src" / "data" / "characterImages.json"
SOURCE_PAGE = "https://www.mariowiki.com/Mario_Super_Sluggers"


def fetch_text(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; SluggersTournamentTracker/1.0)"
        },
    )
    with urllib.request.urlopen(request) as response:
        return response.read().decode("utf-8", errors="ignore")


def fetch_bytes(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; SluggersTournamentTracker/1.0)"
        },
    )
    with urllib.request.urlopen(request) as response:
        return response.read()


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower())
    return slug.strip("-")


def parse_seed_names(schema_text: str) -> list[str]:
    names = re.findall(r"\('([^']+)',\s*\d+,\s*\d+,\s*\d+,\s*\d+\)", schema_text)
    if len(names) != 72:
        raise RuntimeError(f"Expected 72 seeded characters, found {len(names)}")
    return names


def choose_best_image_url(img_tag: str) -> str | None:
    srcset_match = re.search(r'srcset="([^"]+)"', img_tag)
    if srcset_match:
        candidates = [item.strip().split(" ")[0] for item in srcset_match.group(1).split(",")]
        if candidates:
            return urllib.parse.urljoin(SOURCE_PAGE, candidates[-1])

    src_match = re.search(r'src="([^"]+)"', img_tag)
    if src_match:
        return urllib.parse.urljoin(SOURCE_PAGE, src_match.group(1))

    return None


def extract_name_from_cell(cell_html: str) -> str | None:
    links = re.findall(r"<a [^>]*>([^<]+)</a>", cell_html)
    return html.unescape(links[0]).strip() if links else None


def extract_roster_images(page_html: str) -> dict[str, dict[str, str]]:
    start = page_html.find('id="Team_captains"')
    end = page_html.find('id="Chemistry"')
    if start == -1 or end == -1 or end <= start:
        raise RuntimeError("Could not locate playable character section in source page")

    section = page_html[start:end]
    cell_pattern = re.compile(
        r'<td data-sort-value="[^"]+">(.*?)</td>',
        re.S,
    )

    image_map: dict[str, dict[str, str]] = {}
    for cell in cell_pattern.findall(section):
        if 'class="image"' not in cell:
            continue

        img_match = re.search(r"(<img[^>]+>)", cell, re.S)
        if not img_match:
            continue

        name = extract_name_from_cell(cell)
        image_url = choose_best_image_url(img_match.group(1))
        file_page_match = re.search(r'<a href="(/File:[^"]+)" class="image">', cell)

        if not name or not image_url:
            continue

        image_map[name] = {
            "image_url": image_url,
            "file_page_url": urllib.parse.urljoin(SOURCE_PAGE, file_page_match.group(1)) if file_page_match else SOURCE_PAGE,
            "source_page_url": SOURCE_PAGE,
        }

    return image_map


def extract_og_image(page_html: str) -> str | None:
    og_match = re.search(r'<meta property="og:image" content="([^"]+)"', page_html)
    return urllib.parse.urljoin(SOURCE_PAGE, og_match.group(1)) if og_match else None


def build_fallback_entry(character_name: str) -> dict[str, str]:
    page_url = f"https://www.mariowiki.com/{urllib.parse.quote(character_name.replace(' ', '_'))}"
    page_html = fetch_text(page_url)
    image_url = extract_og_image(page_html)
    if not image_url:
        raise RuntimeError(f"Could not find fallback image for {character_name}")
    return {
        "image_url": image_url,
        "file_page_url": page_url,
        "source_page_url": page_url,
    }


def guess_extension(image_url: str) -> str:
    path = urllib.parse.urlparse(image_url).path
    extension = Path(path).suffix.lower()
    return extension if extension in {".png", ".jpg", ".jpeg", ".webp"} else ".png"


def canonical_name_map(scraped: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
    aliases = {
        "Light-Blue Yoshi": "Light Blue Yoshi",
    }

    normalized = dict(scraped)
    for canonical_name, source_name in aliases.items():
        if source_name in normalized and canonical_name not in normalized:
            normalized[canonical_name] = normalized[source_name]
    return normalized


def main() -> None:
    schema_text = SCHEMA_PATH.read_text(encoding="utf-8")
    seed_names = parse_seed_names(schema_text)
    page_html = fetch_text(SOURCE_PAGE)
    image_sources = canonical_name_map(extract_roster_images(page_html))

    for name in seed_names:
        if name not in image_sources:
            image_sources[name] = build_fallback_entry(name)

    missing = [name for name in seed_names if name not in image_sources]
    if missing:
        raise RuntimeError(f"Missing image sources for: {', '.join(missing)}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    METADATA_PATH.parent.mkdir(parents=True, exist_ok=True)

    metadata = []
    for name in seed_names:
        entry = image_sources[name]
        extension = guess_extension(entry["image_url"])
        filename = f"{slugify(name)}{extension}"
        output_path = OUTPUT_DIR / filename
        output_path.write_bytes(fetch_bytes(entry["image_url"]))
        metadata.append(
            {
                "name": name,
                "fileName": filename,
                "publicPath": f"/characters/{filename}",
                "sourcePage": entry["source_page_url"],
                "sourceFilePage": entry["file_page_url"],
                "downloadUrl": entry["image_url"],
            }
        )

    METADATA_PATH.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"Downloaded {len(metadata)} character images to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
