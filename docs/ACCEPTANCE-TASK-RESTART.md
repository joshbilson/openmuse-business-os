# Durable task restart acceptance

Run `scripts/oracle/acceptance-task-restart.ps1` on Oracle without `-Execute` to check that the OpenMuse API and isolated Hermes services are healthy. After clearing a deployment restart window, run it with `-Execute`. Use a new `-IdempotencyKey` for each fresh test; the key stays fixed across that test's replay.

The script reads the current verified Square identity, creates one read-only operator task that calls `business_connections`, waits for its Hermes run ID to be saved, stops only the OpenMuse API, confirms Hermes is still listening and the run is alive, restarts the API, and replays the same task key. It passes only if the same task and Hermes run finish successfully, one Hermes acceptance event exists, the result contains that verified merchant ID, and both services remain healthy. It writes a token-free JSON receipt to the deployment's ignored `artifacts` directory.

The 23 September 2026 run passed. Hermes was `running` before and during the API outage and `completed` afterward. The task succeeded on its second worker attempt with the same Hermes run ID, one acceptance event, and one report artifact. The sanitized receipt is kept locally under ignored `artifacts/task-restart-*.json`.
