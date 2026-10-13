# teacher-eval

asrparser BY EMBED. Upload an English class, keep the audio and the diarized transcript, then review the teacher once and reopen that same review later.

The app is a FastAPI server plus the pages in `ui-template`. Speech and the written review both go through [AvalAI](https://api.avalai.ir/v1), which speaks the OpenAI API. Files live in MinIO. The class list lives in SQLite.

## Pages

| Page | What it does |
| --- | --- |
| Transcribe | Drop an MP3, WAV, M4A, or WEBM (up to 25 MB). The page waits until the transcript is saved. There is no pause or cancel. |
| Parser | Pick a saved class from a search popup. Read the speaker chunks and play only that slice of the recording. |
| Agent | One teacher review. If no class is selected, the page says **Select class**. A saved review opens immediately. A class with no review is analyzed once. |
| History | A static sample table. Live classes are the ones stored from Transcribe. |

On the agent page each note quotes a line that is actually in the transcript. You can copy that line, and the play button speaks the matching time range. Notes are split into what worked and what needs work. The model is `gpt-4o-mini`. It reads the class as ASR chunks, not as one rewritten paragraph.

## How a class is stored

Every upload gets its own id. That id is the folder name in the `class-voices` bucket and the row id in SQLite.

```
{id}/{original-filename}    audio
{id}/transcript.json        diarized chunks
{id}/evaluation.json        teacher review, written once
```

Opening a class that already has `evaluation.json` does not call the model again. Deleting that object is what allows a new review.

Local copies of the transcript and the review are also written under `data/`. That folder, the audio files, and `.env` are gitignored.

## Requirements

- Python 3.10+
- Docker, for MinIO
- An AvalAI key

```bash
pip install -r requirements.txt
```

## MinIO

```bash
docker run -d --name asr-minio -p 9000:9000 -p 9001:9001 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data --console-address ":9001"
```

The console is http://127.0.0.1:9001. The API is `127.0.0.1:9000`. The server creates the `class-voices` bucket on first use.

Recreating the container drops the objects already stored in it. SQLite rows from before that will point at missing files.

## Configuration

Create `.env` in the project root. Do not commit it.

```
aval_ai=your-avalai-key
```

`AVALAI_API_KEY` is accepted as well. Optional overrides:

| Variable | Default |
| --- | --- |
| `AVALAI_BASE` | `https://api.avalai.ir/v1` |
| `MINIO_ENDPOINT` | `127.0.0.1:9000` |
| `MINIO_ACCESS_KEY` | `minioadmin` |
| `MINIO_SECRET_KEY` | `minioadmin` |
| `MINIO_BUCKET` | `class-voices` |
| `MINIO_SECURE` | `false` |

Transcription uses `gpt-4o-transcribe-diarize` with `diarized_json` and automatic chunking. The teacher review uses `gpt-4o-mini`.

## Run

```bash
python -m uvicorn server.main:app --host 127.0.0.1 --port 8765
```

Open http://127.0.0.1:8765

Use that address. Opening the HTML files directly makes the API calls miss the server.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Server and MinIO status |
| `GET` | `/api/sessions` | Parsed classes, newest first |
| `POST` | `/api/sessions` | Upload audio and start transcription |
| `GET` | `/api/sessions/{id}` | One class, including its chunks |
| `GET` | `/api/sessions/{id}/audio` | Audio, with HTTP range requests so a chunk can be seeked |
| `GET` | `/api/sessions/{id}/evaluation` | Saved review, or a new review when `{id}/evaluation.json` is missing |

`GET /api/sessions/{id}/evaluation` is the only route that calls the chat model, and only when that class folder has no review yet.
