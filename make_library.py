#!/usr/bin/env python3
"""Build library/songs.json from the audio files in the library/ folder.

Put MP3s you own in library/ (subfolders are fine), then run:
    python3 make_library.py
Every device that opens your Sur site will then see these songs under
Library > Server. Reads tags with `mutagen` if installed (pip install mutagen),
otherwise uses "Artist - Title.mp3" file names.
"""
import json, os, re, time

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'library')
EXTS = ('.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wav')
try:
    import mutagen
except ImportError:
    mutagen = None

def tags_for(path):
    out = {}
    if mutagen:
        try:
            f = mutagen.File(path, easy=True)
            if f is not None:
                for k in ('title', 'artist', 'album'):
                    if f.get(k):
                        out[k] = f[k][0]
                if f.info and getattr(f.info, 'length', None):
                    out['duration'] = round(f.info.length, 1)
        except Exception:
            pass
    if 'title' not in out:
        base = re.sub(r'^\d{1,3}[\s.\-]+', '', os.path.splitext(os.path.basename(path))[0].replace('_', ' ')).strip()
        parts = base.split(' - ', 1)
        if len(parts) == 2:
            out.setdefault('artist', parts[0]); base = parts[1]
        out['title'] = base
    return out

songs = []
for dirpath, _, files in os.walk(ROOT):
    for name in sorted(files):
        if not name.lower().endswith(EXTS):
            continue
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, ROOT).replace(os.sep, '/')
        song = {'file': rel, **tags_for(full), 'addedAt': int(os.path.getmtime(full) * 1000)}
        for c in ('cover.jpg', 'cover.png', 'folder.jpg'):
            if os.path.exists(os.path.join(dirpath, c)):
                song['cover'] = os.path.relpath(os.path.join(dirpath, c), ROOT).replace(os.sep, '/')
                break
        songs.append(song)

with open(os.path.join(ROOT, 'songs.json'), 'w', encoding='utf-8') as fh:
    json.dump({'generated': int(time.time()), 'songs': songs}, fh, ensure_ascii=False, indent=1)
print(f'Wrote {len(songs)} songs to library/songs.json')
