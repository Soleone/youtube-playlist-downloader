# YouTube Playlist Downloader

Download YouTube videos or playlists as MP3 files.

## Quick start

```bash
./yt-download.sh "YOUTUBE_PLAYLIST_OR_VIDEO_URL"
```

Downloads go to `./downloads` by default.

To choose a different output directory:

```bash
./yt-download.sh "YOUTUBE_PLAYLIST_OR_VIDEO_URL" ~/Music/youtube
```

## First run

The script auto-installs user-local dependencies where possible:

- `yt-dlp`
- `deno`

You still need these system dependencies installed:

- `python3` + `pip`, used to install `yt-dlp`
- `ffmpeg`, used to create MP3 files

If either is missing, the script prints the right install command for your OS.

Common installs:

```bash
# macOS
brew install python ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install -y python3 python3-pip ffmpeg

# Fedora
sudo dnf install python3 python3-pip ffmpeg

# Arch
sudo pacman -S python python-pip ffmpeg
```

## Options

```bash
./yt-download.sh --force "URL"
```

Overwrite existing files.

```bash
./yt-download.sh --split "URL"
```

Split long MP3s into tracks using YouTube chapters first, then silence detection as a fallback. Requires `ffprobe`, usually included with `ffmpeg`.

## Examples

```bash
./yt-download.sh "https://www.youtube.com/playlist?list=..."
./yt-download.sh --force "https://www.youtube.com/watch?v=..."
./yt-download.sh --split "https://www.youtube.com/watch?v=..." ./downloads
```
