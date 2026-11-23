import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveClaudeSpawnEnv } from "./driver.ts";

test("resolveClaudeSpawnEnv explicitly forwards process.env plus call-specific extras", () => {
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "process-env-token";

  try {
    const env = resolveClaudeSpawnEnv({ MINERVA_DRIVER: "spawn", CUSTOM_DRIVER_FLAG: "1" });

    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "process-env-token");
    assert.equal(env.MINERVA_DRIVER, "spawn");
    assert.equal(env.CUSTOM_DRIVER_FLAG, "1");
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    if (previousToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
    }
  }
});

test("resolveClaudeSpawnEnv falls back to ~/.zshrc when CLAUDE_CODE_OAUTH_TOKEN is absent from process.env", () => {
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "minerva-claude-env-test-"));
  const token = "zshrc-token-" + "x".repeat(96);

  try {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.HOME = home;
    writeFileSync(join(home, ".zshrc"), `# local Claude auth\nexport CLAUDE_CODE_OAUTH_TOKEN="${token}"\n`);

    const env = resolveClaudeSpawnEnv();

    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, token);
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
    }
  }
});

test("resolveClaudeSpawnEnv hands a child the facade-resolved token when neither process.env nor ~/.zshrc has one (PANT-1169)", async () => {
  const { primeClaudeCredential, resetClaudeCredentialCache } = await import("./claude-credential.ts");
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "minerva-claude-env-test-"));

  try {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.HOME = home; // no .zshrc here
    resetClaudeCredentialCache();
    assert.equal(resolveClaudeSpawnEnv().CLAUDE_CODE_OAUTH_TOKEN, undefined);

    await primeClaudeCredential(false, {
      env: { PANTHEON_API_URL: "http://core-api:3012", PANTHEON_SECRETS_SHARED_DIR: home },
      fetchImpl: async () => ({ ok: true, status: 200 }),
      readFile: async () => "CLAUDE_CODE_OAUTH_TOKEN=facade-token\n",
      deleteFile: async () => {},
    });

    assert.equal(resolveClaudeSpawnEnv().CLAUDE_CODE_OAUTH_TOKEN, "facade-token");
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the parent env stays untouched");
    assert.equal(resolveClaudeSpawnEnv({ CLAUDE_CODE_OAUTH_TOKEN: "explicit" }).CLAUDE_CODE_OAUTH_TOKEN, "explicit");
  } finally {
    resetClaudeCredentialCache();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
  }
});
