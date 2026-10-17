import os

from dotenv import load_dotenv

# Load backend/.env before reading any setting. This has to happen in this
# module rather than app.py, because the values below are read at import time
# and app.py imports config before it calls load_dotenv().
load_dotenv()

MODEL_API_URL = os.getenv("MODEL_API_URL", "http://127.0.0.1:5001").rstrip("/")
CLASSIFICATION_API_URL = os.getenv("CLASSIFICATION_API_URL", MODEL_API_URL).rstrip("/")
SEGMENTATION_API_URL = os.getenv("SEGMENTATION_API_URL", MODEL_API_URL).rstrip("/")

CLASSIFICATION_TIMEOUT_SEC = float(os.getenv("CLASSIFICATION_TIMEOUT_SEC", "600"))
SEGMENTATION_TIMEOUT_SEC = float(os.getenv("SEGMENTATION_TIMEOUT_SEC", "600"))

MODEL_API_RETRIES = int(os.getenv("MODEL_API_RETRIES", "2"))
MODEL_API_RETRY_BACKOFF_SEC = float(os.getenv("MODEL_API_RETRY_BACKOFF_SEC", "0.8"))
