#!/bin/bash

# YouTube downloader - no API limits
# Usage: ./yt-download.sh [--force] [--split] [youtube_url] [output_directory]
# First run auto-installs user-local dependencies where possible: yt-dlp and deno.
# Python 3 and ffmpeg must be installed with your system package manager if missing.

set -euo pipefail

HAS_GUM=false
command -v gum &> /dev/null && HAS_GUM=true

info() { $HAS_GUM && gum style --foreground 212 "→ $1" || echo "→ $1"; }
success() { $HAS_GUM && gum style --foreground 42 "✓ $1" || echo "✓ $1"; }
error() { $HAS_GUM && gum style --foreground 196 "✗ $1" >&2 || echo "✗ $1" >&2; }

install_system_tools_hint() {
    local tools="$1"
    local apt_tools="$2"
    local dnf_tools="$3"
    local pacman_tools="$4"

    case "$(uname -s)" in
        Darwin)
            info "Install missing system tools with: brew install $tools"
            ;;
        Linux)
            if command -v apt-get &> /dev/null; then
                info "Install missing system tools with: sudo apt update && sudo apt install -y $apt_tools"
            elif command -v dnf &> /dev/null; then
                info "Install missing system tools with: sudo dnf install $dnf_tools"
            elif command -v pacman &> /dev/null; then
                info "Install missing system tools with: sudo pacman -S $pacman_tools"
            else
                info "Install missing system tools with your package manager: $tools"
            fi
            ;;
        *)
            info "Install missing system tools with your package manager: $tools"
            ;;
    esac
}

ensure_python() {
    if ! command -v python3 &> /dev/null; then
        error "python3 is required to install yt-dlp"
        install_system_tools_hint "python" "python3 python3-pip" "python3 python3-pip" "python python-pip"
        exit 1
    fi
}

ensure_yt_dlp() {
    export PATH="$HOME/.local/bin:$PATH"

    if command -v yt-dlp &> /dev/null; then
        return
    fi

    ensure_python
    info "Setting up yt-dlp..."
    python3 -m pip install --user -q yt-dlp 2>/dev/null || {
        error "Failed to install yt-dlp"
        exit 1
    }

    if ! command -v yt-dlp &> /dev/null; then
        error "yt-dlp installed but is not on PATH"
        info "Add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
        exit 1
    fi

    success "yt-dlp ready"
    echo ""
}

ensure_deno() {
    export DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
    export PATH="$DENO_INSTALL/bin:$PATH"

    if command -v deno &> /dev/null; then
        return
    fi

    if ! command -v curl &> /dev/null; then
        error "curl is required to install deno"
        exit 1
    fi

    info "Setting up deno..."
    curl -fsSL https://deno.land/install.sh | sh >/dev/null || {
        error "Failed to install deno"
        exit 1
    }

    if ! command -v deno &> /dev/null; then
        error "deno installed but is not on PATH"
        info "Add to your shell profile: export DENO_INSTALL=\"\$HOME/.deno\""
        info "Add to your shell profile: export PATH=\"\$DENO_INSTALL/bin:\$PATH\""
        exit 1
    fi

    success "deno ready"
    info "For future shells, add: export DENO_INSTALL=\"\$HOME/.deno\""
    info "For future shells, add: export PATH=\"\$DENO_INSTALL/bin:\$PATH\""
    echo ""
}

ensure_ffmpeg() {
    if command -v ffmpeg &> /dev/null; then
        return
    fi

    error "ffmpeg is required to create MP3 files"
    install_system_tools_hint "ffmpeg" "ffmpeg" "ffmpeg" "ffmpeg"
    exit 1
}

ensure_ffprobe() {
    if command -v ffprobe &> /dev/null; then
        return
    fi

    error "--split requires ffprobe"
    install_system_tools_hint "ffmpeg" "ffmpeg" "ffmpeg" "ffmpeg"
    exit 1
}

FORCE=false
SPLIT=false
ARGS=()
for arg in "$@"; do
    case "$arg" in
        --force)
            FORCE=true
            ;;
        --split)
            SPLIT=true
            ;;
        *)
            ARGS+=("$arg")
            ;;
    esac
done

ensure_yt_dlp
ensure_deno
ensure_ffmpeg

if $SPLIT; then
    ensure_ffprobe
fi

if [ -z "${ARGS[0]:-}" ]; then
    $HAS_GUM && URL=$(gum input --placeholder "YouTube playlist/video URL") || read -r -p "URL: " URL
    [ -z "$URL" ] && exit 0
else
    URL="${ARGS[0]}"
fi

OUTPUT_DIR="${ARGS[1]:-./downloads}"
mkdir -p "$OUTPUT_DIR"

if $HAS_GUM; then
    gum style --border rounded --padding "0 1" "→ $OUTPUT_DIR"
else
    echo "→ $OUTPUT_DIR"
fi
echo ""

