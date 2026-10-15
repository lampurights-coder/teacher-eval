"""Save a dropped recording in MinIO and store its diarized transcript JSON."""

import hashlib
import hmac
import json
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from minio import Minio
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui-template"
DATA = ROOT / "data"
JSON_DIR = DATA / "transcripts"
DB_PATH = DATA / "sessions.db"
ENV_PATH = ROOT / ".env"

DEFAULT_BASE = "https://api.avalai.ir/v1"
DEFAULT_ASR = "gpt-4o-transcribe-diarize"
DEFAULT_LLM = "gpt-4o-mini"
ADMIN_COOKIE = "asr_admin"
ADMIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 14

DATA.mkdir(exist_ok=True)
JSON_DIR.mkdir(exist_ok=True)


def load_env():
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()

AVAL_BASE = os.environ.get("AVALAI_BASE", DEFAULT_BASE).rstrip("/")
AVAL_KEY = os.environ.get("AVALAI_API_KEY") or os.environ.get("aval_ai", "")
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ADMIN_SECRET = os.environ.get("ADMIN_SECRET") or hashlib.sha256(
    f"asrparser|{ADMIN_USERNAME}|{ADMIN_PASSWORD}|{AVAL_KEY}".encode()
).hexdigest()
MINIO_ENDPOINT = os.environ.get("MINIO_ENDPOINT", "127.0.0.1:9000")
MINIO_ACCESS = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET = os.environ.get("MINIO_SECRET_KEY", "minioadmin")
MINIO_BUCKET = os.environ.get("MINIO_BUCKET", "class-voices")
MINIO_SECURE = os.environ.get("MINIO_SECURE", "false").lower() == "true"

