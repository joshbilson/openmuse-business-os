import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDownloadFailures } from "../src/downloads.ts";

test("a vanished download journal does not break listing completed downloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-outcomes-"));
  try {
    const folder = join(directory, "download-outcomes");
    await mkdir(folder);
    // readdir sees this entry, but readFile receives ENOENT, as when a PDF
    // finishes and removes its journal between the two filesystem operations.
    await symlink(join(folder, "already-published"), join(folder, "vanished.json"));
    await writeFile(
      join(folder, "failed.json"),
      JSON.stringify({
        id: "failed",
        name: "notes.txt",
        code: "UNSUPPORTED_DOWNLOAD",
        message: "Only PDF downloads can be imported.",
        createdAt: "2026-09-23T00:00:00.000Z",
        status: "failed",
      }),
    );
    assert.deepEqual(await readDownloadFailures(directory), [
      {
        id: "failed",
        name: "notes.txt",
        code: "UNSUPPORTED_DOWNLOAD",
        message: "Only PDF downloads can be imported.",
        createdAt: "2026-09-23T00:00:00.000Z",
      },
    ]);
    await writeFile(join(folder, "corrupt.json"), "{invalid");
    await assert.rejects(readDownloadFailures(directory), SyntaxError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
