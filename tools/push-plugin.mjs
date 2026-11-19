// ---------------------------------------------------------------------------
// ChatLogExporter 내보내기 — 판번호 올리고 · 공개열쇠 주입 · 문법 검사 · 서명 ·
// 내 BetterDiscord 폴더에 복사 · GitHub(main)에 올림.
//
//   node tools/push-plugin.mjs                뒷자리 +1 (2.6.0 → 2.6.1)
//   node tools/push-plugin.mjs --minor        가운데 +1 (2.6.1 → 2.7.0)
//   node tools/push-plugin.mjs --set 3.0.0    판번호 직접 지정
//   node tools/push-plugin.mjs --dry          무엇을 할지만 보고 아무것도 안 함
//   node tools/push-plugin.mjs --local        GitHub에 안 올리고 내 PC에만 반영
//
// ★ 판번호를 안 올리면 친구에게 안 퍼진다. 친구 플러그인은 자기보다 높은 판번호일
//   때만 받는다. 그래서 여기서 자동으로 올린다.
// ★ 판번호는 두 군데(@version 주석 / this.version 코드)에 있고 둘을 같이 맞춘다.
// ★ 비밀 열쇠(keys/)는 이 PC에만 둔다(gitignore). 서명이 의미 있으려면 공개돼선 안 됨.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const PLUGIN = join(ROOT, "ChatLogExporter.plugin.js");
const SIG_PATH = PLUGIN + ".sig";
const VERSION_JSON = join(ROOT, "version.json");

const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const val = (k) => {const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : null;};