if $FORCE; then
    info "Downloading (overwrite mode)..."
else
    info "Downloading (skipping existing files)..."
fi

if $SPLIT; then
    info "Split mode enabled: chapter titles first, silence fallback"
fi

REF_FILE=$(mktemp)
CANDIDATES_FILE=$(mktemp)
trap 'rm -f "$REF_FILE" "$CANDIDATES_FILE"' EXIT

touch "$REF_FILE"

YTDLP_ARGS=(
    -x --audio-format mp3 --audio-quality 0
    --embed-thumbnail --add-metadata
    --extractor-args "youtube:player_client=android,web"
    --output "%(playlist,title)s/%(playlist_index,autonumber)02d - %(title)s.%(ext)s"
    --no-warnings
)

if $FORCE; then
    YTDLP_ARGS+=(--force-overwrites)
else
    YTDLP_ARGS+=(--no-overwrites)
fi

(
    cd "$OUTPUT_DIR"
    yt-dlp "${YTDLP_ARGS[@]}" "$URL"
)

if $SPLIT; then
    find "$OUTPUT_DIR" -type f -name "*.mp3" -newer "$REF_FILE" | sort > "$CANDIDATES_FILE"

    if [ -s "$CANDIDATES_FILE" ]; then
        while IFS= read -r file; do
            python3 - "$file" <<'PY'
import json
import re
import subprocess
import sys
from pathlib import Path

file_path = Path(sys.argv[1])
SILENCE_DB = "-35dB"
SILENCE_DURATION = "1.2"
MIN_LONG_FILE_SECONDS = 900
MIN_TRACK_SECONDS = 45


def run(cmd):
    return subprocess.run(cmd, text=True, capture_output=True)


def duration_seconds(path: Path) -> float:
    proc = run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
    ])
    if proc.returncode != 0:
        return 0.0
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return 0.0


def chapters(path: Path):
    proc = run([
        "ffprobe", "-v", "error",
        "-show_chapters",
        "-of", "json",
        str(path),
    ])
    if proc.returncode != 0:
        return []

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return []

    result = []
    for chapter in data.get("chapters", []):
        start = float(chapter.get("start_time", "0") or "0")
        end = float(chapter.get("end_time", "0") or "0")
        title = (chapter.get("tags", {}) or {}).get("title", "").strip()
        result.append((start, end, title))

    return [c for c in result if c[1] - c[0] >= MIN_TRACK_SECONDS]


def sanitize_filename(value: str) -> str:
    sanitized = re.sub(r"[\\/:*?\"<>|]", "-", value)
    sanitized = re.sub(r"\s+", " ", sanitized).strip(" .")
    return sanitized[:140] if sanitized else "Untitled"


def cut_segments(path: Path, segments, naming):
    produced = []
    for index, (start, end, title) in enumerate(segments, start=1):
        if naming == "chapter":
            name = f"{index:02d} - {sanitize_filename(title or f'Chapter {index}')}.mp3"
        else:
            name = f"{index:02d} - Part {index:02d}.mp3"

        out_file = path.with_name(name)
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(path),
            "-ss", f"{start:.3f}",
            "-to", f"{end:.3f}",
            "-c", "copy",
            str(out_file),
        ]
        cut = subprocess.run(cmd)
        if cut.returncode != 0:
            for created in produced:
                created.unlink(missing_ok=True)
            return False
        produced.append(out_file)

    return len(produced) >= 2


duration = duration_seconds(file_path)
chapter_segments = chapters(file_path)

if len(chapter_segments) >= 2:
    if cut_segments(file_path, chapter_segments, "chapter"):
        file_path.unlink(missing_ok=True)
        print(f"split by chapters: {file_path} -> {len(chapter_segments)} files")
    sys.exit(0)

if duration < MIN_LONG_FILE_SECONDS:
    sys.exit(0)

silence_probe = run([
    "ffmpeg", "-hide_banner", "-i", str(file_path),
    "-af", f"silencedetect=noise={SILENCE_DB}:d={SILENCE_DURATION}",
    "-f", "null", "-",
])

cuts = [float(match.group(1)) for match in re.finditer(r"silence_end:\s*([0-9.]+)", silence_probe.stderr)]
if not cuts:
    sys.exit(0)

boundaries = [0.0] + [c for c in cuts if 0 < c < duration] + [duration]
segments = []
for idx in range(len(boundaries) - 1):
    start = boundaries[idx]
    end = boundaries[idx + 1]
    if end - start >= MIN_TRACK_SECONDS:
        segments.append((start, end, ""))

if len(segments) < 2:
    sys.exit(0)

if cut_segments(file_path, segments, "silence"):
    file_path.unlink(missing_ok=True)
    print(f"split by silence: {file_path} -> {len(segments)} files")
PY
        done < "$CANDIDATES_FILE"
    fi
fi

echo ""
success "Done! → $OUTPUT_DIR"