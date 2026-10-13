# teacher-eval

English-class parser and teacher evaluation. Drop a recording, store the audio and transcript, then open one saved review of the teacher.

## Flow

1. **Transcribe** — drop an MP3, WAV, M4A, or WEBM. The audio and diarized transcript are saved in MinIO under a unique class id.
2. **Parser** — pick a saved class and play each speaker chunk.
3. **Agent** — with no class selected, the page stays empty. A class that already has a review opens that saved file. A class with no review is evaluated once with gpt-4o-mini and stored in that class folder.

Each class lives in its own MinIO folder: `{id}/` for the audio, `{id}/transcript.json`, and `{id}/evaluation.json`.

## Run

```bash
pip install -r requirements.txt
```

Start MinIO locally (`minioadmin` / `minioadmin`, bucket `class-voices`), put your AvalAI key in `.env` as `aval_ai`, then:

```bash
python -m uvicorn server.main:app --host 127.0.0.1 --port 8765
```

Open http://127.0.0.1:8765