app = FastAPI(title="asrparser")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        r"https?://(localhost|127\.0\.0\.1)(:\d+)?"
        r"|capacitor://localhost"
        r"|ionic://localhost"
        r"|https?://192\.168\.\d{1,3}\.\d{1,3}(:\d+)?"
        r"|https?://10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?"
        r"|null"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def disable_page_cache(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css")):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    return response


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                object_key TEXT,
                json_key TEXT,
                content_type TEXT,
                duration REAL,
                status TEXT NOT NULL,
                stage TEXT,
                error TEXT,
                segments_json TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
        if "json_key" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN json_key TEXT")
        if "evaluation_key" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN evaluation_key TEXT")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                base_url TEXT NOT NULL,
                asr_model TEXT NOT NULL,
                llm_model TEXT NOT NULL,
                api_token TEXT NOT NULL
            )
            """
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(settings)")}
        if "admin_username" not in columns:
            conn.execute("ALTER TABLE settings ADD COLUMN admin_username TEXT")
        if "admin_password_hash" not in columns:
            conn.execute("ALTER TABLE settings ADD COLUMN admin_password_hash TEXT")
        row = conn.execute("SELECT id FROM settings WHERE id = 1").fetchone()
        if not row:
            conn.execute(
                """
                INSERT INTO settings (
                    id, base_url, asr_model, llm_model, api_token,
                    admin_username, admin_password_hash
                )
                VALUES (1, ?, ?, ?, ?, NULL, NULL)
                """,
                (AVAL_BASE, DEFAULT_ASR, DEFAULT_LLM, AVAL_KEY),
            )


def hash_password(username: str, password: str) -> str:
    raw = f"{ADMIN_SECRET}|{(username or '').strip().lower()}|{password or ''}"
    return hashlib.sha256(raw.encode()).hexdigest()


init_db()


def read_admin_auth():
    with connect() as conn:
        row = conn.execute(
            "SELECT admin_username, admin_password_hash FROM settings WHERE id = 1"
        ).fetchone()
    if not row:
        return {"username": "", "password_hash": ""}
    return {
        "username": (row["admin_username"] or "").strip(),
        "password_hash": (row["admin_password_hash"] or "").strip(),
    }


def save_admin_auth(username: str, password: str):
    user = username.strip()
    digest = hash_password(user, password)
    with connect() as conn:
        conn.execute(
            """
            UPDATE settings
            SET admin_username = ?, admin_password_hash = ?
            WHERE id = 1
            """,
            (user, digest),
        )


def sign_admin_token(payload: str) -> str:
    stamp = str(int(time.time()))
    body = f"{payload}.{stamp}"
    digest = hmac.new(ADMIN_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{digest}"


def verify_admin_token(token: str) -> bool:
    try:
        payload, stamp, digest = token.rsplit(".", 2)
    except ValueError:
        return False
    body = f"{payload}.{stamp}"
    expected = hmac.new(ADMIN_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(digest, expected):
        return False
    try:
        issued = int(stamp)
    except ValueError:
        return False
    if abs(time.time() - issued) > ADMIN_COOKIE_MAX_AGE:
        return False
    return payload == "ok"


def require_admin(request: Request):
    token = request.cookies.get(ADMIN_COOKIE)
    if not token or not verify_admin_token(token):
        raise HTTPException(401, "Admin login required")


def read_settings_row():
    with connect() as conn:
        row = conn.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    if not row:
        return {
            "base_url": AVAL_BASE,
            "asr_model": DEFAULT_ASR,
            "llm_model": DEFAULT_LLM,
            "api_token": AVAL_KEY,
        }
    return {
        "base_url": row["base_url"],
        "asr_model": row["asr_model"],
        "llm_model": row["llm_model"],
        "api_token": row["api_token"] or "",
    }


def token_hint(token: str) -> str:
    raw = (token or "").strip()
    if not raw:
        return ""
    if len(raw) <= 4:
        return "••••"
    return f"••••{raw[-4:]}"


def public_settings(row):
    token = row.get("api_token") or ""
    return {
        "base_url": row["base_url"],
        "asr_model": row["asr_model"],
        "llm_model": row["llm_model"],
        "has_token": bool(token.strip()),
        "token_hint": token_hint(token),
    }


class LoginBody(BaseModel):
    username: str = ""
    password: str = ""


class SettingsBody(BaseModel):
    base_url: str = Field(default=DEFAULT_BASE)
    asr_model: str = Field(default=DEFAULT_ASR)
    llm_model: str = Field(default=DEFAULT_LLM)
    api_token: Optional[str] = None


def minio_client():
    return Minio(MINIO_ENDPOINT, access_key=MINIO_ACCESS, secret_key=MINIO_SECRET, secure=MINIO_SECURE)


def ensure_bucket():
    client = minio_client()
    if not client.bucket_exists(MINIO_BUCKET):
        client.make_bucket(MINIO_BUCKET)
    return client


def update_session(session_id, **fields):
    keys = list(fields)
    sets = ", ".join(f"{key} = ?" for key in keys)
    with connect() as conn:
        conn.execute(
            f"UPDATE sessions SET {sets} WHERE id = ?",
            [fields[key] for key in keys] + [session_id],
        )


def row_to_session(row):
    segments = json.loads(row["segments_json"] or "[]")
    letters = []
    for segment in segments:
        if segment["speaker"] not in letters:
            letters.append(segment["speaker"])
    return {
        "id": row["id"],
        "filename": row["filename"],
        "duration": row["duration"],
        "status": row["status"],
        "stage": row["stage"],
        "error": row["error"],
        "segments": segments,
        "speakers": letters,
        "object_key": row["object_key"],
        "json_key": row["json_key"],
        "evaluation_key": row["evaluation_key"] if "evaluation_key" in row.keys() else None,
        "audio_url": f"/api/sessions/{row['id']}/audio" if row["object_key"] else None,
        "created_at": row["created_at"],
    }


def transcribe(path: Path, filename: str, content_type: str):
    settings = read_settings_row()
    token = (settings.get("api_token") or "").strip()
    base = (settings.get("base_url") or DEFAULT_BASE).rstrip("/")
    model = (settings.get("asr_model") or DEFAULT_ASR).strip() or DEFAULT_ASR
    if not token:
        raise RuntimeError("AvalAI API key is missing. Set it in admin settings or .env")
    with path.open("rb") as handle:
        response = httpx.post(
            f"{base}/audio/transcriptions",
            headers={"Authorization": f"Bearer {token}"},
            files={"file": (filename, handle, content_type or "application/octet-stream")},
            data={
                "model": model,
                "response_format": "diarized_json",
                "chunking_strategy": "auto",
            },
            timeout=httpx.Timeout(300.0, connect=30.0),
        )
    if response.status_code >= 400:
        raise RuntimeError(response.text[:800])
    return response.json()


def process_session(session_id: str, temp_path: str, filename: str, content_type: str):
    path = Path(temp_path)
    try:
        update_session(session_id, status="processing", stage="Storing the voice", error=None)
        client = ensure_bucket()
        object_key = f"{session_id}/{filename}"
        client.fput_object(
            MINIO_BUCKET,
            object_key,
            str(path),
            content_type=content_type or "application/octet-stream",
        )
        update_session(session_id, object_key=object_key, stage="Separating the voices")
        payload = transcribe(path, filename, content_type)
        segments = []
        for item in payload.get("segments") or []:
            text = " ".join(str(item.get("text") or "").split())
            if not text:
                continue
            segments.append(
                {
                    "id": f"s{len(segments)}",
                    "speaker": str(item.get("speaker") or "A"),
                    "start": float(item.get("start") or 0),
                    "end": float(item.get("end") or 0),
                    "text": text,
                }
            )
        document = {
            "id": session_id,
            "filename": filename,
            "duration": payload.get("duration"),
            "text": payload.get("text") or "",
            "segments": segments,
        }
        local_json = JSON_DIR / f"{session_id}.json"
        local_json.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
        json_key = f"{session_id}/transcript.json"
        client.fput_object(MINIO_BUCKET, json_key, str(local_json), content_type="application/json")
        update_session(
            session_id,
            json_key=json_key,
            duration=payload.get("duration"),
            segments_json=json.dumps(segments),
            status="parsed",
            stage="Saved",
        )
    except Exception as exc:
        update_session(session_id, status="error", stage="Could not save", error=str(exc)[:800])
    finally:
        path.unlink(missing_ok=True)


@app.get("/api/health")
def health():
    try:
        ensure_bucket()
        storage = True
    except Exception:
        storage = False
    return {"ok": True, "storage": storage}


@app.get("/api/admin/status")
def admin_status():
    auth = read_admin_auth()
    ready = bool(auth["username"] and auth["password_hash"])
    return {"setup_done": ready}


@app.post("/api/admin/login")
def admin_login(body: LoginBody):
    username = (body.username or "").strip()
    password = body.password or ""
    if not username or not password:
        raise HTTPException(400, "Enter a username and password")
    auth = read_admin_auth()
    created = False
    if not auth["username"] or not auth["password_hash"]:
        save_admin_auth(username, password)
        created = True
        saved_user = username
    else:
        user_ok = hmac.compare_digest(username.lower(), auth["username"].lower())
        pass_ok = hmac.compare_digest(hash_password(auth["username"], password), auth["password_hash"])
        if not (user_ok and pass_ok):
            raise HTTPException(401, "Wrong username or password")
        saved_user = auth["username"]
    response = JSONResponse({"ok": True, "created": created, "username": saved_user})
    response.set_cookie(
        key=ADMIN_COOKIE,
        value=sign_admin_token("ok"),
        httponly=True,
        samesite="lax",
        max_age=ADMIN_COOKIE_MAX_AGE,
        path="/",
    )
    return response


@app.post("/api/admin/logout")
def admin_logout():
    response = JSONResponse({"ok": True})
    response.delete_cookie(ADMIN_COOKIE, path="/")
    return response


@app.get("/api/admin/settings")
def get_admin_settings(request: Request):
    require_admin(request)
    return public_settings(read_settings_row())


@app.put("/api/admin/settings")
def put_admin_settings(request: Request, body: SettingsBody):
    require_admin(request)
    current = read_settings_row()
    base_url = (body.base_url or DEFAULT_BASE).strip().rstrip("/") or DEFAULT_BASE
    asr_model = (body.asr_model or DEFAULT_ASR).strip() or DEFAULT_ASR
    llm_model = (body.llm_model or DEFAULT_LLM).strip() or DEFAULT_LLM
    if body.api_token is None or not str(body.api_token).strip():
        api_token = current.get("api_token") or ""
    else:
        api_token = str(body.api_token).strip()
    with connect() as conn:
        conn.execute(
            """
            UPDATE settings
            SET base_url = ?, asr_model = ?, llm_model = ?, api_token = ?
            WHERE id = 1
            """,
            (base_url, asr_model, llm_model, api_token),
        )
    return public_settings(read_settings_row())


@app.get("/api/admin/models")
def list_avalai_models(request: Request, base_url: Optional[str] = None, api_token: Optional[str] = None):
    """List model ids from AvalAI (OpenAI-compatible /models), same catalog as the platform UI."""
    require_admin(request)
    current = read_settings_row()
    token = (api_token or "").strip() or (current.get("api_token") or "").strip()
    base = ((base_url or "").strip() or current.get("base_url") or DEFAULT_BASE).rstrip("/")
    if not token:
        raise HTTPException(400, "Save an AvalAI token first")
    try:
        response = httpx.get(
            f"{base}/models",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
    except Exception as exc:
        raise HTTPException(502, f"Could not reach AvalAI models: {exc}") from exc
    if response.status_code >= 400:
        raise HTTPException(response.status_code, response.text[:400] or "AvalAI models request failed")
    payload = response.json()
    rows = payload.get("data") if isinstance(payload, dict) else payload
    models = []
    if isinstance(rows, list):
        for item in rows:
            if isinstance(item, dict) and item.get("id"):
                models.append(str(item["id"]))
            elif isinstance(item, str):
                models.append(item)
    models = sorted(set(models), key=str.lower)
    return {"models": models, "base_url": base}


@app.get("/api/sessions")
def list_sessions(request: Request):
    require_admin(request)
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM sessions WHERE status = 'parsed' ORDER BY created_at DESC"
        ).fetchall()
    return [row_to_session(row) for row in rows]


@app.get("/api/sessions/{session_id}/audio")
def session_audio(session_id: str, request: Request):
    require_admin(request)
    with connect() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not row or not row["object_key"]:
        raise HTTPException(404, "Audio not found")
    client = minio_client()
    stat = client.stat_object(MINIO_BUCKET, row["object_key"])
    size = stat.size
    media = row["content_type"] or "audio/mpeg"
    start = 0
    end = size - 1
    status = 200
    range_header = request.headers.get("range")
    if range_header and range_header.startswith("bytes="):
        spec = range_header.split("=", 1)[1].split(",")[0].strip()
        left, _, right = spec.partition("-")
        if left == "" and right:
            start = max(size - int(right), 0)
        else:
            start = int(left or 0)
            if right:
                end = int(right)
        end = min(end, size - 1)
        if start > end or start >= size:
            raise HTTPException(416, "Range not satisfiable")
        status = 206
    length = end - start + 1
    obj = client.get_object(MINIO_BUCKET, row["object_key"], offset=start, length=length)
    try:
        data = obj.read()
    finally:
        obj.close()
        obj.release_conn()
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(len(data)),
        "Content-Type": media,
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return Response(content=data, status_code=status, headers=headers, media_type=media)


def extract_json(text):
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw.split("```", 2)[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        raw = raw[start : end + 1]
    return json.loads(raw)


def chat_complete(messages):
    settings = read_settings_row()
    token = (settings.get("api_token") or "").strip()
    base = (settings.get("base_url") or DEFAULT_BASE).rstrip("/")
    model = (settings.get("llm_model") or DEFAULT_LLM).strip() or DEFAULT_LLM
    if not token:
        raise RuntimeError("AvalAI API key is missing. Set it in admin settings or .env")
    response = httpx.post(
        f"{base}/chat/completions",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"model": model, "temperature": 0.2, "messages": messages},
        timeout=120,
    )
    if response.status_code >= 400:
        raise RuntimeError(response.text[:800])
    return response.json()["choices"][0]["message"]["content"], model


def normalize_phrase(value):
    return " ".join(str(value or "").split()).lower()


def locate_phrase(phrase, segments, speaker=None):
    needle = normalize_phrase(phrase)
    if not needle:
        return None
    pool = [segment for segment in segments if not speaker or segment.get("speaker") == speaker]
    exact = [segment for segment in pool if normalize_phrase(segment.get("text")) == needle]
    if exact:
        return exact[0]
    hits = [segment for segment in pool if needle in normalize_phrase(segment.get("text"))]
    if not hits:
        return None
    return min(hits, key=lambda segment: len(normalize_phrase(segment.get("text"))))


EVAL_VERSION = 2


def keep_referenced(items, segments, speaker=None):
    kept = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        phrase = " ".join(str(item.get("phrase") or "").split())
        segment = locate_phrase(phrase, segments, speaker)
        if not segment:
            continue
        reason = " ".join(str(item.get("reason") or "").split())
        if not reason:
            continue
        kept.append(
            {
                "point": " ".join(str(item.get("point") or "").split()),
                "reason": reason,
                "phrase": phrase,
                "speaker": segment.get("speaker"),
                "start": segment.get("start"),
                "end": segment.get("end"),
            }
        )
    return kept[:5]


def build_evaluation(session_id, filename, segments):
    lines = "\n".join(
        f"[{index:03d} {segment['start']:.1f}-{segment['end']:.1f}] {segment['speaker']}: {segment['text']}"
        for index, segment in enumerate(segments)
    )
    content, model = chat_complete(
        [
            {
                "role": "system",
                "content": (
                    "You evaluate one English class from an automatic speech recognition transcript. "
                    "The transcript is already cut into ASR chunks. Each line is one chunk: index, start-end seconds, speaker, text. "
                    "ASR can split a sentence, drop a word, or mis-hear grammar. Judge the class from these chunks, one chunk at a time. "
                    "Do not invent speech and do not join chunks into a new sentence. "
                    "Decide which speaker is the teacher and which is the student. "
                    "The teacher is the person who says they teach, leads the questions, or explains their work. "
                    "Walk the class chunk by chunk. Score the teacher on grammar, clarity, questions, and how they keep the student talking. "
                    "Return JSON only: "
                    '{"teacher":{"speaker":"A","name":null},"student":{"speaker":"B","name":null},'
                    '"verdict":"good","summary":"",'
                    '"good":[{"point":"","reason":"","phrase":""}],'
                    '"bad":[{"point":"","reason":"","phrase":""}]} '
                    "verdict is good, mixed, or weak. "
                    "good is 4 chunks where the teacher helped the class. "
                    "bad is 3 chunks with a grammar slip, unclear speech, or a weak teaching move. "
                    "point is a short label. "
                    "reason is one sentence that explains why this exact chunk is good or bad in an English class. "
                    "phrase must be the full text of one teacher chunk, copied exactly. "
                    "Skip chunks that are only a greeting or a single word. "
                    "summary is two sentences and cannot be empty. Quote only the teacher."
                ),
            },
            {"role": "user", "content": lines or "No speech."},
        ]
    )
    parsed = extract_json(content)
    verdict = parsed.get("verdict") if parsed.get("verdict") in {"good", "mixed", "weak"} else "mixed"
    teacher = parsed.get("teacher") if isinstance(parsed.get("teacher"), dict) else {}
    student = parsed.get("student") if isinstance(parsed.get("student"), dict) else {}

    def person(info):
        name = info.get("name")
        if not isinstance(name, str) or name.strip().lower() in {"", "null", "none"}:
            name = None
        speaker = str(info.get("speaker") or "").strip() or None
        return {"speaker": speaker, "name": name.strip() if isinstance(name, str) else None}

    teacher_person = person(teacher)
    summary = " ".join(str(parsed.get("summary") or "").split())
    if not summary:
        summary = "The teacher runs this English class clearly and keeps the student talking."
    good = keep_referenced(parsed.get("good"), segments, teacher_person["speaker"])
    bad = keep_referenced(parsed.get("bad"), segments, teacher_person["speaker"])
    if len(bad) < 3:
        bad = fill_teacher_points("bad", teacher_person["speaker"], segments) or bad
    if len(good) < 3:
        good = fill_teacher_points("good", teacher_person["speaker"], segments) or good
    return {
        "version": EVAL_VERSION,
        "model": model,
        "id": session_id,
        "filename": filename,
        "teacher": teacher_person,
        "student": person(student),
        "verdict": verdict,
        "summary": summary,
        "good": good,
        "bad": bad,
    }


def fill_teacher_points(side, speaker, segments):
    lines = [segment.get("text") or "" for segment in segments if segment.get("speaker") == speaker and segment.get("text")]
    if not lines:
        return []
    focus = "chunks where the teacher helped the class" if side == "good" else "chunks with a grammar slip, unclear speech, or a weak teaching move"
    numbered = "\n".join(f"[{segment['start']:.1f}-{segment['end']:.1f}] {segment['text']}" for segment in segments if segment.get("speaker") == speaker and segment.get("text"))
    content, _model = chat_complete(
        [
            {
                "role": "system",
                "content": (
                    "These lines are ASR chunks from an English class. Each line is one chunk. "
                    f"Pick 3 {focus}. "
                    "phrase must be the full text of one chunk, copied exactly. "
                    "reason is one sentence explaining why that chunk matters. "
                    f'Return JSON only: {{"{side}":[{{"point":"","reason":"","phrase":""}}]}}'
                ),
            },
            {"role": "user", "content": numbered or "\n".join(lines)},
        ]
    )
    parsed = extract_json(content)
    return keep_referenced(parsed.get(side), segments, speaker)


def read_minio_json(object_key):
    client = minio_client()
    obj = client.get_object(MINIO_BUCKET, object_key)
    try:
        return json.loads(obj.read().decode("utf-8"))
    finally:
        obj.close()
        obj.release_conn()


def save_evaluation(session_id, document):
    folder = DATA / "evaluations"
    folder.mkdir(exist_ok=True)
    local_json = folder / f"{session_id}.json"
    local_json.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    key = f"{session_id}/evaluation.json"
    ensure_bucket().fput_object(MINIO_BUCKET, key, str(local_json), content_type="application/json")
    update_session(session_id, evaluation_key=key)
    return key


@app.get("/api/sessions/{session_id}/evaluation")
def session_evaluation(session_id: str, request: Request):
    require_admin(request)
    with connect() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Session not found")
    if row["status"] != "parsed":
        raise HTTPException(409, "This recording is not ready")
    key = f"{session_id}/evaluation.json"
    try:
        saved = read_minio_json(key)
        if isinstance(saved, dict) and (saved.get("good") or saved.get("bad") or saved.get("summary")):
            if row["evaluation_key"] != key:
                update_session(session_id, evaluation_key=key)
            saved["cached"] = True
            return saved
    except Exception:
        pass
    segments = json.loads(row["segments_json"] or "[]")
    document = build_evaluation(session_id, row["filename"], segments)
    save_evaluation(session_id, document)
    document["cached"] = False
    return document


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str, request: Request):
    require_admin(request)
    with connect() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Session not found")
    return row_to_session(row)


@app.post("/api/sessions")
async def create_session(request: Request, background: BackgroundTasks, file: UploadFile = File(...)):
    require_admin(request)
    if not file.filename:
        raise HTTPException(400, "Drop an audio file")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "The file is empty")
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(400, "File is larger than 25 MB")
    try:
        ensure_bucket()
    except Exception as exc:
        raise HTTPException(503, f"MinIO is not ready: {exc}") from exc

    session_id = uuid.uuid4().hex
    filename = Path(file.filename).name
    content_type = file.content_type or "application/octet-stream"
    temp_path = DATA / f"{session_id}-{filename}"
    temp_path.write_bytes(raw)
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO sessions (id, filename, content_type, status, stage, created_at)
            VALUES (?, ?, ?, 'processing', 'Storing the voice', ?)
            """,
            (session_id, filename, content_type, datetime.now(timezone.utc).isoformat()),
        )
    background.add_task(process_session, session_id, str(temp_path), filename, content_type)
    return {"id": session_id}


app.mount("/", StaticFiles(directory=UI, html=True), name="ui")
