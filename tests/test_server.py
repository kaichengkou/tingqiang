import io
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from server import app as module

# Appends to a file until stopped, so a test can tell whether the real interpreter is still alive.
HEARTBEAT = "import sys, time\nwhile True:\n    with open(sys.argv[1], 'a') as beat:\n        beat.write('.')\n    time.sleep(0.05)"


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.paths = patch.object(module, "DATA", Path(self.directory.name))
        self.paths.start()
        self.jobs = patch.object(module, "JOBS", {})
        self.jobs.start()
        self.client = TestClient(module.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.jobs.stop()
        self.paths.stop()
        self.directory.cleanup()

    def test_frontend_and_health(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/api/health").json()["app"], "tingqiang")
        self.assertEqual(self.client.get("/.runtime/input").status_code, 404)

    def test_disallowed_origin_is_rejected(self):
        response = self.client.get("/api/health", headers={"origin": "https://unrelated.invalid"})
        self.assertEqual(response.status_code, 403)

    def test_missing_model_returns_actionable_error(self):
        with patch.object(module, "separator_available", return_value=False):
            response = self.client.post("/api/jobs", files={"file": ("test.wav", b"wave", "audio/wav")})
        self.assertEqual(response.status_code, 503)
        self.assertIn("Demucs", response.json()["detail"])

    def test_empty_upload_is_removed(self):
        with patch.object(module, "separator_available", return_value=True):
            response = self.client.post("/api/jobs", files={"file": ("test.wav", b"", "audio/wav")})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_invalid_audio_fails_without_creating_output(self):
        with patch.object(module, "separator_available", return_value=True):
            response = self.client.post("/api/jobs", files={"file": ("../../outside.wav", b"not audio", "audio/wav")})
        self.assertEqual(response.status_code, 202)
        job_id = response.json()["id"]
        for _ in range(100):
            result = self.client.get(f"/api/jobs/{job_id}").json()
            if result["status"] == "failed":
                break
            time.sleep(0.02)
        self.assertEqual(result["status"], "failed")
        self.assertIn("解码", result["message"])
        self.assertEqual(self.client.get(f"/api/jobs/{job_id}/vocals.wav").status_code, 409)
        self.assertFalse((Path(self.directory.name).parent / "outside.wav").exists())

    def test_cancelled_queued_job_deletes_audio(self):
        with patch.object(module, "separator_available", return_value=True), patch.object(module.POOL, "submit"):
            response = self.client.post("/api/jobs", files={"file": ("test.wav", io.BytesIO(b"wave"), "audio/wav")})
        job_id = response.json()["id"]
        self.assertEqual(self.client.delete(f"/api/jobs/{job_id}").json()["status"], "cancelled")
        self.assertFalse((Path(self.directory.name) / job_id).exists())
        self.assertEqual(self.client.get("/api/jobs/not-a-real-id").status_code, 404)
        self.assertEqual(self.client.get(f"/api/jobs/{job_id}/other.wav").status_code, 404)

    def start_command(self, timeout=60):
        job = module.Job("0" * 32, Path(self.directory.name) / "job")
        job.directory.mkdir()
        beat, errors = job.directory / "beat", []

        def run():
            try:
                module.run_command(job, [sys.executable, "-c", HEARTBEAT, str(beat)], timeout=timeout)
            except Exception as error:
                errors.append(error)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        for _ in range(500):
            if beat.exists():
                break
            time.sleep(0.02)
        self.assertTrue(beat.exists(), "the command did not start")
        return job, beat, thread, errors

    def assert_stopped(self, beat):
        time.sleep(0.3)
        size = beat.stat().st_size
        time.sleep(0.5)
        self.assertEqual(beat.stat().st_size, size, "the command kept running")

    def test_cancel_stops_a_running_command(self):
        job, beat, thread, errors = self.start_command()
        module.stop_job(job)
        thread.join(15)
        self.assertFalse(thread.is_alive())
        self.assertIsInstance(errors[0], InterruptedError)
        self.assert_stopped(beat)

    def test_timeout_stops_a_running_command(self):
        _, beat, thread, errors = self.start_command(timeout=1)
        thread.join(20)
        self.assertFalse(thread.is_alive())
        self.assertIn("超时", str(errors[0]))
        self.assert_stopped(beat)


if __name__ == "__main__":
    unittest.main()