const DRY = has("dry");
const LOCAL_ONLY = has("local");
const BD_FOLDER = join(process.env.APPDATA || "", "BetterDiscord", "plugins");

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`
};
function die(msg) {console.error("\n" + c.bad("✗ " + msg) + "\n"); process.exit(1);}

// ── 1. 읽기 ────────────────────────────────────────────────────────────────
if (!existsSync(PLUGIN)) die(`플러그인 파일이 없어: ${PLUGIN}`);
let text = readFileSync(PLUGIN, "utf8");

const headerRe = /(@version\s+)([0-9][0-9.]*)/;
const fieldRe = /(this\.version\s*=\s*")([0-9][0-9.]*)(")/;
const pubRe = /(const UPDATE_PUBLIC_KEY\s*=\s*")([^"]*)(")/;

const headerMatch = text.match(headerRe);
const fieldMatch = text.match(fieldRe);
if (!headerMatch) die("파일 맨 위 주석에서 @version 을 못 찾았어.");
if (!fieldMatch) die("코드에서 this.version 을 못 찾았어.");
if (!pubRe.test(text)) die("플러그인에서 UPDATE_PUBLIC_KEY 자리를 못 찾았어.");

const current = headerMatch[2];
if (fieldMatch[2] !== current) console.log(c.warn(`  ! 판번호 어긋남: 주석 ${current} / 코드 ${fieldMatch[2]} — 맞춰 올릴게.`));

// ── 2. 다음 판번호 ─────────────────────────────────────────────────────────
function bump(v) {
  const set = val("set");
  if (set) {if (!/^[0-9]+(\.[0-9]+)*$/.test(set)) die(`--set 값이 판번호 모양이 아니야: ${set}`); return set;}
  const p = v.split(".").map((n) => parseInt(n, 10) || 0);
  while (p.length < 3) p.push(0);
  if (has("minor")) {p[1] += 1; p[2] = 0;} else {p[2] += 1;}
  return p.join(".");
}
const next = bump(current);

// ── 2.5. 서명 열쇠 ─────────────────────────────────────────────────────────
const KEY_DIR = join(ROOT, "keys");
const PRIV_PATH = join(KEY_DIR, "chatlogexporter-sign.key");
function ensureKey() {
  if (existsSync(PRIV_PATH)) return createPrivateKey(readFileSync(PRIV_PATH, "utf8"));
  if (!existsSync(KEY_DIR)) mkdirSync(KEY_DIR, { recursive: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(PRIV_PATH, privateKey.export({ type: "pkcs8", format: "pem" }), "utf8");
  console.log("\n" + c.warn("  ! 서명 열쇠를 새로 만들었어:"));
  console.log("    " + PRIV_PATH);
  console.log(c.dim("    남에게 주지 말고 어딘가 백업해둬. 잃어버리면 친구가 파일을 한 번 손으로 받으면 복구돼."));
  return privateKey;
}
const privKey = ensureKey();
const pubB64 = createPublicKey(privKey).export({ type: "spki", format: "der" }).toString("base64");

console.log("");
console.log(`  플러그인   ${c.dim(PLUGIN)}`);
console.log(`  판번호     ${current}  →  ${c.ok(next)}`);
console.log(`  대상       ${LOCAL_ONLY ? c.dim("(GitHub 안 올림 — --local)") : "GitHub main"}`);
console.log(`  내 디스코드 ${existsSync(BD_FOLDER) ? BD_FOLDER : c.warn("BetterDiscord 폴더 못 찾음")}`);

// ── 3. 판번호·공개열쇠 반영하고 문법 검사 ──────────────────────────────────
const updated = text
  .replace(headerRe, `$1${next}`)
  .replace(fieldRe, `$1${next}$3`)
  .replace(pubRe, `$1${pubB64}$3`);

const probe = join(tmpdir(), `ChatLogExporter.check.${process.pid}.js`);
writeFileSync(probe, updated, "utf8");
const check = spawnSync(process.execPath, ["--check", probe], { encoding: "utf8" });
if (check.status !== 0) {console.error("\n" + (check.stderr || "").trim()); die("문법이 깨져 있어. 고치기 전에는 아무 데도 안 올린다.");}
console.log(`  문법       ${c.ok("통과")}`);

if (DRY) {console.log("\n" + c.warn("  --dry 라서 여기까지. 아무것도 안 바꿨어.") + "\n"); process.exit(0);}

// ── 4. 저장 + 서명 ─────────────────────────────────────────────────────────
writeFileSync(PLUGIN, updated, "utf8");
console.log(`  저장       ${c.ok("완료")}`);

// 서명은 언제나 마지막. 판번호/열쇠가 한 글자만 달라도 서명이 안 맞는다.
const signature = cryptoSign(null, Buffer.from(updated, "utf8"), privKey).toString("base64");
writeFileSync(SIG_PATH, signature + "\n", "utf8");
writeFileSync(VERSION_JSON, JSON.stringify({ version: next, sig: signature, updated_at: new Date().toISOString() }, null, 2) + "\n", "utf8");
console.log(`  서명       ${c.ok("찍음")} ${c.dim("(" + signature.slice(0, 16) + "…)")}`);

// ── 5. 내 BetterDiscord 폴더에 복사 ────────────────────────────────────────
if (existsSync(BD_FOLDER)) {
  copyFileSync(PLUGIN, join(BD_FOLDER, "ChatLogExporter.plugin.js"));
  console.log(`  내 PC      ${c.ok("복사 완료")} ${c.dim("(BetterDiscord가 알아서 다시 읽음)")}`);
} else {
  console.log(`  내 PC      ${c.warn("건너뜀 — BetterDiscord 폴더 없음")}`);
}

// ── 6. GitHub(main)에 올리기 ───────────────────────────────────────────────
if (!LOCAL_ONLY) {
  const git = (args) => spawnSync("git", args, { cwd: ROOT, stdio: "inherit", shell: false });
  const add = git(["add", "-A"]);
  if (add.status !== 0) die("git add 실패.");
  const commit = spawnSync("git", ["commit", "-m", `release v${next}`], { cwd: ROOT, encoding: "utf8" });
  if (commit.status !== 0 && !/nothing to commit/i.test((commit.stdout || "") + (commit.stderr || ""))) {
    console.error(commit.stdout, commit.stderr); die("git commit 실패.");
  }
  // 한 번 끊겼다고 포기하지 않는다 — 잠깐 쉬었다 다시.
  let pushed = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const push = git(["push", "origin", "HEAD:main"]);
    if (push.status === 0) {pushed = true; break;}
    if (attempt < 3) {console.log(c.warn(`  ! push 실패. ${attempt * 3}초 쉬었다 다시 (${attempt}/3)`)); spawnSync(process.execPath, ["-e", `setTimeout(()=>{}, ${attempt * 3000})`]);}
  }
  if (!pushed) {console.log(c.bad("  ✗ GitHub push 실패.")); console.log(c.dim("    gh auth status 로 로그인 확인하고, 직접:  git -C \"" + ROOT + "\" push origin HEAD:main")); process.exit(1);}
  console.log(`  GitHub     ${c.ok("올림 완료")}`);
}

console.log("\n" + c.ok(`  ✓ v${next} 나갔어.`) + "\n");
