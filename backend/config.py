from __future__ import annotations

import os
from pathlib import Path


def _load_env():
    env = os.getenv("APP_ENV", "local")
    if env == "gcp":
        _load_from_secret_manager()
    else:
        from dotenv import load_dotenv
        load_dotenv()


def _load_from_secret_manager():
    from google.cloud import secretmanager
    client = secretmanager.SecretManagerServiceClient()
    project = os.environ["GCP_PROJECT_ID"]
    secrets = [
        "EMPOWER_EMAIL", "EMPOWER_PASSWORD",
        "ANTHROPIC_API_KEY",
    ]
    for name in secrets:
        try:
            secret_path = f"projects/{project}/secrets/{name}/versions/latest"
            response = client.access_secret_version(name=secret_path)
            os.environ[name] = response.payload.data.decode("utf-8").strip()
        except Exception as e:
            print(f"Warning: could not load secret {name}: {e}")


_load_env()


def data_dir() -> Path:
    """All persistent data lives here. Local: ~/.retirement-calculator/  GCP: DATA_DIR env var."""
    d = Path(os.getenv("DATA_DIR", Path.home() / ".retirement-calculator"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> str:
    return str(data_dir() / "retirement-calculator.db")


def session_path() -> Path:
    return data_dir() / "session.json"


def debug_dir() -> Path:
    d = data_dir() / "debug"
    d.mkdir(parents=True, exist_ok=True)
    return d



# Credentials
EMPOWER_EMAIL = os.getenv("EMPOWER_EMAIL", "")
EMPOWER_PASSWORD = os.getenv("EMPOWER_PASSWORD", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# Benchmark: parse "SPY:0.6,AGG:0.4" → {"SPY": 0.6, "AGG": 0.4}
_benchmark_raw = os.getenv("BENCHMARK_TICKERS", "SPY:0.6,AGG:0.4")
BENCHMARK_TICKERS: dict[str, float] = {
    part.split(":")[0]: float(part.split(":")[1])
    for part in _benchmark_raw.split(",")
    if ":" in part
}

IS_GCP = os.getenv("APP_ENV", "local") == "gcp"
